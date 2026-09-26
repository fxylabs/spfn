/**
 * @spfn/auth - Auth Session Service
 *
 * Service for retrieving authentication session information
 * Returns minimal user info with role and permissions
 */
import { NotFoundError } from '@spfn/core/errors';

import { usersRepository } from '../repositories';
import { findUserWithEffectiveRole } from './role-email-domain.service';

/**
 * Get authentication session information
 *
 * The role and permissions are the effective ones, as every server-side check
 * sees them: an account outside `SPFN_AUTH_ROLE_EMAIL_DOMAINS` for its stored
 * role reports the `user` role, so a page guard agrees with the API.
 *
 * @param userId - User ID (string, number, or bigint)
 * @returns Auth session data (minimal user info + role + permissions)
 *
 * @example
 * ```typescript
 * const session = await getAuthSessionService('123');
 * console.log(session.userId); // '123'
 * console.log(session.role.name); // 'admin'
 * console.log(session.permissions.length); // 15
 * ```
 */
export async function getAuthSessionService(userId: string | number | bigint)
{
    const userIdNum = typeof userId === 'string' ? Number(userId) : Number(userId);

    // Fetch user and effective role in parallel
    const [user, resolved] = await Promise.all([
        usersRepository.fetchMinimalUserData(userIdNum),
        findUserWithEffectiveRole(userIdNum),
    ]);

    if (!resolved?.role)
    {
        throw new NotFoundError({ message: '[@spfn/auth] User or role not found' });
    }

    return {
        userId: user.userId,
        publicId: user.publicId,
        email: user.email,
        emailVerified: user.isEmailVerified,
        phoneVerified: user.isPhoneVerified,
        hasPassword: user.hasPassword,
        role: resolved.role,
        permissions: await usersRepository.fetchActiveRolePermissions(resolved.role.id),
    };
}
