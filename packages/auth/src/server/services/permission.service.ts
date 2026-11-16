/**
 * @spfn/auth - Permission Service
 *
 * The permission model, in one module:
 *
 * - **What authority a person holds now** — `resolveAuthority`. `requireRole`
 *   (through the admission's role, `resolveRoleInForce`), `requirePermissions`,
 *   `GET /_auth/session` and the Next.js guards built on it all read this one
 *   answer, so the screen and the server cannot disagree.
 * - **Who may change which authority** — one rule: a caller changes only what
 *   ranks strictly below them (by role `priority`) and confers only what they
 *   hold. `assertCanChangeRole` applies it to giving and taking roles (both the
 *   role given and the role the target holds), `assertCanChangeAuthority` to
 *   everything else: what a role is (created, re-ranked, edited, deactivated,
 *   deleted, its permissions) and a person's own grants and revocations. Equals
 *   cannot change each other. No role is named: an app-defined role is bound by
 *   its priority exactly as the built-in ones are.
 *
 * Every path that writes authority passes the caller's **user id**, never an
 * authority resolved beforehand: the caller's authority is resolved inside the
 * writing transaction, after whatever it locks (`holdAuthority`).
 *
 * Every role a judgement rests on — its priority, active flag or existence:
 * the role given, the target's current role, the caller's own role, the role
 * whose definition or permissions change — is read here and only here, by
 * `holdAuthority`, which locks them all in one call until the writing
 * transaction ends (`rolesRepository.lockInIdOrder`, in id order): the role
 * changed `FOR UPDATE`, every other `FOR SHARE`. Callers pass role ids, never
 * role rows, so no judgement can rest on a role read without the lock. A
 * change to a role (`updateRole`, a re-rank at boot) therefore cannot commit
 * between the judgement and the write it authorises, and two changes that
 * lock roles queue instead of deadlocking. Lock order: the target's account
 * first where the path takes one, then every role at once. `updateRole`,
 * `deleteRole` and the role-permission changes take no account lock.
 *
 * Every operation that judges through `holdAuthority` opens its transaction
 * with `runJudgedTransaction`: a judgement whose premise went stale between
 * the read and the lock is made again, once, from the top.
 */

import { getTransaction, runInTransaction } from '@spfn/core/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@spfn/core/errors';
import { AuthorityContendedError } from '@spfn/auth/errors';

import { permissionsRepository, rolePermissionsRepository, rolesRepository, userPermissionsRepository, usersRepository } from '../repositories';
import type { AuthorityRead, GrantExpiry, PermissionSummary, StoredRole } from '../repositories/users.repository';
import type { Role } from '../entities/roles';
import { BUILTIN_ROLES } from '../rbac/builtin';
import { resolveRoleInForce } from './role-email-domain.service';
import { updateUserService } from './user.service';

/** A role as an authority names it. */
export type AuthorityRole = Omit<StoredRole, 'isActive'>;

/** What a person may do now. */
export interface Authority
{
    /** The role in force; null for none — no role stored, or a deactivated one. */
    role: AuthorityRole | null;
    /** The role's priority; null without a role, which outranks nothing. */
    priority: number | null;
    /** Active permissions of the role, plus the person's own grants in force, minus their revocations in force. */
    permissions: PermissionSummary[];
    /**
     * The permissions held only through a per-user grant that expires, by id,
     * with when it does: what the person cannot confer for longer
     * (`assertCanChangeAuthority`). One the role also gives is not here.
     */
    expiringPermissions: ReadonlyMap<number, Date>;
}

const NO_AUTHORITY: Authority = { role: null, priority: null, permissions: [], expiringPermissions: new Map() };

