/**
 * @spfn/auth - Device Links Entity
 *
 * Backs device link: the mirror image of device-code login. A device that is
 * already signed in (the issuer) asks for a short code and shows it; a new
 * device with no key on file reads it, parks its public key here, and shows a
 * two-digit match number; the issuer picks that number out of three, and the
 * new device's next poll registers the parked key under the issuer's account.
 *
 * A separate table from `device_authorizations` rather than a mode of it. The
 * two records are owned from opposite ends — a device authorization gains an
 * account only when someone approves it, a link has one from the moment it is
 * issued, and is bound to the issuing key as well — and folding them together
 * would leave every column meaning one thing in one flow and something else in
 * the other.
 *
 * The parked key material duplicates the `user_public_keys` columns for the
 * reason `device_authorizations` gives: a row there can sign requests, and
 * nothing here has been confirmed yet.
 *
 * Nothing sweeps this table. Rows are judged by `expiresAt` and by the issuing
 * key on read, so a stale row authorizes nothing.
 */

import { integer, text, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { id, timestamps, enumText, utcTimestamp, foreignKey } from '@spfn/core/db';
import { KEY_ALGORITHM, KEY_PLATFORM } from '../types';
import { users } from './users';
import { authSchema } from './schema';

/**
 * Lifecycle of one device link.
 *
 * `issued -> redeemed -> approved -> consumed` is the only path to a registered
 * key. `denied` is a refusal the new device is told about — the issuer said no,
 * or picked the wrong number. `expired` is a link its issuer abandoned: a newer
 * one issued from the same key, a cancel, or a global revocation of the account.
 * A link whose TTL ran out, or whose issuing key was revoked, is judged expired
 * on read without the status having to say so.
 */
export const DEVICE_LINK_STATUSES = ['issued', 'redeemed', 'approved', 'denied', 'consumed', 'expired'] as const;
export type DeviceLinkStatus = typeof DEVICE_LINK_STATUSES[number];

export const deviceLinks = authSchema.table('device_links',
    {
        id: id(),

        // The issuer's handle on the record, returned by issue and named by
        // status, confirm, deny and cancel
        // Random rather than the row id so a handle says nothing about how many
        // links exist; it authorizes nothing without the issuing key beside it
        linkId: text('link_id').notNull().unique(),

        // The code the issuer shows and the new device sends back
        // Stored normalized — uppercase, no dash — as device_authorizations does
        // Plaintext on purpose: redeeming it registers nothing until the issuer
        // picks the match number the redeeming device shows
        userCode: text('user_code').notNull(),

        // The account the new device joins, written at issue time from the
        // issuer's session. Never taken from a request body
        issuerUserId: foreignKey('issuer_user', () => users.id, { onDelete: 'cascade' }),

        // The key that signed the issue request
        // Only requests signed by this key can see or answer the link, and the
        // link is judged expired once this key is revoked or runs out
        issuerKeyId: text('issuer_key_id').notNull(),

        // SHA-256 of the device code, hex — set at redeem, null before
        // The code itself is returned to the redeeming device once and never stored
        deviceCodeHash: text('device_code_hash').unique(),

        // Key material the redeeming device generated, same shapes as user_public_keys
        // null until redeem; parked, not registered, until a poll moves it over
        publicKey: text('public_key'),
        keyId: text('key_id'),
        fingerprint: text('fingerprint'),
        algorithm: enumText('algorithm', KEY_ALGORITHM),

        // Labels the redeeming device supplied, shown to the issuer
        // Display only — the match number is what the decision rests on
        deviceName: text('device_name'),
        platform: enumText('platform', KEY_PLATFORM),

        // The number the redeeming device shows, 10–99, drawn at redeem
        // Never sent to the issuer on its own: it is one of `choices`
        matchNumber: integer('match_number'),

        // The three numbers the issuer picks from — the match and two distinct
        // decoys, shuffled once at redeem so every status answer shows the same
        // order
        choices: integer('choices').array(),

        status: enumText('status', DEVICE_LINK_STATUSES).notNull().default('issued'),

        // Expiry — 5 minutes from issue by default
        // Judged on read and in every transition; no job clears the row
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Set when a device redeemed the code
        redeemedAt: utcTimestamp('redeemed_at'),

        // Set when the issuer picked the right number
        approvedAt: utcTimestamp('approved_at'),

        // Set when the poll that registered the key won the race
        consumedAt: utcTimestamp('consumed_at'),

        ...timestamps(),
    },
    (table) => [
        // Lookup path for redeem
        // Unique so a typed code can never address two records
        uniqueIndex('device_link_user_code_idx').on(table.userCode),

        // Issue expires the issuing key's live link before it creates the next one
        index('device_link_issuer_key_idx').on(table.issuerKeyId),

        // A global revocation expires every live link of the account
        index('device_link_issuer_user_idx').on(table.issuerUserId),
    ],
);

// Type exports
export type DeviceLink = typeof deviceLinks.$inferSelect;
export type NewDeviceLink = typeof deviceLinks.$inferInsert;
