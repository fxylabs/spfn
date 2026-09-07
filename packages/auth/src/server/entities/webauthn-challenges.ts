/**
 * @spfn/auth - WebAuthn Challenges Entity
 *
 * The random value an authenticator signs, parked between the `options` call
 * that minted it and the `verify` call that spends it.
 *
 * In the database rather than in a cookie or in memory, for two reasons: the
 * check that makes a challenge one-time has to be a conditional UPDATE that two
 * concurrent verifies cannot both win, and several API instances serve the same
 * browser — an in-process map would let a replay land on the instance that never
 * saw the first attempt.
 *
 * Only the SHA-256 of the challenge is stored, following the rule the package
 * already applies to signup link tokens. A challenge is a nonce rather than a
 * bearer credential, so this buys less than it does there; it costs nothing, and
 * it keeps "plaintext or hash" from becoming a per-table judgement call.
 */

import { bigint, index, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, enumText, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

/**
 * Which ceremony the challenge was minted for.
 *
 * Recorded and matched at consume time so a registration challenge cannot be
 * presented to `login/verify` or the other way round — the two ceremonies
 * authorize very different things, and only the kind tells them apart once the
 * value itself is just 32 random bytes.
 */
export const WEBAUTHN_CHALLENGE_KINDS = ['registration', 'authentication'] as const;

export type WebAuthnChallengeKind = typeof WEBAUTHN_CHALLENGE_KINDS[number];

export const webauthnChallenges = authSchema.table('webauthn_challenges',
    {
        id: id(),

        // SHA-256 of the challenge, base64url. The challenge itself is returned
        // once, inside the options the browser is handed, and never stored.
        challengeHash: text('challenge_hash').notNull(),

        kind: enumText('kind', WEBAUTHN_CHALLENGE_KINDS).notNull(),

        // The account the ceremony is for, or null for a discoverable login —
        // where nobody has been identified yet and naming an account would be
        // the enumeration surface the whole flow is shaped to avoid (D3).
        //
        // Nullable, so `foreignKey()` (which is notNull by construction) does
        // not apply; the cascade is still declared, so destroying an account
        // takes its in-flight enrollment challenges with it.
        userId: bigint('user_id', { mode: 'number' }).references(() => users.id, { onDelete: 'cascade' }),

        // SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS from creation
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Set by the verify that spent it. Non-null means the challenge is
        // gone, regardless of expiry.
        consumedAt: utcTimestamp('consumed_at'),

        createdAt: utcTimestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        // The consume path addresses a row by this alone.
        // Unique so one presented challenge can never match two rows.
        uniqueIndex('webauthn_challenge_hash_idx').on(table.challengeHash),

        // Sweeping expired rows scans by expiry
        index('webauthn_challenges_expires_at_idx').on(table.expiresAt),
    ],
);

// Type exports
export type WebAuthnChallenge = typeof webauthnChallenges.$inferSelect;
export type NewWebAuthnChallenge = typeof webauthnChallenges.$inferInsert;