/**
 * The authority a person holds now.
 *
 * One read of the primary (`findAuthorityOnPrimary`), and a second only when
 * the email-domain policy resolves the account as another role than it stores:
 *
 * - the role is the role in force (`resolveRoleInForce`): a deactivated role is
 *   no role — no name, no priority, no permissions;
 * - permissions = the active permissions of that role + the person's own
 *   grants that are of an active permission and unexpired − their own
 *   revocations that are unexpired;
 * - an account that is not active holds nothing, as an account the admission
 *   refuses — an inviter or an ops-token issuer who was suspended since
 *   confers nothing through what they issued.
 *
 * @param userId - User ID (string, number, or bigint)
 */
export async function resolveAuthority(userId: string | number | bigint): Promise<Authority>
{
    const read = await usersRepository.findAuthorityOnPrimary(Number(userId));

    if (read === null || read.user.status !== 'active')
    {
        return NO_AUTHORITY;
    }

    const role = await resolveRoleInForce(read);
    const revoked = new Set(read.revokes);
    const fromRole = await permissionsOfRole(role, read);
    const permissions = uniqueByName([...fromRole, ...read.grants])
        .filter(permission => !revoked.has(permission.name));

    return {
        role: role && { id: role.id, name: role.name, displayName: role.displayName, priority: role.priority },
        priority: role?.priority ?? null,
        permissions,
        expiringPermissions: expiringOnly(read.grantExpiries, fromRole),
    };
}

/** The expiring grants of permissions the role does not also give, as id → expiry. */
function expiringOnly(grantExpiries: GrantExpiry[], fromRole: PermissionSummary[]): Map<number, Date>
{
    const roleGives = new Set(fromRole.map(permission => Number(permission.id)));

    return new Map(grantExpiries
        .filter(grant => !roleGives.has(grant.permissionId))
        .map(grant => [grant.permissionId, grant.expiresAt]));
}

/** The role's active permissions: read with the account, unless the policy put it in another role. */
async function permissionsOfRole(role: StoredRole | null, read: AuthorityRead): Promise<PermissionSummary[]>
{
    if (role === null)
    {
        return [];
    }

    return role.id === read.role?.id ? read.rolePermissions : rolePermissionsRepository.findActivePermissionsOnPrimary(role.id);
}

function uniqueByName(permissions: PermissionSummary[]): PermissionSummary[]
{
    return [...new Map(permissions.map(permission => [permission.name, permission])).values()];
}

async function permissionNamesOf(userId: string | number | bigint): Promise<string[]>
{
    return (await resolveAuthority(userId)).permissions.map(permission => permission.name);
}

/**
 * The names of the permissions a user holds now — `resolveAuthority`'s list.
 *
 * @example
 * ```typescript
 * const perms = await getUserPermissions('123');
 * // ['auth:self:manage', 'user:read', 'post:create']
 * ```
 */
export async function getUserPermissions(userId: string | number | bigint): Promise<string[]>
{
    return permissionNamesOf(userId);
}

/**
 * Check if user has a specific permission
 *
 * @example
 * ```typescript
 * if (await hasPermission('123', 'user:delete')) {
 *   // User can delete users
 * }
 * ```
 */
export async function hasPermission(userId: string | number | bigint, permissionName: string): Promise<boolean>
{
    return (await permissionNamesOf(userId)).includes(permissionName);
}

/**
 * Check if user has any of the specified permissions
 */
export async function hasAnyPermission(userId: string | number | bigint, permissionNames: string[]): Promise<boolean>
{
    const held = await permissionNamesOf(userId);

    return permissionNames.some(name => held.includes(name));
}

/**
 * Check if user has all of the specified permissions
 */
export async function hasAllPermissions(userId: string | number | bigint, permissionNames: string[]): Promise<boolean>
{
    const held = await permissionNamesOf(userId);

    return permissionNames.every(name => held.includes(name));
}

/**
 * The name of the role a user holds now — `resolveAuthority`'s role — or null.
 * For the stored role itself, see `getStoredUserRole`.
 */
export async function getUserRole(userId: string | number | bigint): Promise<string | null>
{
    return (await resolveAuthority(userId)).role?.name ?? null;
}

