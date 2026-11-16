/**
 * @spfn/auth - User Service
 *
 * Handles user CRUD operations
 */

import { runInTransaction } from '@spfn/core/db';
import { NotFoundError } from '@spfn/core/errors';

import { type User } from '../entities/users';
import type { AccountDeletionState, AccountStatusSource, UserStatus } from '../types';
import { keysRepository, rolesRepository, usersRepository, type UserUpdate } from '../repositories';
import { accountStatusRepository } from '../repositories/account-status.repository';
import { assertEmailAllowedForRole, getRoleEmailDomainPolicy } from '../lib/role-email-domains';
import { ValidationError } from '@spfn/core/errors';
import { ReservedUsernameError, UsernameAlreadyTakenError } from '@spfn/auth/errors';
import { env } from '@spfn/auth/config';
import type { UserProfile } from '@spfn/auth';
import { getUserProfileService } from './user-profile.service';

/**
 * Get user by ID
 */
export async function getUserByIdService(userId: number)
{
    return await usersRepository.findById(userId);
}

/**
 * Get user by email
 */
export async function getUserByEmailService(email: string)
{
    return await usersRepository.findByEmail(email);
}

/**
 * Get user by phone
 */
export async function getUserByPhoneService(phone: string)
{
    return await usersRepository.findByPhone(phone);
}

/**
 * Update user's last login timestamp
 */
export async function updateLastLoginService(userId: number)
{
    await usersRepository.updateLastLogin(userId);
}

/**
 * The email columns as they will stand after `updates`. An update that changes
 * the address together with the role is judged on the new address.
 */
function emailAfterUpdate(user: User, updates: UserUpdate)
{
    return {
        email: updates.email !== undefined ? updates.email : user.email,
        emailVerifiedAt: updates.emailVerifiedAt !== undefined ? updates.emailVerifiedAt : user.emailVerifiedAt,
    };
}

/**
 * Refuse a role the email-domain policy does not let this account hold.
 *
 * Judged on the account as locked, and on the role's name read on the
 * primary: a replica that has not seen a role just created would skip the
 * check. The name is all it reads, and nothing renames a role, so the row is
 * not locked; a role deleted meanwhile fails the write's foreign-key check.
 *
 * Reads nothing when no policy is configured, so an install without one
 * behaves exactly as before.
 */
async function assertRoleGrantAllowed(user: User, roleId: number, updates: UserUpdate): Promise<void>
{
    if (getRoleEmailDomainPolicy().size === 0)
    {
        return;
    }

    const role = await rolesRepository.findByIdOnPrimary(roleId);

    if (role)
    {
        assertEmailAllowedForRole(emailAfterUpdate(user, updates), role.name);
    }
}

/**
 * Update user data
 *
 * A `roleId` in `updates` is a grant, and is refused when the role is
 * restricted by `SPFN_AUTH_ROLE_EMAIL_DOMAINS` and the account's email is
 * outside it, unverified, or absent.
 *
 * It judges no authority and holds no role: a `roleId` is written as given,
 * with no caller held to the permission model and no lock on the role, so a
 * re-rank, deactivation or deletion of it may land between whatever the
 * caller checked and this write. `changeUserRole` is the path that judges the
 * caller and holds the role until the write commits; a caller passing
 * `roleId` here holds the role's existence and state itself — this is for the
 * app's own trusted paths, such as admin seeding at boot.
 *
 * `status` is not an update this takes: an account's status changes through
 * `setAccountStatus`, which ends what the new status forbids.
 *
 * @throws RoleEmailDomainNotAllowedError (403) when the policy refuses the role
 */
export async function updateUserService(
    userId: number,
    updates: UserUpdate,
): Promise<void>
{
    await runInTransaction(async () =>
    {
        // The account row is written under its lock (`usersRepository.lockAccount`),
        // and a role grant is judged against the email read under it.
        const user = await usersRepository.lockAccount(userId);

        if (user && updates.roleId != null)
        {
            await assertRoleGrantAllowed(user, updates.roleId, updates);
        }

        await usersRepository.updateById(userId, updates);
    }, { context: 'auth:user-update' });
}

/** The status an account status change leaves, and why the change is made. */
export interface AccountStatusTransition
{
    /** The status the account has to be in for the change to happen; `'any'` holds whatever it was. */
    from: AccountStatusSource;
    /** Recorded on every key the change revokes. */
    reason: string;
}

/**
 * What `setAccountStatus` did: the account moved, or it was refused because the
 * account was not in the transition's `from` when the write ran — a writer that
 * committed after the caller decided on the change has the last word.
 */
export type AccountStatusChange = 'changed' | 'refused';

/**
 * Change an account's status — the one writer of `users.status`.
 *
 * A change names the status it leaves (`from`), and the write is one
 * conditional statement on the primary: a transition decided on a read that
 * another writer has since overtaken — an operator lifting a suspension that
 * another operator already changed — matches no row and is `'refused'`, rather than overwriting what that writer committed. The
 * caller maps the refusal to its own answer; inside the caller's transaction,
 * throwing that answer rolls back what it wrote before.
 *
 * One transaction writes the status and, for a status that forbids access
 * (anything but `active`), ends the account's key generation: every device key
 * is revoked, so no session of the account is admitted again and none comes
 * back when the account is reactivated — a person signs in anew. The streams
 * those keys opened close once the transaction commits, on every instance, by
 * the mechanism every key revocation uses (`closeConnectionsByKey`).
 *
 * The account lock (`usersRepository.lockAccount`) is its first statement, so
 * a status change and a sign-in in flight serialise instead of deadlocking.
 *
 * OAuth 2.1 grants are kept: the admission refuses them while the account is
 * not active, and the same grant works again after reactivation. Pending
 * second-factor sign-ins die with the generation (`revokeAllActiveByUserId`).
 *
 * Joins a transaction already open on the call chain, so a caller that writes
 * more beside the status commits or rolls back as one. An account's deletion
 * is not a status: `setAccountDeletion` moves it, and leaves this column.
 *
 * @throws NotFoundError when no such account exists and `from` is `'any'`
 */
