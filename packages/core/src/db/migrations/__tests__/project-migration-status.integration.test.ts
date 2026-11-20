/**
 * Project migration status is drizzle's own rule (#370)
 *
 * `collectMigrationStatus` (db status, the boot gate, health) must report as
 * pending exactly the project migrations `spfn db migrate` — drizzle-orm's
 * migrator — then runs, and must fail exactly when migrate refuses. Each case
 * reads the status, runs the real migrator on the same database and compares.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    collectMigrationStatus,
    MigrationBookkeepingMismatchError,
    projectMigrationsDir,
    type MigrationStatusDb,
} from '../index';
import { TEST_DATABASE_URL } from '../../__tests__/helpers/db-fixture';

const A = '20260101000000_a';
const B = '20260102000000_b';
const C = '20260103000000_c';
const D = '20260104000000_d';

/** Local folder name → its SQL; a distinct comment gives each a distinct hash. */
type Folders = Record<string, string>;

/** Bookkeeping rows: version 1 carries names, version 0 (before drizzle-orm 1.0) does not. */
type Bookkeeping =
    | { version: 1; rows: { name: string; sql: string }[] }
    | { version: 0; rows: { createdAt: string; sql: string }[] };

type Outcome = { pending: string[] } | { refused: true };

type Case = {
    title: string;
    folders: Folders;
    bookkeeping?: Bookkeeping;
    journal?: true;
    expected: Outcome;
};

const sqlOf = (name: string): string => `SELECT 1; -- ${name}`;
const hashOf = (sql: string): string => createHash('sha256').update(sql).digest('hex');
const stampOf = (name: string): number => Date.UTC(
    Number(name.slice(0, 4)), Number(name.slice(4, 6)) - 1, Number(name.slice(6, 8)),
    Number(name.slice(8, 10)), Number(name.slice(10, 12)), Number(name.slice(12, 14)),
);
const foldersOf = (...names: string[]): Folders => Object.fromEntries(names.map(name => [name, sqlOf(name)]));
const applied = (...names: string[]): Bookkeeping => ({ version: 1, rows: names.map(name => ({ name, sql: sqlOf(name) })) });
const appliedBeforeV1 = (...names: string[]): Bookkeeping => ({
    version: 0,
    rows: names.map(name => ({ createdAt: String(stampOf(name) + 123), sql: sqlOf(name) })),
});

const CASES: Case[] = [
    {
        title: 'a fresh database: every migration pending',
        folders: foldersOf(A, B),
        expected: { pending: [A, B] },
    },
    {
        title: 'an older-stamped migration never applied is pending',
        folders: foldersOf(A, B, C),
        bookkeeping: applied(A, C),
        expected: { pending: [B] },
    },
    {
        title: 'a folder renamed after it was applied is pending again',
        folders: { [A]: sqlOf(A), '20260104000000_renamed_d': sqlOf(D) },
        bookkeeping: applied(A, D),
        expected: { pending: ['20260104000000_renamed_d'] },
    },
    {
        title: 'a recorded migration with no local folder is ignored',
        folders: foldersOf(A),
        bookkeeping: applied(A, D),
        expected: { pending: [] },
    },
    {
        title: 'SQL edited after it was applied is not pending (the hash is never compared)',
        folders: { [A]: `${sqlOf(A)} -- edited` },
        bookkeeping: applied(A),
        expected: { pending: [] },
    },
    {
        title: 'version 0: rows matched by their stamp truncated to the second',
        folders: foldersOf(A, B, C),
        bookkeeping: appliedBeforeV1(A, B),
        expected: { pending: [C] },
    },
    {
        title: 'version 0: a row whose SQL was edited since is matched by its stamp alone',
        folders: { [A]: `${sqlOf(A)} -- edited`, [B]: sqlOf(B) },
        bookkeeping: appliedBeforeV1(A),
        expected: { pending: [B] },
    },
    {
        title: 'version 0: an older-stamped migration never applied is pending',
        folders: foldersOf(A, B, C),
        bookkeeping: appliedBeforeV1(A, C),
        expected: { pending: [B] },
    },
    {
        title: 'version 0: folders sharing a second are told apart by hash',
        folders: foldersOf('20260101000000_a1', '20260101000000_a2'),
        bookkeeping: { version: 0, rows: [{ createdAt: String(stampOf(A)), sql: sqlOf('20260101000000_a2') }] },
        expected: { pending: ['20260101000000_a1'] },
    },
    {
        title: 'version 0: a row whose stamp matches no folder is matched by hash',
        folders: { '20260109000000_a_moved': sqlOf(A) },
        bookkeeping: appliedBeforeV1(A),
        expected: { pending: [] },
    },
    {
        title: 'version 0: a row that matches no folder is refused',
        folders: foldersOf(A, B),
        bookkeeping: appliedBeforeV1(A, D),
        expected: { refused: true },
    },
    {
        title: 'the drizzle-kit ≤0.31 journal layout is refused',
        folders: foldersOf(A),
        journal: true,
        expected: { refused: true },
    },
];

