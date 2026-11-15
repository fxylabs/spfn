/**
 * @spfn/auth - Account-Exists Notice Entity
 *
 * When an "account already exists" notice last went to an address.
 *
 * A signup attempt on an address that has an account mails its owner a notice
 * instead of a code or a link, at most once per window, so the signup routes
 * cannot be used to mail-bomb the owner. This table is that window and nothing
 * else.
 *
 * Its own table on purpose. The window used to be a row in
 * `verification_codes` — a code that was never sent — and the verify route read
 * it like any other code: its attempt count outlived a resend that, for an
 * address without an account, started a fresh code. "Too many attempts" for one
 * address and "invalid code" for another told the two apart. Nothing that
 * verifies a code reads this table.
 */

import { text } from 'drizzle-orm/pg-core';
import { utcTimestamp } from '@spfn/core/db';
import { authSchema } from './schema';

export const accountExistsNotices = authSchema.table('account_exists_notices',
    {
        // The address in its folded form (trimmed, lower-cased for email), so
        // writing it in another case does not open another window
        target: text('target').primaryKey(),

        // When the last notice was handed to delivery
        sentAt: utcTimestamp('sent_at').notNull(),
    },
);

export type AccountExistsNotice = typeof accountExistsNotices.$inferSelect;