/**
 * Get the role stored on a user's row, whatever its state and whatever the
 * email-domain policy says
 *
 * @returns Stored role name or null if user has no role
 */
export async function getStoredUserRole(userId: string | number | bigint): Promise<string | null>
{
    return (await usersRepository.findByIdWithRole(Number(userId)))?.role?.name ?? null;
}

/**
 * Check if user holds a specific role now
 */
export async function hasRole(userId: string | number | bigint, roleName: string): Promise<boolean>
{
    return await getUserRole(userId) === roleName;
}

/**
 * Check if user holds any of the specified roles now
 */
export async function hasAnyRole(userId: string | number | bigint, roleNames: string[]): Promise<boolean>
{
    const role = await getUserRole(userId);

    return role !== null && roleNames.includes(role);
}

/** A change of the role an account holds, or will hold once an invitation is accepted. */
export interface RoleChange
{
    /** The role the target account stores now, whatever its state; null when there is no account yet. */
    targetUserCurrentRole: number | null;
    /** The role given; null when the change gives none (an invitation cancelled). */
    newRole: number | null;
}

/** Why a role change is refused. */
export type RoleChangeRefusal = 'unknownRole' | 'inactiveRole' | 'insufficientAuthority';

/** The roles a judgement locks besides the caller's own. */
export interface RolesJudged
{
    /** The role the operation changes: held `FOR UPDATE`. */
    changed?: number;
    /** The roles the judgement reads: held `FOR SHARE`. Null or absent ones are skipped. */
    read?: Array<number | null | undefined>;
}

/** What a judgement reads in the writing transaction, held until it ends. */
export interface HeldAuthority
{
    /** The caller's authority, read once their role in force is held. */
    caller: Authority;
    /** The roles held, by id; one asked for that does not exist is absent. */
    roles: ReadonlyMap<number, Role>;
}

/**
 * The caller's role in force, read before `holdAuthority` locked, was not the
 * one it found once the locks were held. Raised for the operation that opened
 * the transaction to judge again (`runJudgedTransaction`); itself the typed
 * refusal, so where nothing can start over — a transaction the app opened —
 * it is answered as one.
 */
class StaleAuthorityPremise extends AuthorityContendedError
{
}

/**
 * Hold the caller's authority and every role a judgement rests on, inside the
 * transaction that writes — after that transaction took whatever account it
 * locks, never before. Every role is locked in this one call
 * (`rolesRepository.lockInIdOrder`, which states the order rule): the role
 * changed `FOR UPDATE`; the roles read and the caller's role in force — its
 * priority is what authorises the change — `FOR SHARE`, so a re-rank of any of
 * them waits for the change to commit.
 *
 * The caller's role is learnt from a read before the lock, and the authority
 * judged is read again once it is held. Should the caller's role in force
 * have changed between the two reads, nothing is judged: holding the new role
 * would take a role lock after the one call, out of id order — the deadlock
 * the rule is there to prevent. The premise was stale, not wrong, so the
 * operation that opened the transaction judges again from the start, on fresh
 * reads (`runJudgedTransaction`).
 *
 * The caller's own account is not locked: one account lock per transaction.
 * Re-reading without it is enough. This read, on the primary, sees every
 * demotion or suspension of the caller that committed before it; one that
 * commits later is ordered after this change, which the caller had the
 * authority for when it was made.
 *
 * @throws AuthorityContendedError (409) when the caller's role in force changed while it was being held — the stale-premise signal on which `runJudgedTransaction` judges again
 */
export async function holdAuthority(callerId: number, judged: RolesJudged = {}): Promise<HeldAuthority>
{
    const before = await resolveAuthority(callerId);
    const held = await rolesRepository.lockInIdOrder({
        update: judged.changed === undefined ? [] : [judged.changed],
        share: [...(judged.read ?? []), before.role?.id],
    });
    const caller = await resolveAuthority(callerId);

    if (caller.role?.id !== before.role?.id)
    {
        throw new StaleAuthorityPremise();
    }

    return { caller, roles: new Map(held.map(role => [role.id, role])) };
}

