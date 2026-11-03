/**
 * @spfn/auth - User Profile Service
 *
 * Service for retrieving and updating user profile information
 * Returns full user info with profile data
 */

import type { UserProfile, ProfileInfo } from '@spfn/auth';
import { runInTransaction } from '@spfn/core/db';
import { usersRepository, userProfilesRepository } from '../repositories';
import { normalizeChosenLocale, profileLocale, type ProfileLocale } from '../lib/profile-locale';
import { setUserSetting } from './user-settings.service';
import { activeProfileFields, assertProfileFieldsPatch, assertStorableMetadata } from '../lib/profile-fields';
import { authLogger } from '../logger';

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
    /** @deprecated Written to the `locale` setting; use `setUserSetting` */
    locale?: string;
    /** @deprecated Written to the `timezone` setting; use `setUserSetting` */
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
 * Writes the built-in `locale` setting; clearing the choice deletes its row.
 * A person without a profile gets one, as before the move to settings.
 *
 * @param userId - User ID
 * @param locale - Locale code (e.g., 'en', 'ko', 'ja'); `null` or blank clears the choice
 * @returns The stored choice, and the locale it resolves to
 * @throws ValidationError (400) when the trimmed code is longer than 35 characters; nothing is written
 */
export async function updateLocaleService(
    userId: string | number | bigint,
    locale: string | null,
): Promise<ProfileLocale>
{
    const chosen = normalizeChosenLocale(locale);

    await runInTransaction(async () =>
    {
        await setUserSetting(userId, 'locale', chosen, { by: userId });
        // Main's upsert created the profile row; only that is kept — its locale column stays untouched
        await userProfilesRepository.createIfAbsent({ userId: Number(userId), displayName: 'User' });
    });

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

/** The profile columns a PATCH may write; `metadata` is handled on its own */
const PROFILE_TEXT_COLUMNS = [
    'displayName',
    'firstName',
    'lastName',
    'avatarUrl',
    'bio',
    'dateOfBirth',
    'gender',
    'website',
    'location',
    'company',
    'jobTitle',
] as const;

/**
 * The column writes of a PATCH. Free-form `metadata` (no profile fields
 * declared) is one of them and replaces the stored object; declared fields
 * are merged separately by `mergeDeclaredMetadata`.
 */
function profileColumnUpdates(params: UpdateProfileParams): Record<string, unknown>
{
    const updates: Record<string, unknown> = {};

    for (const column of PROFILE_TEXT_COLUMNS)
    {
        if (params[column] !== undefined)
        {
            updates[column] = emptyToNull(params[column]);
        }
    }
    if (params.metadata !== undefined && !activeProfileFields())
    {
        updates.metadata = params.metadata;
    }

    return updates;
}

/**
 * With profile fields declared, a `metadata` patch names only declared keys,
 * each passing its schema, and lands key by key: keys it does not name stay.
 */
async function mergeDeclaredMetadata(userId: number, metadata: Record<string, unknown> | undefined): Promise<void>
{
    if (activeProfileFields() && metadata !== undefined)
    {
        await userProfilesRepository.mergeMetadataByUserId(userId, metadata);
    }
}

/**
 * @throws ValidationError (400) before anything is written, when the patch is
 * over 64 KiB, holds a NUL character, or breaks the declaration
 */
function assertMetadataPatch(metadata: Record<string, unknown> | undefined): void
{
    if (metadata === undefined)
    {
        return;
    }
    assertStorableMetadata(metadata);

    const fields = activeProfileFields();
    if (fields)
    {
        assertProfileFieldsPatch(fields, metadata);
    }
}

/**
 * `locale` and `timezone` are settings now (#161); the profile PATCH still
 * accepts them and writes them there. An empty timezone means UTC, the default.
 */
async function writeProfileSettings(userId: number, params: UpdateProfileParams): Promise<void>
{
    if (params.locale !== undefined)
    {
        await setUserSetting(userId, 'locale', normalizeChosenLocale(params.locale), { by: userId });
    }
    if (params.timezone !== undefined)
    {
        await setUserSetting(userId, 'timezone', emptyToNull(params.timezone) || 'UTC', { by: userId });
    }
}

/** A PATCH that names no column still leaves a profile behind, as it always did */
async function writeProfileColumns(userId: number, updates: Record<string, unknown>): Promise<void>
{
    if (Object.keys(updates).length === 0)
    {
        await userProfilesRepository.createIfAbsent({ userId, displayName: 'User' });

        return;
    }
    await userProfilesRepository.upsertByUserId(userId, updates);
}

/**
 * Update user profile (upsert)
 *
 * Creates profile if not exists, updates if exists
 * Empty strings are converted to null
 * `locale` and `timezone` are written to user settings, in the same transaction
 * `metadata` replaces the stored object, unless profile fields are declared
 * (`defineProfileFields`): then it is merged key by key, and an undeclared key
 * or a value failing its field's schema is a 400
 *
 * @param userId - User ID
 * @param params - Profile fields to update
 * @returns Updated profile info
 * @throws ValidationError (400) when `timezone` is not an IANA zone name, or `metadata`
 * breaks the declared profile fields; nothing is written
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
    const userIdNum = Number(userId);

    assertMetadataPatch(params.metadata);
    await runInTransaction(async () =>
    {
        await writeProfileSettings(userIdNum, params);
        await writeProfileColumns(userIdNum, profileColumnUpdates(params));
        await mergeDeclaredMetadata(userIdNum, params.metadata);
    });

    return (await userProfilesRepository.fetchProfileData(userIdNum))!;
}

/**
 * Boot reconcile: with profile fields declared, report stored `metadata` keys
 * no field declares, once, and keep them. Readers never see them.
 */
export async function reconcileProfileFields(): Promise<void>
{
    const fields = activeProfileFields();
    if (!fields)
    {
        return;
    }

    const undeclared = (await userProfilesRepository.countMetadataKeys()).filter(row => !fields.has(row.key));
    if (undeclared.length > 0)
    {
        authLogger.service.warn(
            `user_profiles.metadata holds keys no profile field declares (kept, not read): ${undeclared.map(row => `${row.key} (${row.count})`).join(', ')}`,
        );
    }
}
