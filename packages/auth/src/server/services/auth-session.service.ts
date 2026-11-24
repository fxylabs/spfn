/**
 * @spfn/auth - Auth Session Service
 *
 * Service for retrieving authentication session information
 * Returns minimal user info with role and permissions
 */
import { usersRepository } from '../repositories';
import { resolveAuthority, userIdOf } from './permission.service';
import { secondFactorEnrolmentFields } from './second-factor-policy.service';

/**
 * Get authentication session information
 *
 * The role and permissions are `resolveAuthority`'s — exactly what
 * `requireRole` and `requirePermissions` enforce — so a page guard agrees with
 * the API: the role in force (`null` when the account holds none, or holds a
 * deactivated one), and the permissions with the person's own grants and
 * revocations applied.
 *
 * `secondFactorEnrolmentRequired: true` is present exactly when the
 * second-factor policy holds this session to enrolling one, as on the
 * `LoginResult` — this route is one such a session reaches. Whether the account
 * must change its password is not read here: the route reports the account row
 * admission read on the primary (#362).
 *
 * @param userId - User ID (string, number, or bigint)
 * @returns Auth session data (minimal user info + role + permissions)
 * @throws BadRequestError naming the id, before any read, when it is not a
 *   user id (`userIdOf`)
 *
 * @example
 * ```typescript
 * const session = await getAuthSessionService('123');
 * console.log(session.userId); // '123'
 * console.log(session.role?.name); // 'admin'
 * console.log(session.permissions.length); // 15
 * ```
 */
export async function getAuthSessionService(userId: string | number | bigint)
{
    const userIdNum = userIdOf(userId);

    const [user, authority] = await Promise.all([
        usersRepository.fetchMinimalUserData(userIdNum),
        resolveAuthority(userIdNum),
    ]);

    return {
        userId: user.userId,
        publicId: user.publicId,
        email: user.email,
        emailVerified: user.isEmailVerified,
        phoneVerified: user.isPhoneVerified,
        hasPassword: user.hasPassword,
        role: authority.role,
        permissions: authority.permissions,
        ...await secondFactorEnrolmentFields(userIdNum),
    };
}
