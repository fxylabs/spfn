/**
 * @spfn/notification - Push Devices Entity
 *
 * Push tokens the app registered for its users' devices.
 */

import { text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, timestamps, utcTimestamp } from '@spfn/core/db';
import { notificationSchema } from './schema';

export const PUSH_PLATFORMS = ['ios', 'android', 'web'] as const;
export type PushPlatform = typeof PUSH_PLATFORMS[number];

/**
 * Why a token stopped receiving pushes
 */
export const PUSH_INVALIDATION_REASONS = ['unregistered', 'sender_mismatch', 'invalid_token', 'replaced', 'moved'] as const;
export type PushInvalidationReason = typeof PUSH_INVALIDATION_REASONS[number];

export const pushDevices = notificationSchema.table('push_devices',
    {
        id: id(),

        /**
         * The app's user id, as a string. The package does not depend on auth.
         */
        ownerId: text('owner_id').notNull(),

        /**
         * Optional app-side device key. A device has at most one active token:
         * registering a new token for it retires the old one.
         */
        deviceId: text('device_id'),

        platform: text('platform', { enum: PUSH_PLATFORMS }).notNull(),

        /**
         * Token issued by FCM for this app install
         */
        token: text('token').notNull(),

        /**
         * Locale the device's pushes render in (template `locales`)
         */
        locale: text('locale'),

        lastSeenAt: utcTimestamp('last_seen_at').notNull().defaultNow(),

        /**
         * Set when the token must not be sent to any more; null while active
         */
        invalidatedAt: utcTimestamp('invalidated_at'),
        invalidatedReason: text('invalidated_reason', { enum: PUSH_INVALIDATION_REASONS }),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex('push_devices_token_idx').on(table.token),
        index('push_devices_owner_idx').on(table.ownerId),
        uniqueIndex('push_devices_active_device_idx')
            .on(table.deviceId)
            .where(sql`${table.deviceId} is not null and ${table.invalidatedAt} is null`),
    ],
);

export type PushDevice = typeof pushDevices.$inferSelect;
export type NewPushDevice = typeof pushDevices.$inferInsert;
