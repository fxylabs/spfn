/**
 * Every statement drizzle-kit's push emits that removes an object or a
 * protection waits for the destructive confirmation (spfn/spfn#173). The statements are as
 * drizzle-kit 1.0.0-rc.4's PostgreSQL convertors write them; DROP VIEW has its
 * row against a database (push-no-rename.integration.test.ts, R7).
 */

import { describe, expect, it } from 'vitest';

import { classifyStatement } from '../utils/sql-classifier.js';

describe('sql-classifier', () =>
{
    it.each([
        'DROP MATERIALIZED VIEW "app"."totals";',
        'DROP SEQUENCE "app"."counter";',
        'DROP POLICY "own_rows" ON "app"."notes";',
        'ALTER TABLE "app"."notes" DISABLE ROW LEVEL SECURITY;',
    ])('%s is destructive', (statement) =>
    {
        expect(classifyStatement(statement).category).toBe('destructive');
    });
});
