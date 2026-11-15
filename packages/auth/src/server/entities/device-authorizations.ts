/**
 * @spfn/auth - Device Authorizations Entity
 *
 * Backs device-code login: a device with no key on file yet parks its public key
 * here, shows a short code, and an already-authenticated device approves it. The
 * parked key is registered against the approving user's account when the waiting
 * device polls.
 *
 * The pending key material duplicates the `user_public_keys` columns rather than
 * writing a row there early. A key in `user_public_keys` can sign requests, and
 * nothing about a row here has been approved yet — one table means "registered"
 * and the other means "asked to be", and neither is a state of the other.
 *
 * Nothing sweeps this table. Rows are judged by `expiresAt` on read, so a stale
 * row cannot authorize anything; it only keeps its user code out of circulation,
 * and 31^8 codes do not run out.
 */

import { text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, enumText, utcTimestamp, optionalForeignKey } from '@spfn/core/db';
import { KEY_ALGORITHM, KEY_PLATFORM } from '../types';
import { users } from './users';
import { authSchema } from './schema';

/**
 * Lifecycle of one device-code request.
 *
 * Every transition is one-way and the two terminal states differ: `denied` is a
 * refusal the waiting device is told about, `consumed` is a completed login that
 * answers as if it never existed. `pending -> approved -> consumed` is the only
 * path to a registered key.
 *
 * `denied` is also where a global revocation puts a record — a revoke-all, a
 * password change, a deletion request — including one already approved. The
 * account has withdrawn it, and what the waiting device is owed for that is the
 * answer a refusal gives.
 */
export const DEVICE_AUTH_STATUSES = ['pending', 'approved', 'denied', 'consumed'] as const;
export type DeviceAuthStatus = typeof DEVICE_AUTH_STATUSES[number];

export const deviceAuthorizations = authSchema.table('device_authorizations',
    {
        id: id(),

        // SHA-256 of the device code, hex
        // The code itself (32 random bytes, base64url) is returned to the waiting
        // device once and never stored: it is the only thing that device holds,
        // so a dump of this table must not let its reader finish someone's login
        deviceCodeHash: text('device_code_hash').notNull().unique(),

        // The code a person reads off the waiting device's screen
        // Stored normalized — uppercase, no dash — because that is the only form
        // a lookup can match; the dash is put back for display
        // Plaintext on purpose: it authorizes nothing without an approver who is
        // already authenticated, and it has to be found by exact match
        userCode: text('user_code').notNull(),

        // Key material the waiting device generated, same shapes as user_public_keys
        // Parked, not registered: it can sign nothing until a poll moves it over
        publicKey: text('public_key').notNull(),
        keyId: text('key_id').notNull(),
        fingerprint: text('fingerprint').notNull(),
        algorithm: enumText('algorithm', KEY_ALGORITHM).notNull().default('ES256'),

        // Device labels the waiting device supplied
        // null: it sent none
        // Shown to the approver so they can tell whether the device asking is the
        // one in front of them — display only, so a client that lies gains nothing
        // but a wrong line on the approval screen
        deviceName: text('device_name'),
        platform: enumText('platform', KEY_PLATFORM),

        status: enumText('status', DEVICE_AUTH_STATUSES).notNull().default('pending'),

        // Who approved, written at approve time from the approver's session
        // null while pending, and on every record that was denied or expired
        // Never taken from a request body — that would be the whole authorization
        userId: optionalForeignKey('user', () => users.id, { onDelete: 'cascade' }),

        // The device key the approver signed the approval with, written in the
        // same statement as userId. Collection is refused once it stops being
        // live — revoked, of an ended key generation, or expired — the rule a
        // device link's issuing key is held to. null while pending
        approvedByKeyId: text('approved_by_key_id'),

        // Expiry — 10 minutes from creation by default
        // Judged on read; no job clears the row
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Set when the approver said yes
        approvedAt: utcTimestamp('approved_at'),

        // Set when the poll that registered the key won the race
        // Non-null means the record is spent, whatever else it says
        consumedAt: utcTimestamp('consumed_at'),

        ...timestamps(),
    },
    (table) => [
        // Lookup path for info/approve/deny
        // Unique so a typed code can never address two records
        uniqueIndex('device_authorization_user_code_idx').on(table.userCode),
    ],
);

// Type exports
export type DeviceAuthorization = typeof deviceAuthorizations.$inferSelect;
export type NewDeviceAuthorization = typeof deviceAuthorizations.$inferInsert;
