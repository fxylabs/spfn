/**
 * The app's jobs declaration (#171) — a package.json in a temporary
 * directory, no database
 *
 * A declaration read as "no jobs" skips the owner's queue step without a
 * word, and a queue schema that is another's holds its tables to the queue
 * rule. Each row names what would go unnoticed without it:
 *
 * - J1 (rv432 N2) a malformed `spfn.jobs` — `false`, `null`, an unknown key
 *   beside `schema` — read as no declaration, or as one;
 * - J2 (rv432 B1) `public` or `drizzle` accepted as the queue schema, so the
 *   plan is the only guard left;
 * - J3 (rv432f N1) a keyword (`select`) or a `pg_` name accepted again at the
 *   declaration, failing only later, at install, with PostgreSQL's syntax
 *   error.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobsDeclarationError, readJobsDeclaration } from '../jobs-declaration';

describe('readJobsDeclaration', () =>
{
    let cwd: string;

    const declare = (packageJson: Record<string, unknown>) =>
    {
        writeFileSync(join(cwd, 'package.json'), JSON.stringify(packageJson));

        return () => readJobsDeclaration(cwd);
    };

    beforeEach(() =>
    {
        cwd = mkdtempSync(join(tmpdir(), 'jobs-declaration-'));
    });

    afterEach(() =>
    {
        rmSync(cwd, { recursive: true, force: true });
    });

    it('J1 refuses false, null and an unknown key in spfn.jobs, naming the file and the key', () =>
    {
        for (const jobs of [false, null, { schema: 'app_queue', retries: 3 }])
        {
            expect(declare({ spfn: { jobs } })).toThrow(JobsDeclarationError);
            expect(declare({ spfn: { jobs } })).toThrow(`${join(cwd, 'package.json')}: "spfn.jobs" must be true or { "schema": "<name>" }`);
        }

        expect(declare({ spfn: { jobs: { schema: 'app_queue' } } })()).toEqual({ schema: 'app_queue' });
    });

    it('J2 refuses public and drizzle as the queue schema', () =>
    {
        expect(declare({ spfn: { jobs: { schema: 'public' } } })).toThrow(/"spfn\.jobs\.schema" cannot be the queue schema: "public" holds the project's tables/);
        expect(declare({ spfn: { jobs: { schema: 'drizzle' } } })).toThrow(/"drizzle" holds the project's migration bookkeeping/);
        expect(declare({ spfn: { jobs: true } })()).toEqual({ schema: 'spfn_queue' });
    });

    it('J3 refuses a keyword and a pg_ name as the queue schema', () =>
    {
        for (const schema of ['select', 'pg_queue'])
        {
            expect(declare({ spfn: { jobs: { schema } } })).toThrow(JobsDeclarationError);
            expect(declare({ spfn: { jobs: { schema } } })).toThrow(`"spfn.jobs.schema" "${schema}" is no queue schema name`);
        }
    });
});