/**
 * Run an operation that judges through `holdAuthority`, in a transaction of
 * its own, and once more from the top if the judgement's premise was stale.
 *
 * `holdAuthority` reads whose authority it judges, then locks, then reads
 * again; a role change landing between the two reads leaves the locks on the
 * wrong role (`StaleAuthorityPremise`). Only the operation can judge again —
 * its HTTP client would only be told about someone else's role (an invitee
 * about the inviter's). So it runs again in a new transaction: every read is
 * fresh, the roles are locked in id order again, and it is judged on what is
 * true now — a demoted inviter is a 410, a caller whose role was deactivated
 * a 403. A second stale premise is answered `AuthorityContendedError` (409):
 * one retry, never a loop.
 *
 * Nothing a run does outside its transaction happens twice: events and mail
 * are emitted after commit (`onAfterCommit`), and a rolled-back attempt
 * commits nothing. Inside a transaction opened by someone else it runs once,
 * as a savepoint: starting over there would lock again in the same
 * transaction, so a stale premise is the 409 at once.
 *
 * @throws AuthorityContendedError (409) when the premise was stale twice
 */
export async function runJudgedTransaction<T>(work: () => Promise<T>, options: { context: string }): Promise<T>
{
    const attempt = () => runInTransaction(work, options);

    if (getTransaction() !== null)
    {
        return await attempt().catch(refuseStalePremise);
    }

    return await attempt().catch((error: unknown) => error instanceof StaleAuthorityPremise
        ? attempt().catch(refuseStalePremise)
        : Promise.reject(error));
}

/** A stale premise nothing will judge again, as the typed refusal; anything else as it is. */
function refuseStalePremise(error: unknown): Promise<never>
{
    return Promise.reject(error instanceof StaleAuthorityPremise ? new AuthorityContendedError() : error);
}

/** A role the judgement holds; null for none, or for one that does not exist. */
function heldRole(held: HeldAuthority, roleId: number | null | undefined): Role | null
{
    return roleId == null ? null : held.roles.get(Number(roleId)) ?? null;
}

/**
 * The role a change is made to, as held — `FOR UPDATE`, with `RolesJudged.changed`.
 *
 * @throws NotFoundError (404) when the role does not exist
 */
export function changedRole(held: HeldAuthority, roleId: number): Role
{
    const role = heldRole(held, roleId);

    if (!role)
    {
        throw new NotFoundError({ message: 'Role not found', resource: 'Role' });
    }

    return role;
}

/**
 * Why the person `callerId` may not make `change`, or null when they may. For
 * a path that answers a refusal in its own vocabulary (invitation acceptance,
 * judging the inviter); every other path throws through `assertCanChangeRole`.
 *
 * Call it inside the transaction that writes the change, after the account
 * lock where there is one: the caller's authority and the roles are read
 * there, held `FOR SHARE` until that transaction ends (`holdAuthority`) — a
 * caller demoted or a role deactivated or re-ranked a moment ago is judged as
 * it is now, and one re-ranked a moment later waits for the change to commit.
 *
 * @throws AuthorityContendedError (409) when the caller's role changed while it was being held — the stale-premise signal on which `runJudgedTransaction` judges again
 */
export async function roleChangeRefusal(callerId: number, change: RoleChange): Promise<RoleChangeRefusal | null>
{
    const held = await holdAuthority(callerId, { read: [change.targetUserCurrentRole, change.newRole] });
    const current = heldRole(held, change.targetUserCurrentRole);
    const next = heldRole(held, change.newRole);

    if (change.newRole !== null && next === null)
    {
        return 'unknownRole';
    }

    if (next !== null && !next.isActive)
    {
        return 'inactiveRole';
    }

    return outranks(held.caller, current) && outranks(held.caller, next) ? null : 'insufficientAuthority';
}

