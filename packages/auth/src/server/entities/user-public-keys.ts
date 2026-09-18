/**
 * @spfn/auth - User Public Keys Entity
 *
 * Stores client-generated public keys for JWT verification
 * Supports key rotation and multi-key management per user
 */

import { KEY_ALGORITHM, KEY_PLATFORM } from '../types';
import { text, boolean, index } from 'drizzle-orm/pg-core';
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
