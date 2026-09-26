/**
 * @spfn/auth - Role Email-Domain Policy Service
 *
 * Applies `SPFN_AUTH_ROLE_EMAIL_DOMAINS` (see `lib/role-email-domains.ts`) where
 * a principal's role is resolved, reports and demotes the accounts it refuses,
 * and refuses boot on a policy that cannot work.
 *
 * Check time never writes: an account outside the policy for its stored role is
 * resolved as the built-in `user` role for that call, and `users.roleId` keeps
 * the stored role, so reverting the configuration restores it on the next
 * request. Removing it for good is `demoteRoleEmailDomainViolations`, which an
 * app calls deliberately.
 */

import { authLogger } from '../logger';
import { rolesRepository, usersRepository } from '../repositories';
import {
    getRoleEmailDomainPolicy,
    isEmailAllowedForRole,
    roleEmailDomainViolation,
    ROLE_EMAIL_DOMAINS_VAR,
    type RoleEmailDomainViolationReason,
} from '../lib/role-email-domains';
import { updateUserService } from './user.service';

/** The built-in role an account outside the policy is resolved as. */
const FALLBACK_ROLE = 'user';

/** A user row with the role that applies to it. */
export type UserWithEffectiveRole = NonNullable<Awaited<ReturnType<typeof usersRepository.findByIdWithRole>>>;

/** An account whose stored role is restricted and who fails the rule. No address. */
export interface RoleEmailDomainViolation
{
    userId: number;
    roleName: string;
    reason: RoleEmailDomainViolationReason;
}

async function fallbackRole(): Promise<UserWithEffectiveRole['role']>
{
    const role = await rolesRepository.findByName(FALLBACK_ROLE);

    return role && { id: role.id, name: role.name, displayName: role.displayName, priority: role.priority };
}

/**
 * Load a user and the role that applies to them now.
 *
 * The one place a principal's role is resolved: every authenticating
 * middleware and every permission-service reader goes through here, so the
 * policy cannot be skipped by a caller that forgets it. The rule is evaluated
 * on the row already loaded, so an account inside the policy costs no query
 * beyond today's; only a downgrade reads the `user` role. Should that role not
 * exist, the account resolves with no role and therefore no permissions.
 *
 * @returns null when no such user exists
 */
export async function findUserWithEffectiveRole(userId: number): Promise<UserWithEffectiveRole | null>
{
    const result = await usersRepository.findByIdWithRole(userId);

    if (!result?.role || isEmailAllowedForRole(result.user, result.role.name))
    {
        return result;
    }

    authLogger.service.warn('Stored role not applied: the account is outside the email-domain policy for it', {
        reason: 'role_email_domain_policy',
        userId: result.user.id,
        storedRole: result.role.name,
    });

    return { user: result.user, role: await fallbackRole() };
}

/**
 * Accounts whose stored role is restricted and who fail the rule.
 *
 * For a periodic check in the app. Reads the current configuration; empty when
 * no policy is configured.
 */
export async function listRoleEmailDomainViolations(): Promise<RoleEmailDomainViolation[]>
{
    const restrictedRoles = [...getRoleEmailDomainPolicy().keys()];

    if (restrictedRoles.length === 0)
    {
        return [];
    }

    const holders = await usersRepository.findRoleHolders(restrictedRoles);

    return holders.flatMap((holder) =>
    {
        const reason = roleEmailDomainViolation(holder, holder.roleName);

        return reason ? [{ userId: holder.id, roleName: holder.roleName, reason }] : [];
    });
}

/**
 * Store the `user` role on every account `listRoleEmailDomainViolations` lists.
 *
 * Goes through `updateUserService`, the path an admin role change takes. Only
 * violators are touched, so a compliant superadmin is never demoted. Each
 * account is written on its own: a run that stops part-way leaves the rest
 * listed, and still resolved as `user` at check time, for the next run.
 *
 * @returns The accounts it demoted, with the role and reason they were demoted for
 * @throws Error when there is something to demote and the `user` role does not exist
 */
export async function demoteRoleEmailDomainViolations(): Promise<RoleEmailDomainViolation[]>
{
    const violations = await listRoleEmailDomainViolations();

    if (violations.length === 0)
    {
        return [];
    }

    const userRole = await rolesRepository.findByName(FALLBACK_ROLE);

    if (!userRole)
    {
        throw new Error(`Cannot demote: the built-in '${FALLBACK_ROLE}' role does not exist. Run initializeAuth() first.`);
    }

    for (const violation of violations)
    {
        await updateUserService(violation.userId, { roleId: userRole.id });
    }

    authLogger.service.info('Demoted accounts outside the email-domain policy', {
        reason: 'role_email_domain_policy',
        userIds: violations.map(violation => violation.userId),
    });

    return violations;
}

function policyEntry(roleName: string): string
{
    return `${roleName}=${[...getRoleEmailDomainPolicy().get(roleName) ?? []].join(',')}`;
}

async function assertRestrictedRolesExist(roleNames: string[]): Promise<void>
{
    const roles = await Promise.all(roleNames.map(name => rolesRepository.findByName(name)));
    const unknown = roleNames.filter((_, index) => !roles[index]);

    if (unknown.length > 0)
    {
        throw new Error(
            `${ROLE_EMAIL_DOMAINS_VAR} names roles that do not exist: ${unknown.map(name => `'${policyEntry(name)}'`).join(', ')}. `
            + 'A misspelt role would restrict nothing; fix the name or define the role.',
        );
    }
}

/**
 * Only active superadmins count: one that is suspended, inactive, pending
 * deletion or deleted cannot sign in, so it neither keeps the policy safe nor
 * makes it a lock-out.
 */
async function assertSuperadminReachable(): Promise<void>
{
    if (!getRoleEmailDomainPolicy().has('superadmin'))
    {
        return;
    }

    const holders = await usersRepository.findRoleHolders(['superadmin'], 'active');

    if (holders.length > 0 && !holders.some(holder => isEmailAllowedForRole(holder, 'superadmin')))
    {
        throw new Error(
            `${ROLE_EMAIL_DOMAINS_VAR} entry '${policyEntry('superadmin')}' admits none of the ${holders.length} `
            + 'superadmin account(s): every one would resolve as a plain user and nobody could fix it through '
            + 'the admin routes. Add a domain a superadmin holds with a verified email, or drop the entry.',
        );
    }
}

/**
 * Refuse boot on a policy that cannot work.
 *
 * Runs after RBAC initialization and admin seeding, so the roles and accounts
 * it reads are the ones this instance will serve. Refuses a malformed value, a
 * restriction on `user` (the fallback must always be satisfiable), a role that
 * does not exist, and a superadmin restriction that at least one stored
 * superadmin exists for and none satisfies. Silent when no policy is configured.
 *
 * @throws Error naming the variable and the offending entry — never an address
 */
export async function assertRoleEmailDomainPolicy(): Promise<void>
{
    const policy = getRoleEmailDomainPolicy();

    if (policy.size === 0)
    {
        return;
    }

    if (policy.has(FALLBACK_ROLE))
    {
        throw new Error(
            `${ROLE_EMAIL_DOMAINS_VAR} entry '${policyEntry(FALLBACK_ROLE)}' restricts the '${FALLBACK_ROLE}' role, `
            + 'which is the role every account outside the policy falls back to. Remove the entry.',
        );
    }

    await assertRestrictedRolesExist([...policy.keys()]);
    await assertSuperadminReachable();
}