/** Strictly above: equals cannot change each other, and no role outranks nothing. */
function outranks(caller: Authority, role: Pick<Role, 'priority'> | null): boolean
{
    return role === null || (caller.priority !== null && caller.priority > role.priority);
}

const ROLE_CHANGE_ERRORS: Record<RoleChangeRefusal, () => Error> = {
    unknownRole: () => new NotFoundError({ message: 'Role not found', resource: 'Role' }),
    inactiveRole: () => new ConflictError({ message: 'The role is inactive: activate it before giving it' }),
    insufficientAuthority: () => new ForbiddenError({
        message: 'A role can be given or taken only by a caller whose own role ranks above it',
    }),
};

/**
 * Refuse a role change the caller has no authority for — the one rule every
 * path that gives or takes a role passes: the admin role change, invitation
 * create, resend and cancel, and invitation acceptance (against the inviter's
 * authority at acceptance, through `roleChangeRefusal`).
 *
 * The caller must outrank, by priority, both the role the target holds now and
 * the role given. Only a superadmin therefore creates or demotes an admin, and
 * nobody changes a superadmin.
 *
 * Call it inside the transaction that writes the change, after its lock: the
 * caller's authority is resolved here, from `callerId`.
 *
 * @throws NotFoundError (404) when the role given does not exist
 * @throws ConflictError (409) when the role given is inactive
 * @throws ForbiddenError (403) when the caller does not outrank both roles
 * @throws AuthorityContendedError (409) when the caller's role changed while it was being held — the stale-premise signal on which `runJudgedTransaction` judges again
 *
 * @example
 * ```typescript
 * await runJudgedTransaction(async () =>
 * {
 *     const target = await usersRepository.lockAccount(userId);
 *     await assertCanChangeRole(callerId, { targetUserCurrentRole: target!.roleId, newRole: roleId });
 *     // … write
 * }, { context: 'app:role-change' });
 * ```
 */
export async function assertCanChangeRole(callerId: number, change: RoleChange): Promise<void>
{
    const refusal = await roleChangeRefusal(callerId, change);

    if (refusal !== null)
    {
        throw ROLE_CHANGE_ERRORS[refusal]();
    }
}

/**
 * Give an account another role, on the caller's authority.
 *
 * The target's account is locked first; the target's role and the caller's
 * authority are both read after it, in the transaction that writes: a role
 * change of the target that raced this one is judged as it committed, and so
 * is a demotion of the caller that committed before this read.
 *
 * @param callerId - The person making the change
 * @throws NotFoundError (404) when the account or the role does not exist
 * @throws ConflictError (409) when the role is inactive
 * @throws ForbiddenError (403) when the caller does not outrank both roles
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 */
export async function changeUserRole(callerId: number, userId: number, roleId: number): Promise<void>
{
    await runJudgedTransaction(async () =>
    {
        const target = await lockedAccount(userId);

        await assertCanChangeRole(callerId, { targetUserCurrentRole: target.roleId, newRole: roleId });
        await updateUserService(userId, { roleId });
    }, { context: 'auth:role-change' });
}

/** The account, locked for the rest of the transaction. @throws NotFoundError (404) */
async function lockedAccount(userId: number)
{
    const account = await usersRepository.lockAccount(userId);

    if (!account)
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    return account;
}

/**
 * A change to what a role is, or to what one person holds beyond their role,
 * as `assertCanChangeAuthority` judges it. Each field present is one thing the
 * change touches; a change names every one it touches.
 */
export interface AuthorityChange
{
    /** The role changed — its rank, state or permissions, or the role itself (deleted). Locked here, `FOR UPDATE`. */
    roleId?: number;
    /** The rank given to a role: the one it is created with, or re-ranked to. */
    priority?: number;
    /** The role the account whose own grants change stores now, whatever its state; null for none. */
    targetUserCurrentRole?: number | null;
    /** The permissions conferred: attached to a role, or granted to a person. */
    conferred?: number[];
    /** When what is conferred stops applying: a per-user grant's expiry; null or absent for never, as on a role. */
    conferredUntil?: Date | null;
}

