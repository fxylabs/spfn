/**
 * @spfn/auth - Passkeys Entity
 *
 * A WebAuthn credential the account owner enrolled on one of their devices.
 * It is a *credential*, not a session: an assertion proves who is asking, and
 * the ordinary device key in `user_public_keys` is what the request afterwards
 * is signed with. The two tables therefore never stand in for each other.
 *
 * Nothing here is a bearer value, so nothing is hashed. `publicKey` is public by
 * construction and `credentialId` is a handle the authenticator hands to any
 * origin that asks — storing either in the clear costs nothing, and the lookup
 * on `credentialId` has to be a plain equality match on an indexed column.
 *
 * Revocation is soft, and `credentialId` stays unique across live and revoked
 * rows alike: a credential someone cut off must never become enrollable again,
 * on this account or on another one.
 */

import { boolean, integer, index, text } from 'drizzle-orm/pg-core';
import { id, foreignKey, enumText, timestamps, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

/**
 * Whether the credential can leave the authenticator that minted it.
 *
 * `multiDevice` is a synced passkey (iCloud Keychain, Google Password Manager);
 * `singleDevice` is bound to one authenticator. Reported by the authenticator at
 * enrollment and shown in the management list, because "this one is only on that
 * phone" is what the owner needs to know before revoking the other entry.
 */
export const PASSKEY_DEVICE_TYPES = ['singleDevice', 'multiDevice'] as const;

export type PasskeyDeviceType = typeof PASSKEY_DEVICE_TYPES[number];

/** How long a label may be — the key list's `deviceName` bound, for the same reason. */
export const PASSKEY_LABEL_MAX_LENGTH = 64;

export const passkeys = authSchema.table('passkeys',
    {
        id: id(),

        userId: foreignKey('user', () => users.id),

        // The authenticator's credential id, base64url.
        //
        // Unique across the whole table, live and revoked. A revoked row keeps
        // the id reserved forever, so a credential cut off on one account can
        // never be re-enrolled on another (D5).
        credentialId: text('credential_id').notNull().unique(),

        // COSE public key of the credential, base64url.
        // Verification decodes it back to bytes; nothing else reads it.
        publicKey: text('public_key').notNull(),

        // Signature counter last reported by the authenticator.
        // Synced passkeys report 0 forever, which is why a regression refuses
        // the login rather than revoking the row (D11).
        counter: integer('counter').notNull().default(0),

        // Transports the browser said the authenticator speaks ('internal',
        // 'hybrid', 'usb', ...). Passed straight back in `excludeCredentials`
        // as a hint; nothing is authorized by it.
        transports: text('transports').array(),

        deviceType: enumText('device_type', PASSKEY_DEVICE_TYPES).notNull(),

        // Whether a multi-device credential has actually been backed up.
        // Always false for a single-device credential.
        backedUp: boolean('backed_up').notNull().default(false),

        // Authenticator model identifier, as reported. Display and support only
        // — attestation is not verified (D10), so this is what the authenticator
        // claims rather than what it proved.
        aaguid: text('aaguid'),

        // Owner-facing name in the management list ("MacBook Touch ID").
        label: text('label'),

        lastUsedAt: utcTimestamp('last_used_at'),

        // null = live. A timestamp retires the credential permanently; the row
        // stays so its credentialId remains reserved.
        revokedAt: utcTimestamp('revoked_at'),

        revokedReason: text('revoked_reason'),

        ...timestamps(),
    },
    (table) => [
        // The management list and the enrollment exclude-list both scan by owner
        index('passkeys_user_id_idx').on(table.userId),
    ],
);

// Type exports
export type Passkey = typeof passkeys.$inferSelect;
export type NewPasskey = typeof passkeys.$inferInsert;
