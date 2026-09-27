/**
 * @spfn/auth - User Profile Service
 *
 * Service for retrieving and updating user profile information
 * Returns full user info with profile data
 */

import type { UserProfile, ProfileInfo } from '@spfn/auth';
import { usersRepository, userProfilesRepository } from '../repositories';
import { normalizeChosenLocale, profileLocale, type ProfileLocale } from '../lib/profile-locale';

/**
 * Profile update parameters
 * All fields are optional, empty string will be converted to null
 */
export interface UpdateProfileParams
{
    displayName?: string;
    firstName?: string;
    lastName?: string;
    avatarUrl?: string;
    bio?: string;
    locale?: string;
    timezone?: string;
    dateOfBirth?: string;
    gender?: string;
    website?: string;
    location?: string;
    company?: string;
    jobTitle?: string;
    metadata?: Record<string, any>;
}

/**
 * Get user profile information
 *
 * @param userId - User ID (string, number, or bigint)
 * @returns User profile data with profile nested
 *
 * @example
 * ```typescript
 * const data = await getUserProfileService('123');
 * console.log(data.email); // 'user@example.com'
 * console.log(data.profile?.displayName); // 'John Doe'
 * console.log(data.lastLoginAt); // '2024-01-01T00:00:00.000Z'
 * ```
 */
export async function getUserProfileService(userId: string | number | bigint): Promise<UserProfile>
{
    const userIdNum = typeof userId === 'string' ? Number(userId) : Number(userId);

    // Fetch user and profile in parallel
    const [user, profile] = await Promise.all([
        usersRepository.fetchFullUserData(userIdNum),
        userProfilesRepository.fetchProfileData(userIdNum),
    ]);

    return {
        userId: user.userId,
        publicId: user.publicId,
        email: user.email,
        username: user.username,
        emailVerified: user.isEmailVerified,
        phoneVerified: user.isPhoneVerified,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        profile: profile,
    };
}

/**
 * Update user locale
 *
 * @param userId - User ID
 * @param locale - Locale code (e.g., 'en', 'ko', 'ja'); `null` or blank clears the choice
 * @returns The stored choice, and the locale it resolves to
 */
export async function updateLocaleService(
    userId: string | number | bigint,
    locale: string | null,
): Promise<ProfileLocale>
{
    const chosen = normalizeChosenLocale(locale);

    await userProfilesRepository.upsertByUserId(Number(userId), { locale: chosen });

    return profileLocale(chosen);
}

/**
 * Convert empty string to null
 */
function emptyToNull<T>(value: T): T | null
{
    if (value === '')
    {
        return null;
    }

    return value;
}

/**
 * Update user profile (upsert)
 *
 * Creates profile if not exists, updates if exists
 * Empty strings are converted to null
 *
 * @param userId - User ID
 * @param params - Profile fields to update
 * @returns Updated profile info
 *
 * @example
 * ```typescript
 * const profile = await updateUserProfileService(123, {
 *     displayName: 'John Doe',
 *     bio: 'Software Engineer',
 *     location: '', // will be saved as null
 * });
 * ```
 */
export async function updateUserProfileService(
    userId: string | number | bigint,
    params: UpdateProfileParams,
): Promise<ProfileInfo>
{
    const userIdNum = typeof userId === 'string' ? Number(userId) : Number(userId);

    // Build update data, converting empty strings to null
    const updateData: Record<string, any> = {};

    if (params.displayName !== undefined)
    {
        updateData.displayName = emptyToNull(params.displayName);
    }
    if (params.firstName !== undefined)
    {
        updateData.firstName = emptyToNull(params.firstName);
    }
    if (params.lastName !== undefined)
    {
        updateData.lastName = emptyToNull(params.lastName);
    }
    if (params.avatarUrl !== undefined)
    {
        updateData.avatarUrl = emptyToNull(params.avatarUrl);
    }
    if (params.bio !== undefined)
    {
        updateData.bio = emptyToNull(params.bio);
    }
    if (params.locale !== undefined)
    {
        updateData.locale = normalizeChosenLocale(params.locale);
    }
    if (params.timezone !== undefined)
    {
        updateData.timezone = emptyToNull(params.timezone) || 'UTC';
    }
    if (params.dateOfBirth !== undefined)
    {
        updateData.dateOfBirth = emptyToNull(params.dateOfBirth);
    }
    if (params.gender !== undefined)
    {
        updateData.gender = emptyToNull(params.gender);
    }
    if (params.website !== undefined)
    {
        updateData.website = emptyToNull(params.website);
    }
    if (params.location !== undefined)
    {
        updateData.location = emptyToNull(params.location);
    }
    if (params.company !== undefined)
    {
        updateData.company = emptyToNull(params.company);
    }
    if (params.jobTitle !== undefined)
    {
        updateData.jobTitle = emptyToNull(params.jobTitle);
    }
    if (params.metadata !== undefined)
    {
        updateData.metadata = params.metadata;
    }

    // Upsert profile
    await userProfilesRepository.upsertByUserId(userIdNum, updateData);

    // Fetch and return updated profile
    const profile = await userProfilesRepository.fetchProfileData(userIdNum);

    return profile!;
}