/** Why a change of authority is refused — each a 403. */
export type AuthorityChangeRefusal = 'rankNotBelowCaller' | 'roleNotBelowCaller' | 'personNotBelowCaller' | 'permissionNotHeld' | 'permissionNotHeldThatLong';

const AUTHORITY_CHANGE_MESSAGES: Record<AuthorityChangeRefusal, string> = {
    rankNotBelowCaller: 'A role can be created or ranked only below the caller\'s own role',
    roleNotBelowCaller: 'A role can be changed only by a caller whose own role ranks above it',
    personNotBelowCaller: 'A person\'s own permissions can be changed only by a caller whose role ranks above theirs',
    permissionNotHeld: 'A permission can be given only by a caller who holds it',
    permissionNotHeldThatLong: 'A permission held through an expiring grant can be given only as a grant that expires no later: never to a role',
};

/**
 * Refuse a change of authority the caller has no authority for — the rule
 * `assertCanChangeRole` applies to giving and taking roles, applied to
 * everything else: a caller changes only what ranks strictly below them, and
 * confers only what they hold.
 *
 * - creating a role, or re-ranking one, at or above the caller's priority;
 * - changing a role the caller does not strictly outrank — its definition,
 *   rank, state or permissions, or deleting it (so nobody changes or deletes
 *   the highest role, `superadmin` included);
 * - attaching to a role, or granting to a person, a permission the caller does
 *   not hold now — or does not hold for as long: a permission the caller holds
 *   only through a per-user grant that expires is conferred only as a per-user
 *   grant expiring no later, and never attached to a role;
 * - granting to or revoking from a person whose stored role the caller does
 *   not strictly outrank.
 *
 * Call it inside the transaction that writes the change, after the target's
 * account lock where there is one: the caller's authority is resolved here,
 * from `callerId`, and every role it rests on is locked here
 * (`holdAuthority`) — the role changed `FOR UPDATE`, the others `FOR SHARE`.
 * A change that must read under the role's lock before it knows what it
 * confers (`setRolePermissions`) holds first and judges after, with
 * `holdAuthority`, `changedRole` and `assertAuthorityChangeAllowed`.
 *
 * @returns the role changed, as locked; null when the change names none
 * @throws NotFoundError (404) when the role changed does not exist
 * @throws ForbiddenError (403) naming what the caller does not outrank or hold
 * @throws AuthorityContendedError (409) when the caller's role changed while it was being held — the stale-premise signal on which `runJudgedTransaction` judges again
 */
export async function assertCanChangeAuthority(callerId: number, change: AuthorityChange): Promise<Role | null>
{
    const held = await holdAuthority(callerId, { changed: change.roleId, read: [change.targetUserCurrentRole] });
    const role = change.roleId === undefined ? null : changedRole(held, change.roleId);

    assertAuthorityChangeAllowed(held, change);

    return role;
}

/**
 * `assertCanChangeAuthority`'s judgement, on what `held` holds: every role
 * `change` names must have been held with it.
 *
 * @throws ForbiddenError (403) naming what the caller does not outrank or hold
 */
export function assertAuthorityChangeAllowed(held: HeldAuthority, change: AuthorityChange): void
{
    const refusal = authorityChangeRefusal(held, change);

    if (refusal !== null)
    {
        throw new ForbiddenError({ message: AUTHORITY_CHANGE_MESSAGES[refusal] });
    }
}

function authorityChangeRefusal(held: HeldAuthority, change: AuthorityChange): AuthorityChangeRefusal | null
{
    if (change.priority !== undefined && !outranks(held.caller, { priority: change.priority }))
    {
        return 'rankNotBelowCaller';
    }

    if (change.roleId !== undefined && !outranks(held.caller, heldRole(held, change.roleId)))
    {
        return 'roleNotBelowCaller';
    }

    if (change.targetUserCurrentRole !== undefined && !outranks(held.caller, heldRole(held, change.targetUserCurrentRole)))
    {
        return 'personNotBelowCaller';
    }

    return conferralRefusal(held.caller, (change.conferred ?? []).map(Number), change.conferredUntil ?? null);
}

