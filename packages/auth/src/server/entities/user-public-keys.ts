/**
 * @spfn/auth - User Public Keys Entity
 *
 * Stores client-generated public keys for JWT verification
 * Supports key rotation and multi-key management per user
 */

import { KEY_ALGORITHM, KEY_PLATFORM, SESSION_BINDINGS } from '../types';
import { text, boolean, bigint, index } from 'drizzle-orm/pg-core';
import { id, foreignKey, enumText, utcTimestamp } from '@spfn/core/db';
import { CLIENT_KINDS } from '../client-proof/wire-headers';
import { users } from './users';
import { authSchema } from './schema';

/**
 * User Public Keys Table
 * Each user can have multiple public keys (for rotation)
 */
export const userPublicKeys = authSchema.table(
    'user_public_keys',
    {
        id: id(),

        // User reference
        // Foreign key to users table
        // Used for: associating keys with user accounts
        userId: foreignKey('user', () => users.id),

        // Key identification
        // Client-generated UUID (v4 recommended)
        // Used in: JWT header 'kid' field for key lookup
        // Must be unique across all users
        keyId: text('key_id').notNull().unique(),

        // Public key material
        // Format: Base64-encoded DER (SPKI) format
        // Standards: RFC 5480 (EC), RFC 3447 (RSA)
        // Used for: JWT signature verification
        publicKey: text('public_key').notNull(),

        // Signature algorithm
        // ES256: ECDSA with P-256 and SHA-256 (recommended, smaller keys)
        // RS256: RSA with SHA-256 (fallback, larger keys)
        algorithm: enumText('algorithm', KEY_ALGORITHM).notNull().default('ES256'),

        // Key fingerprint
        // SHA-256 hash of the public key for quick identification
        // Format: hex-encoded string (64 chars)
        // Used for: duplicate detection, key verification
        fingerprint: text('fingerprint').notNull(),

        // Device label the client supplied at registration
        // null: the client sent none (every key registered before this column existed)
        // Used for: telling one entry apart from another in the key list
        // Display only — nothing is authorized by it, so a client that lies gains nothing
        deviceName: text('device_name'),

        // Platform the key lives on, as the client declared it
        // null: the client sent none
        // Used for: the same list, alongside deviceName
        platform: enumText('platform', KEY_PLATFORM),

        // Client address the key was registered from, as getClientIp resolved it
        // null: the request resolved no address, or the key predates this column
        // Written once at registration and never updated — it answers "where did
        // this device appear from", which a later request cannot change
        // Display only, and spoofable on a request that is not proxy-verified
        registeredIp: text('registered_ip'),

        // user-agent header of the registering request, truncated to 512 chars
        // null: the request sent none, or the key predates this column
        // Written once at registration, for the same reason and with the same
        // standing as registeredIp above
        registeredUserAgent: text('registered_user_agent'),

        // Browser family the registering request's user-agent named — one of the
        // five badges uaFamily() answers with, never the raw string
        // null: the request sent no user-agent, or the key predates this column
        // Written once at registration, like the two columns above. The proxy is
        // what compares a family against a request (the browser's user-agent does
        // not survive a server-component hop), so this is the displayable record
        // of where the key came from rather than the value any check reads
        registeredUaFamily: text('registered_ua_family'),

        // Client address this key was last seen signing from, as getClientIp
        // resolved it on that request
        // null: that request resolved no address, or the key predates this column
        //
        // Unlike registeredIp above, this MOVES: it is overwritten by the same
        // throttled UPDATE that stamps lastUsedAt, so it is a new class of stored
        // PII in this table — an address that follows the device around rather
        // than one captured once. It exists for one purpose: to notice that one
        // key was used from two addresses inside a short window, which is what
        // concurrentUseAt records. Nothing else reads it and nothing is refused
        // by it, because addresses change legitimately all the time.
        //
        // It is NOT exposed. `listKeys` returns concurrentUseAt and never this,
        // so the account surface can say "this device was in two places at once"
        // without publishing a trail of where. Retention is the row's: it holds
        // only the most recent observation, is overwritten on the next one, and
        // goes with the key when the key is deleted.
        //
        // The literal string 'unknown' is never stored — getClientIp's fallback
        // becomes NULL, which reads as "no observation" everywhere it is compared.
        lastSeenIp: text('last_seen_ip'),

        // When lastSeenIp was written, which is the same moment lastUsedAt was
        // The pair is what makes "within the window" answerable in one statement
        lastSeenAt: utcTimestamp('last_seen_at'),

        // The last time this key was seen from an address different from the one
        // recorded, within SPFN_AUTH_CONCURRENT_USE_WINDOW_MS of the previous
        // sighting
        // null: never observed, which is the ordinary state for every key
        // Surfaced on listKeys as concurrentUseAtMillis for the owner to act on.
        // A signal, never a refusal — a phone moving between wifi and cellular
        // does this several times an hour, and so does a laptop behind a pool of
        // egress addresses
        concurrentUseAt: utcTimestamp('concurrent_use_at'),

        // Whether this key is bound to a passkey — decided by the server when the
        // key was registered, from the owner's session_binding setting and
        // whether the request came through the trusted Next.js proxy
        // 'none' (default): a 90-day key, the behaviour that predates #97
        // 'passkey': a short-lived key; only a fresh WebAuthn assertion renews it,
        //   and a login that re-registers it does not extend its expiry
        // Never read off a request body, and `platform` is not consulted: that
        // field is display-only and a native client may declare any value it likes
        binding: enumText('binding', SESSION_BINDINGS).notNull().default('none'),

        // What the client said about itself on the last request signed by this key.
        //
        // The three come from x-spfn-client-kind, x-spfn-client-version and
        // x-spfn-client-contract-version. They are client-supplied and
        // unauthenticated, exactly like deviceName above: nothing is authorized by
        // them, and a client that lies about its version gains nothing but a wrong
        // entry in its owner's own device list.
        //
        // They exist so the server knows which release each deployed client runs.
        // Refusing an outdated client is the last resort; reaching its owner first
        // needs a list of who runs what, and announcing a version is not the same
        // as the server having recorded it.
        clientKind: enumText('client_kind', CLIENT_KINDS),
        clientVersion: text('client_version'),
        clientContractVersion: text('client_contract_version'),

        // When any of the three above last changed — an app update, in practice.
        // Not when they were last seen: a value that moves on every request is a
        // write on every request, and the question this answers is "since when has
        // this device been on this release", which only a change can answer.
        clientSeenAt: utcTimestamp('client_seen_at'),

        // Key status
        // false: Key is deactivated (cannot be used for verification)
        // Used for: soft key rotation, temporary key suspension
        isActive: boolean('is_active').notNull().default(true),

        // The second-factor challenge gating this key, when it is pending (#95)
        // null: the ordinary state — the key is whatever `is_active` says it is
        // set: the key was registered inactive because the account has a second
        //   factor and this device is new, and it stays that way until the
        //   challenge is verified. `is_active` alone cannot say this, because a
        //   revoked key is inactive too, and the two must not read alike:
        //   `listKeys` hides a pending key in both modes and a global revocation
        //   deletes it outright rather than revoking it
        // NOT a foreign key, deliberately. `mfa_challenges.key_id` points back at
        // this row, and a pair of constraints in a cycle leaves neither row
        // writable first. The link that decides anything is that one; this column
        // is what makes "is this row pending" a predicate on the keys table
        pendingMfaChallengeId: bigint('pending_mfa_challenge_id', { mode: 'number' }),

        // Key creation timestamp
        // Automatically set on insertion
        createdAt: utcTimestamp('created_at').notNull().defaultNow(),

        // Last usage timestamp
        // Updated each time key is used for JWT verification
        // Used for: tracking key activity, identifying unused keys
        lastUsedAt: utcTimestamp('last_used_at'),

        // Key expiration timestamp (optional)
        // null: Key does not expire
        // timestamp: Key cannot be used after this time
        // Used for: automatic key rotation, security compliance
        expiresAt: utcTimestamp('expires_at'),

        // Key revocation timestamp
        // null: Key is not revoked
        // timestamp: Key was revoked at this time
        // Used for: security incidents, key compromise
        revokedAt: utcTimestamp('revoked_at'),

        // Revocation reason
        // Human-readable explanation for key revocation
        // Example: "Key compromised", "User reported device lost"
        revokedReason: text('revoked_reason'),
    },
    (table) => [
        index('user_public_keys_user_id_idx').on(table.userId),
        index('user_public_keys_key_id_idx').on(table.keyId),
        index('user_public_keys_active_idx').on(table.isActive),
        index('user_public_keys_fingerprint_idx').on(table.fingerprint),
    ],
);

export type UserPublicKey = typeof userPublicKeys.$inferSelect;
export type NewUserPublicKey = typeof userPublicKeys.$inferInsert;
