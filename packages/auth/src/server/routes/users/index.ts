/**
 * @spfn/auth - User Profile Routes
 */

import { getAuth } from '../../helpers';
import { getUserProfileService, updateUserProfileService, checkUsernameAvailableService, updateUsernameService, updateLocaleService } from '../../services';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { defineRouter, route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

/**
 * GET /_auth/users/profile
 * Get user profile (authenticated)
 *
 * Returns complete user profile information including:
 * - User basic info (id, email, verification status, timestamps)
 * - Profile data (optional)
 *
 * Does not include role and permissions
 * Use /_auth/session for authentication/authorization data
 *
 * Requires authentication
 */
export const getUserProfile = route.get('/_auth/users/profile')
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);

        return await getUserProfileService(userId);
    });

/**
 * PATCH /_auth/users/profile
 * Update user profile (authenticated)
 *
 * Creates profile if not exists (upsert)
 * Empty string values are saved as null
 *
 * Requires authentication
 */
export const updateUserProfile = route.patch('/_auth/users/profile')
    .input({
        body: Type.Object({
            displayName: Type.Optional(Type.String({ description: 'Display name shown in UI' })),
            firstName: Type.Optional(Type.String({ description: 'First name' })),
            lastName: Type.Optional(Type.String({ description: 'Last name' })),
            avatarUrl: Type.Optional(Type.String({ description: 'Avatar/profile picture URL' })),
            bio: Type.Optional(Type.String({ description: 'Short bio/description' })),
            locale: Type.Optional(Type.String({ description: 'Locale/language preference (e.g., en, ko)' })),
            timezone: Type.Optional(Type.String({ description: 'Timezone (e.g., Asia/Seoul)' })),
            dateOfBirth: Type.Optional(Type.String({ description: 'Date of birth (YYYY-MM-DD)' })),
            gender: Type.Optional(Type.String({ description: 'Gender' })),
            website: Type.Optional(Type.String({ description: 'Personal or professional website' })),
            location: Type.Optional(Type.String({ description: 'Location (city, country, etc.)' })),
            company: Type.Optional(Type.String({ description: 'Company name' })),
            jobTitle: Type.Optional(Type.String({ description: 'Job title' })),
            metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Additional metadata' })),
        }),
    })
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);
        const { body } = await c.data();

        return await updateUserProfileService(userId, body);
    });

/**
 * GET /_auth/users/username/check
 * Check if username is available
 *
 * Returns { available: boolean }
 *
 * Requires authentication
 */
export const checkUsername = route.get('/_auth/users/username/check')
    .input({
        query: Type.Object({
            username: Type.String({ minLength: 1 }),
        }),
    })
    .use([rateLimitPolicy('auth-username-check', { limit: 30, windowMs: 60_000 })])
    .handler(async (c) =>
    {
        const { query } = await c.data();

        return { available: await checkUsernameAvailableService(query.username) };
    });

/**
 * PATCH /_auth/users/username
 * Update username (authenticated)
 *
 * Validates uniqueness before updating.
 * Pass null to clear the username.
 *
 * @throws UsernameAlreadyTakenError (409) if username is taken
 *
 * Requires authentication
 */
export const updateUsername = route.patch('/_auth/users/username')
    .input({
        body: Type.Object({
            username: Type.Union([
                Type.String({ minLength: 1 }),
                Type.Null(),
            ], { description: 'New username or null to clear' }),
        }),
    })
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);
        const { body } = await c.data();

        return await updateUsernameService(userId, body.username);
    });

/**
 * PATCH /_auth/users/locale
 * Update user locale (authenticated)
 *
 * Lightweight endpoint for locale-only updates
 *
 * Requires authentication
 */
export const updateLocale = route.patch('/_auth/users/locale')
    .input({
        body: Type.Object({
            locale: Type.Union([Type.String(), Type.Null()], { description: 'Locale code (e.g., en, ko, ja); null or blank clears the choice' }),
        }),
    })
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);
        const { body } = await c.data();

        return await updateLocaleService(userId, body.locale);
    });

// Export router
export const userRouter = defineRouter({
    getUserProfile: getUserProfile,
    updateUserProfile: updateUserProfile,
    checkUsername: checkUsername,
    updateUsername: updateUsername,
    updateLocale: updateLocale,
});

// For backward compatibility with file-based routing (temporary)
export default userRouter;
