/**
 * @spfn/auth - Per-role email-domain policy: parsing and the rule (#106)
 *
 * The pure half of the policy, without a database: how the env value parses,
 * how an address is compared, and that the value is re-read per call so a
 * test — or an operator — changing it needs no reset.
 *
 * The last block is a source scan: no middleware may load a principal's role
 * except through `findUserWithEffectiveRole`, so a middleware added later
 * cannot skip the policy by calling the repository itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    emailDomainOf,
    getRoleEmailDomainPolicy,
    isEmailAllowedForRole,
    parseRoleEmailDomains,
    roleEmailDomainViolation,
    assertEmailAllowedForRole,
} from '@/server/lib/role-email-domains';
import { RoleEmailDomainNotAllowedError } from '@spfn/auth/errors';

const POLICY_VAR = 'SPFN_AUTH_ROLE_EMAIL_DOMAINS';
const VERIFIED = new Date();

afterEach(() =>
{
    delete process.env[POLICY_VAR];
});

describe('parseRoleEmailDomains', () =>
{
    it('parses roles and domains, trimming, lowercasing and IDNA-normalising', () =>
    {
        const policy = parseRoleEmailDomains(' admin = Example.COM ; support=example.com, Bücher.example ;');

        expect([...policy.keys()]).toEqual(['admin', 'support']);
        expect([...policy.get('admin')!]).toEqual(['example.com']);
        expect([...policy.get('support')!]).toEqual(['example.com', 'xn--bcher-kva.example']);
    });

    it('is empty for an empty value', () =>
    {
        expect(parseRoleEmailDomains('').size).toBe(0);
    });

    it.each([
        ['missing =', 'admin'],
        ['empty role name', '=example.com'],
        ['empty domain', 'admin='],
        ['empty domain in a list', 'admin=example.com,'],
        ['a domain domainToASCII rejects', 'admin=exa mple.com'],
    ])('#24 refuses %s, naming the variable and the entry', (_, value) =>
    {
        expect(() => parseRoleEmailDomains(value)).toThrow(`${POLICY_VAR} is malformed at entry '${value}'`);
    });
});

describe('the rule', () =>
{
    it('leaves every role unrestricted when unset', () =>
    {
        expect(isEmailAllowedForRole({ email: null, emailVerifiedAt: null }, 'admin')).toBe(true);
    });

    it('leaves a role absent from the map unrestricted', () =>
    {
        process.env[POLICY_VAR] = 'admin=example.com';

        expect(isEmailAllowedForRole({ email: 'member@gmail.test', emailVerifiedAt: null }, 'support')).toBe(true);
    });

    it('names the reason for a restricted role', () =>
    {
        process.env[POLICY_VAR] = 'admin=example.com';

        expect(roleEmailDomainViolation({ email: 'staff@example.com', emailVerifiedAt: VERIFIED }, 'admin')).toBeNull();
        expect(roleEmailDomainViolation({ email: null, emailVerifiedAt: VERIFIED }, 'admin')).toBe('no_email');
        expect(roleEmailDomainViolation({ email: 'staff@gmail.test', emailVerifiedAt: VERIFIED }, 'admin')).toBe('domain');
        expect(roleEmailDomainViolation({ email: 'staff@example.com', emailVerifiedAt: null }, 'admin')).toBe('unverified');
    });

    it('#8 compares exactly: a subdomain is not admitted, case is not significant', () =>
    {
        process.env[POLICY_VAR] = 'admin=example.com';

        expect(isEmailAllowedForRole({ email: 'staff@Sub.Example.COM', emailVerifiedAt: VERIFIED }, 'admin')).toBe(false);
        expect(isEmailAllowedForRole({ email: 'staff@EXAMPLE.com', emailVerifiedAt: VERIFIED }, 'admin')).toBe(true);
    });

    it('#9 compares IDNA-normalised in both directions', () =>
    {
        process.env[POLICY_VAR] = 'admin=bücher.example;support=xn--bcher-kva.example';

        expect(isEmailAllowedForRole({ email: 'staff@xn--bcher-kva.example', emailVerifiedAt: VERIFIED }, 'admin')).toBe(true);
        expect(isEmailAllowedForRole({ email: 'staff@Bücher.example', emailVerifiedAt: VERIFIED }, 'support')).toBe(true);
    });

    it('takes the domain after the last @', () =>
    {
        expect(emailDomainOf('"a@gmail.test"@example.com')).toBe('example.com');
        expect(emailDomainOf('no-at-sign')).toBe('');
    });

    it('re-reads the variable per call, so changing it needs no reset', () =>
    {
        process.env[POLICY_VAR] = 'admin=example.com';
        expect(getRoleEmailDomainPolicy().has('admin')).toBe(true);

        process.env[POLICY_VAR] = 'support=example.com';
        expect(getRoleEmailDomainPolicy().has('admin')).toBe(false);

        delete process.env[POLICY_VAR];
        expect(getRoleEmailDomainPolicy().size).toBe(0);
    });

    it('refuses a grant with a 403 that carries the role and reason, never the address', () =>
    {
        process.env[POLICY_VAR] = 'admin=example.com';

        let refusal: unknown;
        try
        {
            assertEmailAllowedForRole({ email: 'staff@gmail.test', emailVerifiedAt: VERIFIED }, 'admin');
        }
        catch (error)
        {
            refusal = error;
        }

        expect(refusal).toBeInstanceOf(RoleEmailDomainNotAllowedError);
        expect((refusal as RoleEmailDomainNotAllowedError).statusCode).toBe(403);
        expect((refusal as RoleEmailDomainNotAllowedError).details).toEqual({ roleName: 'admin', reason: 'domain' });
        expect(JSON.stringify({ ...(refusal as object), message: (refusal as Error).message })).not.toContain('gmail');
    });

    it('lets a pending grant through unverified, but not out of domain', () =>
    {
        process.env[POLICY_VAR] = 'admin=example.com';
        const pending = { requireVerified: false };

        expect(() => assertEmailAllowedForRole({ email: 'new@example.com', emailVerifiedAt: null }, 'admin', pending))
            .not.toThrow();
        expect(() => assertEmailAllowedForRole({ email: 'new@gmail.test', emailVerifiedAt: null }, 'admin', pending))
            .toThrow(RoleEmailDomainNotAllowedError);
    });
});

describe('source scan: role resolution goes through findUserWithEffectiveRole', () =>
{
    const MIDDLEWARE_DIR = fileURLToPath(new URL('../../server/middleware', import.meta.url));

    it('no middleware calls usersRepository.findByIdWithRole directly', () =>
    {
        const offenders = readdirSync(MIDDLEWARE_DIR)
            .filter(file => file.endsWith('.ts'))
            .filter(file => readFileSync(join(MIDDLEWARE_DIR, file), 'utf8').includes('findByIdWithRole'));

        expect(offenders).toEqual([]);
    });

    it('the scan reads the middlewares that resolve a principal', () =>
    {
        const resolving = readdirSync(MIDDLEWARE_DIR)
            .filter(file => file.endsWith('.ts'))
            .filter(file => readFileSync(join(MIDDLEWARE_DIR, file), 'utf8').includes('findUserWithEffectiveRole('));

        expect(resolving.sort()).toEqual([
            'auth-profiles.ts',
            'authenticate-for-renewal.ts',
            'authenticate.ts',
            'one-time-token-auth.ts',
        ]);
    });
});
