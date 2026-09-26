/**
 * @spfn/auth - Per-role email-domain policy
 *
 * `SPFN_AUTH_ROLE_EMAIL_DOMAINS` restricts which accounts may hold a role by the
 * domain of their email address:
 *
 * ```
 * SPFN_AUTH_ROLE_EMAIL_DOMAINS="admin=example.com;support=example.com,partner.example"
 * ```
 *
 * A role absent from the map is unrestricted, and an unset or empty value is no
 * policy at all. A restricted role is held only by an account whose email is
 * verified and whose domain — the part after the last `@`, lowercased and
 * IDNA-normalised — is listed for it exactly: `example.com` does not admit
 * `sub.example.com`.
 *
 * The value is read through the validated env on every call and parsed again
 * only when it differs from the last value parsed, so a request pays one string
 * comparison and a test that changes the variable sees the change on its next
 * call with nothing to reset. Nothing is stored in the database: every instance
 * applies its own configuration.
 */

import { domainToASCII } from 'node:url';

import { env } from '@spfn/auth/config';
import { RoleEmailDomainNotAllowedError } from '@spfn/auth/errors';

export const ROLE_EMAIL_DOMAINS_VAR = 'SPFN_AUTH_ROLE_EMAIL_DOMAINS';

/** Role name → the ASCII domains allowed to hold it. */
export type RoleEmailDomainPolicy = ReadonlyMap<string, ReadonlySet<string>>;

/** Why an account fails the rule for a restricted role. */
export type RoleEmailDomainViolationReason = 'domain' | 'unverified' | 'no_email';

/** The two columns of an account the rule reads. */
export interface RoleEmailDomainSubject
{
    email: string | null;
    emailVerifiedAt: Date | null;
}

let parsed: { raw: string; policy: RoleEmailDomainPolicy } | null = null;

/** Lowercased and IDNA-normalised; empty when `domainToASCII` rejects the value. */
function toAsciiDomain(raw: string): string
{
    return domainToASCII(raw.trim().toLowerCase());
}

function malformed(entry: string, problem: string): Error
{
    return new Error(
        `${ROLE_EMAIL_DOMAINS_VAR} is malformed at entry '${entry}': ${problem}. `
        + "Expected 'role=domain[,domain]' entries separated by ';'.",
    );
}

function parseDomain(raw: string, entry: string): string
{
    const domain = toAsciiDomain(raw);

    if (domain === '')
    {
        throw malformed(entry, `'${raw.trim()}' is not a domain`);
    }

    return domain;
}

function parseEntry(entry: string): [string, string[]]
{
    const separator = entry.indexOf('=');
    const roleName = entry.slice(0, separator).trim();

    if (separator < 0 || roleName === '')
    {
        throw malformed(entry, separator < 0 ? "missing '='" : 'empty role name');
    }

    return [roleName, entry.slice(separator + 1).split(',').map(domain => parseDomain(domain, entry))];
}

/**
 * Parse a policy value. Empty entries (a trailing `;`) are ignored; a role named
 * twice is allowed the union of its domains.
 *
 * @throws Error naming the variable and the offending entry when the value is malformed
 */
export function parseRoleEmailDomains(raw: string): RoleEmailDomainPolicy
{
    const policy = new Map<string, Set<string>>();

    for (const entry of raw.split(';').map(part => part.trim()).filter(Boolean))
    {
        const [roleName, domains] = parseEntry(entry);
        policy.set(roleName, new Set([...(policy.get(roleName) ?? []), ...domains]));
    }

    return policy;
}

/**
 * The policy in force for this call.
 *
 * @throws Error when the configured value is malformed — boot refuses on it first
 */
export function getRoleEmailDomainPolicy(): RoleEmailDomainPolicy
{
    const raw = env.SPFN_AUTH_ROLE_EMAIL_DOMAINS?.trim() ?? '';

    if (parsed?.raw !== raw)
    {
        parsed = { raw, policy: parseRoleEmailDomains(raw) };
    }

    return parsed.policy;
}

/** The domain of an address as the policy compares it; empty when there is no `@`. */
export function emailDomainOf(email: string): string
{
    const at = email.lastIndexOf('@');

    return at < 0 ? '' : toAsciiDomain(email.slice(at + 1));
}

/**
 * Why `subject` may not hold `roleName`, or null when it may.
 *
 * The one implementation of the rule: grant paths, check-time resolution, boot
 * checks and the violation report all come here.
 */
export function roleEmailDomainViolation(
    subject: RoleEmailDomainSubject,
    roleName: string,
): RoleEmailDomainViolationReason | null
{
    const domains = getRoleEmailDomainPolicy().get(roleName);

    if (domains === undefined)
    {
        return null;
    }

    if (!subject.email)
    {
        return 'no_email';
    }

    if (!domains.has(emailDomainOf(subject.email)))
    {
        return 'domain';
    }

    return subject.emailVerifiedAt ? null : 'unverified';
}

/** True when the role is unrestricted, or the account satisfies its restriction. */
export function isEmailAllowedForRole(subject: RoleEmailDomainSubject, roleName: string): boolean
{
    return roleEmailDomainViolation(subject, roleName) === null;
}

/**
 * Refuse a grant of `roleName` to `subject`.
 *
 * `requireVerified: false` is for a pending grant — an invitation — whose
 * address is proven only when the invitation is accepted.
 *
 * @throws RoleEmailDomainNotAllowedError (403) naming the role and the reason, never the address
 */
export function assertEmailAllowedForRole(
    subject: RoleEmailDomainSubject,
    roleName: string,
    { requireVerified = true }: { requireVerified?: boolean } = {},
): void
{
    const reason = roleEmailDomainViolation(subject, roleName);

    if (reason !== null && (requireVerified || reason !== 'unverified'))
    {
        throw new RoleEmailDomainNotAllowedError({ roleName, reason });
    }
}