function makeProject(testCase: Case): string
{
    const cwd = mkdtempSync(join(tmpdir(), 'spfn-project-status-'));
    const dir = projectMigrationsDir(cwd);

    for (const [name, sql] of Object.entries(testCase.folders))
    {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, 'migration.sql'), sql);
    }

    if (testCase.journal)
    {
        mkdirSync(join(dir, 'meta'), { recursive: true });
        writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [] }));
    }

    return cwd;
}

describe('project migration status agrees with drizzle-orm migrate', () =>
{
    const owner = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    const db = drizzle({ client: owner });
    let available = false;
    let cwd: string;

    beforeAll(async () =>
    {
        available = await owner`select 1`.then(() => true, () => false);
    });

    afterAll(async () =>
    {
        await owner.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`).catch(() => undefined);
        await owner.end();
    });

    beforeEach(async (context) =>
    {
        if (!available)
        {
            context.skip();
        }

        await owner.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    });

    afterEach(() =>
    {
        rmSync(cwd, { recursive: true, force: true });
    });

    async function record(bookkeeping: Bookkeeping): Promise<void>
    {
        const nameColumn = bookkeeping.version === 1 ? ', name text, applied_at timestamptz DEFAULT now()' : '';

        await owner.unsafe(`CREATE SCHEMA drizzle`);
        await owner.unsafe(`CREATE TABLE drizzle.__drizzle_migrations (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint${nameColumn})`);

        for (const row of bookkeeping.rows)
        {
            await ('name' in row
                ? owner`INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name)
                    VALUES (${hashOf(row.sql)}, ${stampOf(row.name)}, ${row.name})`
                : owner`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
                    VALUES (${hashOf(row.sql)}, ${row.createdAt})`);
        }
    }

    async function statusOutcome(): Promise<Outcome>
    {
        return collectMigrationStatus(db as unknown as MigrationStatusDb, cwd).then(
            status => ({ pending: status.project?.pendingTags ?? [] }),
            (error: unknown) =>
            {
                expect(error).toBeInstanceOf(MigrationBookkeepingMismatchError);

                return { refused: true as const };
            },
        );
    }

    /** What the migrator ran: the rows it added after the ones already recorded. */
    async function migrateOutcome(): Promise<Outcome>
    {
        const [{ last }] = await owner<{ last: number }[]>`
            SELECT coalesce(max(id), 0) AS "last" FROM drizzle.__drizzle_migrations`.catch(() => [{ last: 0 }]);
        const refused = await migrate(db, { migrationsFolder: projectMigrationsDir(cwd) })
            .then(() => false, () => true);

        if (refused)
        {
            return { refused: true };
        }

        const ran = await owner<{ name: string }[]>`
            SELECT name FROM drizzle.__drizzle_migrations WHERE id > ${last} ORDER BY id`;

        return { pending: ran.map(row => row.name) };
    }

    it.each(CASES)('S5 $title', async (testCase) =>
    {
        cwd = makeProject(testCase);

        if (testCase.bookkeeping)
        {
            await record(testCase.bookkeeping);
        }

        const status = await statusOutcome();
        const ran = await migrateOutcome();

        expect(ran).toEqual(testCase.expected);
        expect(status).toEqual(ran);
    });
});