export async function setAccountStatus(
    userId: number,
    status: UserStatus,
    transition: AccountStatusTransition,
): Promise<AccountStatusChange>
{
    return await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);

        if (!await accountStatusRepository.setStatus(userId, status, transition.from))
        {
            return refusedTransition(transition);
        }

        if (status !== 'active')
        {
            await keysRepository.revokeAllActiveByUserId(userId, transition.reason);
        }

        return 'changed';
    }, { context: 'auth:set-account-status' });
}

/** A change from `'any'` matches no row only for an account that does not exist. */
function refusedTransition(transition: AccountStatusTransition): AccountStatusChange
{
    if (transition.from === 'any')
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    return 'refused';
}

/** Where an account's deletion moves from, and why. */
export interface AccountDeletionTransition
{
    /** The deletion the account has to be in for the change to happen; null: none asked for. */
    from: AccountDeletionState | null;
    /** Recorded on every key the change revokes. */
    reason: string;
}

/**
 * Move an account's deletion — the one writer of `users.deletion`, beside
 * `setAccountStatus` and never through it: asking for, cancelling or completing
 * a deletion leaves the status, so an operator's suspension holds through all
 * three.
 *
 * Like the status, the change names the deletion it leaves (`from`) and is one
 * conditional statement under the account lock: a request, cancel or purge
 * decided on a read another of them has overtaken matches no row and is
 * `'refused'`. Entering a deletion (`pending`, `deleted`) ends the account's
 * key generation in the same transaction; leaving one restores no key — the
 * person signs in anew.
 *
 * Package-internal: the deletion service is its only caller, because the
 * deletion request row moves with it.
 */
export async function setAccountDeletion(
    userId: number,
    deletion: AccountDeletionState | null,
    transition: AccountDeletionTransition,
): Promise<AccountStatusChange>
{
    return await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);

        if (!await accountStatusRepository.setDeletion(userId, deletion, transition.from))
        {
            return 'refused';
        }

        if (deletion !== null)
        {
            await keysRepository.revokeAllActiveByUserId(userId, transition.reason);
        }

        return 'changed';
    }, { context: 'auth:set-account-deletion' });
}

/**
 * Get reserved usernames from environment variable
 */
function getReservedUsernames(): Set<string>
{
    const raw = env.SPFN_AUTH_RESERVED_USERNAMES ?? '';
    if (!raw)
    {
        return new Set();
    }

    return new Set(
        raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    );
}

/**
 * Check if username is reserved
 */
function isReservedUsername(username: string): boolean
{
    return getReservedUsernames().has(username.toLowerCase());
}

/**
 * Validate username length against env config
 *
 * @throws ValidationError if username length is out of range
 */
function validateUsernameLength(username: string): void
{
    const min = env.SPFN_AUTH_USERNAME_MIN_LENGTH ?? 3;
    const max = env.SPFN_AUTH_USERNAME_MAX_LENGTH ?? 30;

    if (username.length < min)
    {
        throw new ValidationError({
            message: `Username must be at least ${min} characters`,
            details: { minLength: min, actual: username.length },
        });
    }

    if (username.length > max)
    {
        throw new ValidationError({
            message: `Username must be at most ${max} characters`,
            details: { maxLength: max, actual: username.length },
        });
    }
}

/**
 * Check if username is available
 *
 * @returns true if the username is available (not taken and not reserved)
 */
export async function checkUsernameAvailableService(username: string)
{
    validateUsernameLength(username);

    if (isReservedUsername(username))
    {
        return false;
    }

    const existing = await usersRepository.findByUsername(username);

    return !existing;
}

/**
 * Update username with reserved word and duplicate check
 *
 * @param userId - User ID (string, number, or bigint)
 * @param username - New username or null to clear
 * @returns The caller's profile, as `GET /_auth/users/profile` answers it — never the user row
 * @throws ReservedUsernameError if username is reserved
 * @throws UsernameAlreadyTakenError if username is already in use by another user
 */
export async function updateUsernameService(
    userId: string | number | bigint,
    username: string | null,
): Promise<UserProfile>
{
    const userIdNum = typeof userId === 'string' ? Number(userId) : Number(userId);

    if (username !== null)
    {
        validateUsernameLength(username);

        if (isReservedUsername(username))
        {
            throw new ReservedUsernameError({ username });
        }

        const existing = await usersRepository.findByUsername(username);

        if (existing && existing.id !== userIdNum)
        {
            throw new UsernameAlreadyTakenError({ username });
        }
    }

    await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userIdNum);
        await usersRepository.updateById(userIdNum, { username });
    }, { context: 'auth:username-update' });

    return await getUserProfileService(userIdNum);
}
