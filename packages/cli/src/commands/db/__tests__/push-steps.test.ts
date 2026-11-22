/**
 * Push plans in two steps only on drizzle-kit's own statement that one diff
 * holds a kind both removed and added (spfn/spfn#173). Any other error of
 * pushSchema — one a later drizzle-kit words otherwise included — surfaces
 * as it was thrown, as before #173, and so does that statement when push has
 * already split the kind it names. Of the two steps' statements, only one
 * PostgreSQL refuses is reported as refused; any other error rejects as given.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanConnection } from '../utils/push-steps.js';

const { pushSchema, generateDrizzleJson, generateMigration } = vi.hoisted(() => ({
    pushSchema: vi.fn(),
    generateDrizzleJson: vi.fn(),
    generateMigration: vi.fn(),
}));
vi.mock('drizzle-kit/api-postgres', () => ({ pushSchema, generateDrizzleJson, generateMigration }));
vi.mock('../utils/push-identity.js', () => ({
    existingObjects: async () => [],
    preserveEntityNames: (_existing: unknown, declared: unknown) => declared,
}));

const { planProject } = await import('../utils/push-steps.js');

const AMBIGUITY = new Error('Internal error: resolver(column) was called without a HintsHandler');

/** A connection whose `SAVEPOINT` succeeds and whose first statement of the steps fails with `error` */
function failingOnFirstStatement(error: unknown): PlanConnection
{
    const db = { execute: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error) };

    return { db, inRolledBackTransaction: async work => work(db) };
}

/** A connection whose statements all succeed, its rolled-back transaction run on itself */
function connection(): PlanConnection
{
    const db = { execute: vi.fn(async () => ({ rows: [] })) };

    return { db, inRolledBackTransaction: vi.fn(async work => work(db)) };
}

describe('planProject', () =>
{
    beforeEach(() =>
    {
        vi.resetAllMocks();
        generateDrizzleJson.mockResolvedValue({ ddl: [] });
        generateMigration.mockResolvedValue([]);
    });

    it('an error worded otherwise than drizzle-kit 1.0.0-rc.4 words the ambiguity rejects unchanged, and nothing is split', async () =>
    {
        const error = new Error('resolver(column) was called without a HintsHandler');
        const target = connection();
        pushSchema.mockRejectedValue(error);

        await expect(planProject({}, target, ['public'], [])).rejects.toBe(error);
        expect(target.inRolledBackTransaction).not.toHaveBeenCalled();
    });

    it('a kind drizzle-kit reports again after push split it rejects with drizzle-kit\'s error, unchanged', async () =>
    {
        const error = new Error('Internal error: resolver(column) was called without a HintsHandler');
        pushSchema.mockRejectedValue(error);

        await expect(planProject({}, connection(), ['public'], [])).rejects.toBe(error);
    });

    it('a statement of the steps failing for another reason than PostgreSQL refusing it rejects with that error, unchanged', async () =>
    {
        const error = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
        pushSchema.mockRejectedValueOnce(AMBIGUITY);
        generateMigration.mockResolvedValue(['ALTER TABLE "t" ADD COLUMN "fresh" text;']);

        await expect(planProject({}, failingOnFirstStatement(error), ['public'], [])).rejects.toBe(error);
    });

    it('a statement of the steps PostgreSQL refuses, wrapped as drizzle wraps it, is the plan\'s refusal', async () =>
    {
        const error = new Error('Failed query', { cause: Object.assign(new Error('column "x" does not exist'), { code: '42703', severity: 'ERROR' }) });
        pushSchema.mockRejectedValueOnce(AMBIGUITY);
        generateMigration.mockResolvedValue(['ALTER TABLE "t" ADD COLUMN "fresh" text;']);

        await expect(planProject({}, failingOnFirstStatement(error), ['public'], [])).resolves.toMatchObject({ steps: [], refused: error });
    });
});
