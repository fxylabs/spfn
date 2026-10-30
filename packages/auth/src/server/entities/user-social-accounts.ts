/**
 * @spfn/auth - User Social Accounts Entity
 *
 * Stores OAuth connections for social login providers
 */

import { SOCIAL_PROVIDERS } from '../types';
import { text, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { id, timestamps, foreignKey, enumText, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

export const userSocialAccounts = authSchema.table('user_social_accounts',
    {
        // Primary key
        id: id(),

        // User reference
        // Foreign key to users table
        // Links OAuth provider account to internal user
        // One user can have multiple provider connections
        userId: foreignKey('user', () => users.id),

        // OAuth provider
        // Supported providers: google, github, kakao, naver
        // Used for: identifying which OAuth provider was used
        provider: enumText('provider', SOCIAL_PROVIDERS).notNull(),

        // Provider's unique user identifier
        // Format varies by provider:
        // - Google: numeric string (e.g., "1234567890")
        // - GitHub: numeric ID
        // - Kakao: numeric ID
        // - Naver: alphanumeric string
        // Used for: linking provider account, preventing duplicate connections
        providerUserId: text('provider_user_id').notNull(),

        // Email from provider
        // May be null if provider doesn't share email
        // Used for: account linking, user verification
        providerEmail: text('provider_email'),

        // The name the provider shows for this account (Battle.net: the BattleTag)
        // Replaced on every sign-in and link, so it is the current one
        // Display material only — the account is identified by providerUserId
        // Null for providers that report none
        providerHandle: text('provider_handle'),

        // OAuth access token
        // ⚠️ SECURITY CRITICAL:
        // - MUST be encrypted at rest in production
        // - Use application-level encryption (AES-256-GCM recommended)
        // - Implement key rotation policy
        // - Never log or expose in API responses
        // - Set short expiration and refresh regularly
        // Used for: making API calls to provider on behalf of user
        accessToken: text('access_token'),

        // OAuth refresh token
        // ⚠️ SECURITY CRITICAL:
        // - MUST be encrypted at rest (same as accessToken)
        // - Store only if provider supports it
        // - Use to obtain new access tokens without re-authentication
        // - Revoke on user logout or account disconnect
        // Used for: refreshing expired access tokens
        refreshToken: text('refresh_token'),

        // Access token expiration timestamp
        // Used for: determining when to refresh token
        // Background job should refresh tokens before expiration
        tokenExpiresAt: utcTimestamp('token_expires_at'),

        ...timestamps(),
    },
    (table) => [
        // Indexes for query optimization
        // Index for user lookup (common query: get all providers for a user)
        index('user_social_accounts_user_id_idx').on(table.userId),

        // Index for provider lookup (for analytics, admin)
        index('user_social_accounts_provider_idx').on(table.provider),

        // Unique constraint: one provider account per provider
        // Prevents same OAuth account from being linked to multiple users
        uniqueIndex('provider_user_unique_idx')
            .on(table.provider, table.providerUserId),
    ],
);

// Type exports
export type UserSocialAccount = typeof userSocialAccounts.$inferSelect;
export type NewUserSocialAccount = typeof userSocialAccounts.$inferInsert;
