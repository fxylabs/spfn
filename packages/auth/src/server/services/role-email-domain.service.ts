/**
 * @spfn/auth - Role Email-Domain Policy Service
 *
 * Resolves the role an account holds now (`resolveRoleInForce`): a deactivated
 * role is none, and `SPFN_AUTH_ROLE_EMAIL_DOMAINS` (see
 * `lib/role-email-domains.ts`) is applied. Reports and demotes the accounts the
 * policy refuses, and refuses boot on a policy that cannot work.
 *
 * Check time never writes: an account outside the policy for its stored role is
 * resolved as the built-in `user` role for that call, and `users.roleId` keeps
 * the stored role, so reverting the configuration restores it on the next
 * request. Removing it for good is `demoteRoleEmailDomainViolations`, which an
 * app calls deliberately.
 */

import { authLogger } from '../logger';
import { rolesRepository, usersRepository } from '../repositories';
import type { StoredRole, UserWithStoredRole } from '../repositories/users.repository';
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
export type UserWithEffectiveRole = UserWithStoredRole;

/** An account whose stored role is restricted and who fails the rule. No address. */
export interface RoleEmailDomainViolation
{
    userId: number;
    roleName: string;
    reason: RoleEmailDomainViolationReason;
}

async function fallbackRole(): Promise<StoredRole | null>
{
    const role = await rolesRepository.findByNameOnPrimary(FALLBACK_ROLE);

    return role && { id: role.id, name: role.name, displayName: role.displayName, priority: role.priority, isActive: role.isActive };
}

/**
 * Load a user and the role that applies to them now (`resolveRoleInForce`).
 *
 * Reads the replica. A caller that decides whether a request is admitted uses
 * `findUserWithEffectiveRoleOnPrimary`.
 *
 * @returns null when no such user exists
 */
export async function findUserWithEffectiveRole(userId: number): Promise<UserWithEffectiveRole | null>
{
    return withRoleInForce(await usersRepository.findByIdWithRole(userId));
}

/**
 * `findUserWithEffectiveRole` over a read of the write primary.
 *
 * @returns null when no such user exists
 */
export async function findUserWithEffectiveRoleOnPrimary(userId: number): Promise<UserWithEffectiveRole | null>
{
    return withRoleInForce(await usersRepository.findByIdWithRoleOnPrimary(userId));
}

async function withRoleInForce(result: UserWithStoredRole | null): Promise<UserWithEffectiveRole | null>
{
    return result && { user: result.user, role: await resolveRoleInForce(result) };
}

/**
 * The role a loaded account holds now — the one place that is decided. The
 * admission resolves its principal's role here, on the row its own read
 * loaded, and `resolveAuthority` the role whose permissions apply, so a role
 * check and a permission check cannot disagree on it.
 *
 * - **A deactivated role is no role**: no name, no priority, no permissions.
 *   The account still signs in, as an account with no role, and reactivating
 *   the role restores it — nothing is written.
 * - **A role the email-domain policy refuses the account** resolves as the
 *   built-in `user` role (or none, should that role be missing or inactive).
 *   The rule is evaluated on the row already loaded, so an account inside the
 *   policy costs no query; only a downgrade reads the `user` role.
 *
 * Check time never writes: `users.roleId` keeps the stored role either way.
 */
export async function resolveRoleInForce(account: UserWithStoredRole): Promise<StoredRole | null>
{
    if (!account.role?.isActive)
    {
        return null;
    }

    if (isEmailAllowedForRole(account.user, account.role.name))
    {
        return account.role;
    }

    authLogger.service.warn('Stored role not applied: the account is outside the email-domain policy for it', {
        reason: 'role_email_domain_policy',
        userId: account.user.id,
        storedRole: account.role.name,
    });

    const fallback = await fallbackRole();

    return fallback?.isActive ? fallback : null;
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
 * Refuse a policy that admits none of the active holders of the highest role
 * anyone holds — `superadmin`, as the built-ins stand. Nobody outranks that
 * role, so nobody could give it back through the admin routes: the role is
 * asked for by rank, not by name, and an app role ranked above it is judged
 * the same way.
 *
 * Only active holders count: one that is suspended, inactive, pending deletion
 * or deleted cannot sign in, so it neither keeps the policy safe nor makes it
 * a lock-out.
 */
async function assertHighestRoleReachable(): Promise<void>
{
    const holders = await highestRoleHolders();
    const restricted = [...new Set(holders.map(holder => holder.roleName))].filter(name => getRoleEmailDomainPolicy().has(name));

    if (restricted.length > 0 && !holders.some(holder => isEmailAllowedForRole(holder, holder.roleName)))
    {
        throw new Error(
            `${ROLE_EMAIL_DOMAINS_VAR} entry ${restricted.map(name => `'${policyEntry(name)}'`).join(', ')} admits none of the `
            + `${holders.length} '${restricted.join("', '")}' account(s), the highest role anyone holds: every one would `
            + 'resolve as a plain user and nobody could fix it through the admin routes. Add a domain one of them '
            + 'holds with a verified email, or drop the entry.',
        );
    }
}

/** The active accounts holding an active role of the highest priority any active account holds. */
async function highestRoleHolders()
{
    const priorityOf = new Map((await rolesRepository.findActive()).map(role => [role.name, role.priority]));
    const holders = await usersRepository.findRoleHolders([...priorityOf.keys()], true);
    const highest = Math.max(...holders.map(holder => priorityOf.get(holder.roleName)!));

    return holders.filter(holder => priorityOf.get(holder.roleName) === highest);
}

/**
 * Refuse boot on a policy that cannot work.
 *
 * Runs after RBAC initialization and admin seeding, so the roles and accounts
 * it reads are the ones this instance will serve. Refuses a malformed value, a
 * restriction on `user` (the fallback must always be satisfiable), a role that
 * does not exist, and a restriction on the highest role anyone holds that none
 * of its active holders satisfies (`superadmin`, as the built-ins stand).
 * Silent when no policy is configured.
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
    await assertHighestRoleReachable();
}
