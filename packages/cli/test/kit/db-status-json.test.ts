/**
 * `spfn db status --json`, and the Kit port that reads it.
 *
 * The two are tested together on purpose: the report exists only so another
 * program can act on it, and the property that matters is not the shape of
 * either half but that the round trip survives a real stdout — one with a
 * driver's warning and a dotenv notice in it, which is what a child process
 * actually produces.
 *
 * The three answers a caller has to tell apart get their own cases, because
 * collapsing them is the mistake this report exists to prevent: "no database
 * configured", "configured but unreachable" and "read, and here is what is
 * pending" lead to three different decisions in an install.
 */

import { describe, expect, it } from 'vitest';
import {
    DB_STATUS_JSON_MARKER,
    migrationStatusReport,
    unreadableStatusReport,
} from '../../src/commands/db/status.js';
import { readReport, toStatus } from '../../src/kit/local/database.js';
import type { RunResult } from '../../src/kit/local/process.js';

const STATUS = {
    packages: [
        { name: '@spfn/auth', total: 3, applied: 3, pending: 0, pendingTags: [] },
        { name: '@spfn/cms', total: 4, applied: 2, pending: 2, pendingTags: ['0003_posts', '0004_media'] },
    ],
    project: { name: 'project (src/server/drizzle)', total: 2, applied: 1, pending: 1, pendingTags: ['0002_orders'] },
};

function childOutput(stdout: string, exitCode = 0): RunResult
{
    return { exitCode, stdout, stderr: '', missing: false };
}

function printed(report: unknown): string
{
    return `${DB_STATUS_JSON_MARKER}${JSON.stringify(report)}`;
}

describe('the machine-readable migration report', () =>
{
    it('flattens every waiting migration into one identifier per migration', () =>
    {
        const report = migrationStatusReport(STATUS);

        expect(report.pending).toEqual([
            '@spfn/cms/0003_posts',
            '@spfn/cms/0004_media',
            'project (src/server/drizzle)/0002_orders',
        ]);
        expect(report.pendingCount).toBe(3);
    });

    it('keeps the per-target detail beside the flattened list', () =>
    {
        const report = migrationStatusReport(STATUS);

        expect(report.targets.map(target => target.name)).toEqual([
            '@spfn/auth',
            '@spfn/cms',
            'project (src/server/drizzle)',
        ]);
        expect(report.targets[0]).toEqual({ name: '@spfn/auth', total: 3, applied: 3, pending: 0, pendingTags: [] });
    });

    it('reports a project with nothing waiting as read, and empty', () =>
    {
        const report = migrationStatusReport({ packages: [], project: null });

        expect(report).toMatchObject({ configured: true, reachable: true, pendingCount: 0 });
        expect(report.pending).toEqual([]);
        expect(report.reason).toBeUndefined();
    });

    it('tells an unconfigured database apart from an unreachable one', () =>
    {
        expect(unreadableStatusReport('not-configured')).toMatchObject({ configured: false, reachable: false });
        expect(unreadableStatusReport('unreachable')).toMatchObject({ configured: true, reachable: false });
    });

    it('reports a bookkeeping mismatch as its own reason, with its text, never as unreachable', () =>
    {
        expect(unreadableStatusReport('bookkeeping-mismatch', 'id 1 matches no folder')).toEqual({
            schemaVersion: 1,
            configured: true,
            reachable: false,
            reason: 'bookkeeping-mismatch',
            detail: 'id 1 matches no folder',
            targets: [],
            pending: [],
            pendingCount: 0,
        });
        expect(unreadableStatusReport('unreachable')).not.toHaveProperty('detail');
    });
});

describe('reading the report back out of a child process', () =>
{
    it('finds the report among everything else the child printed', () =>
    {
        const noisy = [
            'Loaded env from .env.server',
            'warning: connection pool sized 1',
            printed(migrationStatusReport(STATUS)),
            'Done in 1.2s',
        ].join('\n');

        expect(readReport(childOutput(noisy))?.pendingCount).toBe(3);
    });

    it('takes the last report when a child somehow printed two', () =>
    {
        const twice = [
            printed(unreadableStatusReport('unreachable')),
            printed(migrationStatusReport(STATUS)),
        ].join('\n');

        expect(readReport(childOutput(twice))?.reachable).toBe(true);
    });

    it('reports nothing readable rather than guessing', () =>
    {
        expect(readReport(childOutput('no marker here at all'))).toBeNull();
        expect(readReport(childOutput(`${DB_STATUS_JSON_MARKER}{not json`))).toBeNull();
        expect(readReport(childOutput(printed({ schemaVersion: 2 })))).toBeNull();
    });

    it('hands the port a bookkeeping mismatch with its text, so the Kit can refuse on it', () =>
    {
        const report = readReport(childOutput(printed(unreadableStatusReport('bookkeeping-mismatch', 'id 1 matches no folder'))));

        expect(toStatus(report)).toEqual({
            configured: true,
            reachable: false,
            applied: [],
            pending: [],
            bookkeepingMismatch: 'id 1 matches no folder',
        });
        expect(toStatus(unreadableStatusReport('unreachable'))).not.toHaveProperty('bookkeepingMismatch');
    });

    it('turns a child that said nothing usable into "cannot be read"', () =>
    {
        expect(toStatus(null)).toEqual({ configured: false, reachable: false, applied: [], pending: [] });
    });

    it('hands the port the pending list it branches on, and counts as evidence', () =>
    {
        const status = toStatus(migrationStatusReport(STATUS));

        expect(status).toMatchObject({ configured: true, reachable: true });
        expect(status.pending).toHaveLength(3);
        expect(status.applied).toEqual([
            '@spfn/auth 3/3',
            '@spfn/cms 2/4',
            'project (src/server/drizzle) 1/2',
        ]);
    });
});