/** Refuse conferring what the caller does not hold, or not for as long as `until` (null: for good). */
function conferralRefusal(caller: Authority, conferred: number[], until: Date | null): AuthorityChangeRefusal | null
{
    const held = new Set(caller.permissions.map(permission => Number(permission.id)));

    if (!conferred.every(id => held.has(id)))
    {
        return 'permissionNotHeld';
    }

    return conferred.every(id => holdsUntil(caller, id, until)) ? null : 'permissionNotHeldThatLong';
}

function holdsUntil(caller: Authority, permissionId: number, until: Date | null): boolean
{
    const lapses = caller.expiringPermissions.get(permissionId);

    return lapses === undefined || (until !== null && until.getTime() <= lapses.getTime());
}

/** How a person's own grant or revocation is written. */
export interface UserPermissionOptions
{
    /** When it stops applying; null or absent for never. */
    expiresAt?: Date | null;
    /** Why — kept for the audit trail. */
    reason?: string;
}

/**
 * Grant a person a permission beyond their role, on the caller's authority
 * (`assertCanChangeAuthority`): the caller must outrank the person's stored
 * role and hold the permission — for at least as long as this grant lasts,
 * when they hold it only through an expiring grant of their own. Replaces a
 * grant or revocation of the same permission the person had.
 *
 * @param callerId - The person granting it
 * @throws NotFoundError (404) when the account does not exist
 * @throws ForbiddenError (403) when the caller does not outrank the person, or does not hold the permission as long as `options.expiresAt`
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 */
export async function grantUserPermission(callerId: number, userId: number, permissionId: number, options: UserPermissionOptions = {}): Promise<void>
{
    await writeUserPermission(callerId, userId, permissionId, true, options);
}

/**
 * Revoke a permission from a person, whatever their role gives, on the
 * caller's authority (`assertCanChangeAuthority`): the caller must outrank the
 * person's stored role. Replaces a grant or revocation of the same permission
 * the person had.
 *
 * @param callerId - The person revoking it
 * @throws NotFoundError (404) when the account or the permission does not exist
 * @throws ForbiddenError (403) when the caller does not outrank the person
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 */
export async function revokeUserPermission(callerId: number, userId: number, permissionId: number, options: UserPermissionOptions = {}): Promise<void>
{
    await writeUserPermission(callerId, userId, permissionId, false, options);
}

/** A per-user override, written under the target's account lock and judged after it. */
async function writeUserPermission(callerId: number, userId: number, permissionId: number, granted: boolean, options: UserPermissionOptions): Promise<void>
{
    await runJudgedTransaction(async () =>
    {
        const target = await lockedAccount(userId);

        await assertCanChangeAuthority(callerId, {
            targetUserCurrentRole: target.roleId,
            conferred: granted ? [permissionId] : [],
            conferredUntil: options.expiresAt ?? null,
        });

        if (!await permissionsRepository.findById(permissionId))
        {
            throw new NotFoundError({ message: 'Permission not found', resource: 'Permission' });
        }

        await userPermissionsRepository.upsert({
            userId,
            permissionId,
            granted,
            expiresAt: options.expiresAt ?? null,
            reason: options.reason ?? null,
        });
    }, { context: 'auth:user-permission' });
}

/**
 * Refuse deactivating the role that manages roles: with it inactive, nobody
 * holds the authority to reactivate it.
 *
 * @throws ConflictError (409)
 */
export function assertRoleMayBeDeactivated(role: Pick<Role, 'name'>): void
{
    if (role.name === BUILTIN_ROLES.SUPERADMIN.name)
    {
        throw new ConflictError({
            message: `The '${role.name}' role cannot be deactivated: nobody could manage roles afterwards`,
        });
    }
}
