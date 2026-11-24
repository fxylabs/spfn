// src/server/entities/sign-in-history.ts
import { bigint, boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const signInHistory = pgTable('sign_in_history', {
    id: serial('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }),
    channel: text('channel').notNull(),
    stage: text('stage').notNull(),
    result: text('result').notNull(),
    reason: text('reason'),
    ip: text('ip'),
    webProxy: boolean('web_proxy').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const signInAttempts = pgTable('sign_in_attempts', {
    // An email trimmed and lower-cased, as the package matches it, or a phone as given.
    identifier: text('identifier').primaryKey(),
    attempts: integer('attempts').notNull(),
});
