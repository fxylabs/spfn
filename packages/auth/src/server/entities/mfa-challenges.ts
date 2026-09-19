/**
 * @spfn/auth - Second-Factor Challenge Entity
 *
 * One row per registration that was stopped and asked for a second factor: an
 * enrolled account signing in on a device it has never used. The key exists but
 * is inactive, and this row is the only thing that can activate it.
 *
 * The row id is never handed out. `challenge_hash` is the SHA-256 of 32 random
 * bytes minted by `mintCredential()`, the secret goes back in the 202 once, and
 * `verify` looks the row up by hashing what it was given — the same rule the
 * link flows and `webauthn_challenges` follow. A sequence value on an
 * unauthenticated route would let anyone walk it and burn a stranger's five
 * attempts, which under the rules below deletes their pending key.
 *
 * `key_epoch` is the second lock. `revokeActive` already deletes this account's
 * pending keys and expires its live challenges in the statement that revokes
 * everything, but a challenge minted before a generation ended is refused on the
 * epoch alone even if that cleanup were ever missed.
 */

import { index, integer, jsonb, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, enumText, foreignKey, timestamps, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { userPublicKeys } from './user-public-keys';
import { authSchema } from './schema';

/**
 * The four doors a second factor is asked for at.
 *
 * A subset of `DeviceRegistrationChannel`, and the subset is the decision: these
 * are the four where a stolen first credential — a password, a social account, a
 * mailbox — is enough to reach a new device on its own. `device-code` and
 * `passkey` are exempt because each already carried a second proof, and
 * `register`, `signup-link`, `invitation` and `renewal` cannot apply (a
 * brand-new account has nothing enrolled, and a renewal replaces a key on a
 * device that is already signed in).
 */
export const MFA_CHALLENGE_CHANNELS = ['password', 'oauth', 'oauth-native', 'password-reset'] as const;

export type MfaChallengeChannel = typeof MFA_CHALLENGE_CHANNELS[number];

/** How many wrong proofs a challenge survives before it is spent for good. */
export const MFA_CHALLENGE_ATTEMPT_LIMIT = 5;

/**
 * The `authLoginEvent` payload this registration would have emitted.
 *
 * Carried rather than recomputed because it cannot be recomputed: the app's own
 * `metadata` reached the sign-in in a sealed OAuth state or a request body that
 * is gone by the time `verify` runs, and the provider is the social provider on
 * the OAuth channels rather than anything the user row says. Null on
 * `password-reset`, which announces a reset and never a login.
 *
 * `mfaEnrolled` is not stored: the account is enrolled by construction — that is
 * why there is a challenge — and re-reading it at verify keeps the payload
 * honest if the second factor went away in between.
 */
export interface DeferredLoginEvent
{
    provider: string;
    email?: string;
    phone?: string;
    metadata?: Record<string, unknown>;
}

export const mfaChallenges = authSchema.table('mfa_challenges',
    {
        id: id(),

        userId: foreignKey('user', () => users.id),

        // SHA-256 of the 32-byte secret, base64url. The secret leaves the server
        // in the 202 body, the OAuth callback query and the verify request, and
        // is nowhere else — not in a log line and not in this column.
        challengeHash: text('challenge_hash').notNull(),

        // The inactive key this challenge would activate. Cascade, so deleting a
        // pending key — the sweep, five wrong proofs, a global revocation —
        // takes the challenge with it rather than leaving one pointing at
        // nothing.
        keyId: text('key_id')
            .notNull()
            .references(() => userPublicKeys.keyId, { onDelete: 'cascade' }),

        channel: enumText('channel', MFA_CHALLENGE_CHANNELS).notNull(),

        // The account's key generation when this was minted. A challenge from an
        // earlier generation verifies nothing.
        keyEpoch: integer('key_epoch').notNull(),

        // Wrong proofs so far. MFA_CHALLENGE_ATTEMPT_LIMIT of them expire the
        // challenge and delete the pending key.
        attempts: integer('attempts').notNull().default(0),

        // SPFN_AUTH_MFA_CHALLENGE_TTL_MINUTES from creation.
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Set by the verify that spent it, in a conditional UPDATE, so two
        // concurrent verifies produce one winner.
        verifiedAt: utcTimestamp('verified_at'),

        // The login announcement the 202 held back. See DeferredLoginEvent.
        loginEvent: jsonb('login_event').$type<DeferredLoginEvent>(),

        ...timestamps(),
    },
    (table) => [
        // The verify path addresses a row by this alone. Unique so one presented
        // secret can never match two rows.
        uniqueIndex('mfa_challenge_hash_idx').on(table.challengeHash),

        // The sweep and the live-challenge lookups both scan by expiry.
        index('mfa_challenges_expires_at_idx').on(table.expiresAt),
    ],
);

// Type exports
export type MfaChallenge = typeof mfaChallenges.$inferSelect;
export type NewMfaChallenge = typeof mfaChallenges.$inferInsert;
