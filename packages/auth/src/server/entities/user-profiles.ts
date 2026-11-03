/**
 * @spfn/auth - User Profiles Entity
 *
 * User profile information (separate from authentication data)
 *
 * Features:
 * - Display name and personal information
 * - Avatar and bio
 * - Locale and timezone columns: no longer read or written; user settings own both (#161)
 * - Optional demographic data
 * - Social links and professional info
 */

import { text, index } from 'drizzle-orm/pg-core';
import { id, timestamps, typedJsonb, foreignKey } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

export const userProfiles = authSchema.table('user_profiles',
    {
        // Identity
        id: id(),

        // Foreign key to users table
        userId: foreignKey('user', () => users.id).unique(),

        // Display Information
        // Display name shown in UI (optional)
        displayName: text('display_name'),

        // First name (optional)
        firstName: text('first_name'),

        // Last name (optional)
        lastName: text('last_name'),

        // Profile Media
        // Avatar/profile picture URL
        avatarUrl: text('avatar_url'),

        // Short bio/description (max 500 chars recommended)
        bio: text('bio'),

        // Preferences — superseded by the built-in `locale` and `timezone` user
        // settings (#161). The migration copied both into user_settings; the
        // columns are neither read nor written and go in the next release.
        // Locale/language choice (e.g., 'en', 'ko', 'ja'); NULL = never chose, follow the request
        locale: text('locale'),

        // Timezone (e.g., 'Asia/Seoul', 'America/New_York')
        timezone: text('timezone').default('UTC'),

        // Optional Information
        // Date of birth (YYYY-MM-DD format)
        dateOfBirth: text('date_of_birth'),

        // Gender (flexible text field)
        gender: text('gender'),

        // Personal Links
        // Personal or professional website
        website: text('website'),

        // Location (city, country, etc.)
        location: text('location'),

        // Professional Information
        // Company name
        company: text('company'),

        // Job title
        jobTitle: text('job_title'),

        // Additional metadata (JSONB): who the person is beyond the columns above
        // With `defineProfileFields` installed, only declared keys, each checked
        // against its schema and merged key by key; without one, free-form and
        // replaced wholesale.
        // Example: { department: 'Engineering', github: 'username' }
        // How the person uses the app (theme, onboarding progress) is a user
        // setting, not profile metadata: see `defineUserSettings`.
        metadata: typedJsonb<Record<string, any>>('metadata'),

        ...timestamps(),
    },
    (table) => [
        // Indexes for query optimization
        index('user_profiles_user_id_idx').on(table.userId),
        index('user_profiles_display_name_idx').on(table.displayName),

        // Index for locale-based queries (useful for i18n features)
        index('user_profiles_locale_idx').on(table.locale),
    ],
);

// Type exports
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
