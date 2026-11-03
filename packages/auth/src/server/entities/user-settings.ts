/**
 * @spfn/auth - User Settings Entity
 *
 * How a person uses the app, one row per (user, key). The profile says who a
 * person is; settings say how they use the app. Keys are declared in code with
 * `defineUserSettings`, and `locale` and `timezone` are built-in keys.
 *
 * A missing row means "the declared default". Writing the default deletes the
 * row, so a deploy that changes a default reaches everyone who never chose.
 */

import { text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, typedJsonb, foreignKey, optionalForeignKey } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

export const userSettings = authSchema.table('user_settings',
    {
        id: id(),

        // Whose setting this is. Cascade: account purge deletes the users row
        // and relies on every per-person table following it
        userId: foreignKey('user', () => users.id),

        // A declared key, e.g. 'locale' or 'notifications.digest'
        key: text('key').notNull(),

        // The value that passed the key's schema when it was written. A schema
        // that allows null stores JSON null, never SQL NULL
        value: typedJsonb<unknown>('value').notNull(),

        // Who wrote the value; the owner themselves on the self-service routes.
        // null once that account is gone
        updatedBy: optionalForeignKey('updated_by', () => users.id),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex('user_settings_user_id_key_idx').on(table.userId, table.key),
    ],
);

export type UserSetting = typeof userSettings.$inferSelect;
export type NewUserSetting = typeof userSettings.$inferInsert;
