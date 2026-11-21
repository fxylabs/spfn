/**
 * `spfn db push` ends at the `connect` stage when the database cannot be
 * reached (#405)
 *
 * C1, C2: the owner's URL points at a dead port. Push, and its dry run (whose
 * connection reads `transaction_read_only` as it opens), exit 1 with the
 * stage's line and the error as `describeFailure` prints it — no stack, no URL
 * and no password (Codex's probe on #421: the driver's error reached the
 * top-level handler, stack and all). No database is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const { dbPush } = await import('../push.js');

const OWNER_PASSWORD = 'owner-secret-pw';
const DEAD_URL = `postgresql://app_owner:${OWNER_PASSWORD}@127.0.0.1:1/notes`;

describe('db push on a database it cannot reach', () =>
{
    const previousCwd = process.cwd();
    let root: string;
    let printed: string[];

    beforeEach(() =>
    {
        root = mkdtempSync(join(__dirname, 'tmp-push-connect-'));
        process.chdir(root);
        printed = [];
        process.env.DATABASE_URL = DEAD_URL;
        process.env.DATABASE_OWNER_URL = DEAD_URL;

        const entities = join(root, 'src', 'server', 'entities');

        mkdirSync(entities, { recursive: true });
        writeFileSync(join(entities, 'app.entity.ts'),
            "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
            + "export const app = pgSchema('i405_connect');\n"
            + "export const notes = app.table('notes', { id: integer('id').primaryKey() });\n");

        for (const method of ['log', 'error', 'warn', 'info'] as const)
        {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        }
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    it.each([
        { row: 'C1', name: 'push', dryRun: false },
        { row: 'C2', name: '--dry-run', dryRun: true },
    ])('$row $name: exit 1, the connect stage\'s line, no stack, no URL', async ({ dryRun }) =>
    {
        await expect(dbPush({ dryRun, schema: './src/server/entities/app.entity.ts' })).rejects.toThrow('exit 1');

        const output = printed.join('\n');

        expect(output).toContain('❌ Could not connect to the database — nothing was planned or applied: could not reach the database (ECONNREFUSED)');
        expect(output).not.toMatch(/\n\s+at |postgresql:|app_owner|127\.0\.0\.1:1\b/);
        expect(output).not.toContain(OWNER_PASSWORD);
    });
});
