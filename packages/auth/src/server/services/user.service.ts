/**
 * @spfn/auth - User Service
 *
 * Handles user CRUD operations
 */

import { type NewUser, type User } from '../entities/users';
import { rolesRepository, usersRepository } from '../repositories';
import { assertEmailAllowedForRole, getRoleEmailDomainPolicy } from '../lib/role-email-domains';
import { ValidationError } from '@spfn/core/errors';
import { ReservedUsernameError, UsernameAlreadyTakenError } from '@spfn/auth/errors';
import { env } from '@spfn/auth/config';

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
function emailAfterUpdate(user: User, updates: Partial<NewUser>)
{
    return {
        email: updates.email !== undefined ? updates.email : user.email,
        emailVerifiedAt: updates.emailVerifiedAt !== undefined ? updates.emailVerifiedAt : user.emailVerifiedAt,
    };
}

/**
 * Refuse a role the email-domain policy does not let this account hold.
 *
 * Reads nothing when no policy is configured, so an install without one
 * behaves exactly as before.
 */
async function assertRoleGrantAllowed(userId: number, roleId: number, updates: Partial<NewUser>): Promise<void>
{
    if (getRoleEmailDomainPolicy().size === 0)
    {
        return;
    }

    const [user, role] = await Promise.all([usersRepository.findById(userId), rolesRepository.findById(roleId)]);

    if (user && role)
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
 * @throws RoleEmailDomainNotAllowedError (403) when the policy refuses the role
 */
export async function updateUserService(
    userId: number,
    updates: Partial<NewUser>,
): Promise<void>
{
    if (updates.roleId != null)
    {
        await assertRoleGrantAllowed(userId, updates.roleId, updates);
    }

    await usersRepository.updateById(userId, updates);
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
 * @throws ReservedUsernameError if username is reserved
 * @throws UsernameAlreadyTakenError if username is already in use by another user
 */
export async function updateUsernameService(userId: string | number | bigint, username: string | null)
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

    return await usersRepository.updateById(userIdNum, { username });
}
