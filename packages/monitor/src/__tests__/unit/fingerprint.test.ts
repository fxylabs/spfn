/**
 * @spfn/monitor - Fingerprint Tests (#382)
 *
 * A group is one fault: the route path, each link of the cause chain by its
 * name, code, constraint and table, and the top three frames without their
 * line and column. The message is not part of it — a failed statement's
 * message carries its bound values.
 *
 * That one fault with other bound values is one group is row M2 of
 * `error-text.test.ts`: it takes `trackError`, where the message used to go in.
 *
 * | #  | goes unnoticed without the row                                                    |
 * | -- | --------------------------------------------------------------------------------- |
 * | F1 | distinct faults merged into one group (constraint, path or frames dropped)        |
 * | F2 | every deploy that shifts a line opening a new group for each known fault         |
 * | F3 | every deploy to a new release directory opening a new group for each known fault  |
 * | F4 | every dependency bump (pnpm's `<name>@<version>_<hash>` directory) doing the same |
 * | F5 | the location stripped too far: one function name in two files merged             |
 * | F6 | an ESM frame (`file://` URL) under a directory with a space: percent-encoded, so never inside the working directory |
 * | F7 | an ESM frame of a Windows process (`file:///C:/…`) kept whole: a new group per release directory |
 * | F8 | a working directory of `/`: no frame counted inside it, so the absolute path stays (the check looked for `//`) |
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeError } from '@spfn/core/logger';
import { DrizzleQueryError } from 'drizzle-orm';
import { generateFingerprint } from '../../server/services/error-tracking.service';

const FRAMES = '    at insertUser (/app/users.js:10:5)\n    at register (/app/auth.js:20:7)\n    at handle (/app/route.js:30:9)';

/** A postgres.js 23505 under drizzle's query error, its stack the given frames */
function uniqueViolation(email: string, constraint = 'users_email_key', frames = FRAMES): Error
{
    const driverError = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
        name: 'PostgresError',
        severity: 'ERROR',
        code: '23505',
        detail: `Key (email)=(${email}) already exists.`,
        table_name: 'users',
        constraint_name: constraint,
        routine: '_bt_check_unique',
    });
    const error = new DrizzleQueryError('insert into "users" ("email") values ($1)', [email], driverError);
    error.stack = `${error.name}: ${error.message}\n${frames}`;

    return error;
}

function fingerprintOf(error: Error, path = '/api/users'): string
{
    return generateFingerprint(describeError(error), path);
}

describe('generateFingerprint', () =>
{
    it('F1: another constraint, path or call site is another group', () =>
    {
        const first = fingerprintOf(uniqueViolation('a@example.test'));

        expect(first).toMatch(/^[0-9a-f]{16}$/);
        const elsewhere = FRAMES.replace('insertUser', 'importUsers');

        expect(fingerprintOf(uniqueViolation('a@example.test', 'users_phone_key'))).not.toBe(first);
        expect(fingerprintOf(uniqueViolation('a@example.test'), '/api/admins')).not.toBe(first);
        expect(fingerprintOf(uniqueViolation('a@example.test', 'users_email_key', elsewhere))).not.toBe(first);
    });

    it('F2: the same call site on other lines is one group', () =>
    {
        const shifted = FRAMES.replace('users.js:10:5', 'users.js:14:9');

        expect(fingerprintOf(uniqueViolation('a@example.test', 'users_email_key', shifted)))
            .toBe(fingerprintOf(uniqueViolation('a@example.test')));
    });

    describe('where a frame is', () =>
    {
        afterEach(() =>
        {
            vi.restoreAllMocks();
        });

        /** The fingerprint of one fault raised under `root`, the process running there */
        function deployedAt(root: string, frames = (dir: string) => `    at insertUser (${dir}/dist/users.js:10:5)\n    at async handle (file://${dir}/dist/route.mjs:30:9)`): string
        {
            vi.spyOn(process, 'cwd').mockReturnValue(root);

            return fingerprintOf(uniqueViolation('a@example.test', 'users_email_key', frames(root)));
        }

        it('F3: the same fault after a deploy to another release directory is one group', () =>
        {
            expect(deployedAt('/srv/releases/20261121')).toBe(deployedAt('/srv/releases/20261120'));
        });

        it('F4: the same fault after a dependency bump, or under npm\'s flat layout, is one group', () =>
        {
            const drizzle = (store: string) => (dir: string) =>
                `    at PgPreparedQuery.execute (${dir}/node_modules/${store}drizzle-orm/pg-core/session.js:41:9)\n`
                + `    at insertUser (${dir}/dist/users.js:10:5)`;
            const before = deployedAt('/srv/app', drizzle('.pnpm/drizzle-orm@0.44.0_postgres@3.4.5_a1b2/node_modules/'));

            expect(deployedAt('/srv/app', drizzle('.pnpm/drizzle-orm@0.45.1_postgres@3.4.7_c3d4/node_modules/'))).toBe(before);
            expect(deployedAt('/srv/app', drizzle(''))).toBe(before);
        });

        it('F6: an ESM frame under a directory with a space names the same place as its path (#382)', () =>
        {
            const esm = (dir: string) => `    at insertUser (file://${dir.replaceAll(' ', '%20')}/dist/users.mjs:10:5)`;
            const plain = (dir: string) => `    at insertUser (${dir}/dist/users.mjs:10:5)`;

            expect(deployedAt('/srv/my app/20261121', esm)).toBe(deployedAt('/srv/my app/20261120', esm));
            expect(deployedAt('/srv/my app/20261121', esm)).toBe(deployedAt('/srv/my app/20261121', plain));
        });

        it('F7: a Windows process\'s ESM frame is relative to its working directory (#382)', () =>
        {
            const esm = (dir: string) => `    at insertUser (file:///${dir.replaceAll('\\', '/')}/dist/users.mjs:10:5)`;

            expect(deployedAt('C:\\releases\\20261121', esm)).toBe(deployedAt('D:\\releases\\20261120', esm));
        });

        it('F8: under a working directory of `/` a frame is relative to it, not left absolute (#382)', () =>
        {
            const at = (dir: string) => `    at insertUser (${dir}/dist/users.js:10:5)`;
            const atRoot = (frame: string) => () => `    at insertUser (${frame}:10:5)`;

            expect(deployedAt('/', atRoot('/dist/users.js'))).toBe(deployedAt('/srv/app', at));
        });

        it('F5: one function name in two files of the app, or of a dependency, is two groups', () =>
        {
            const at = (file: string) => (dir: string) => `    at insertUser (${dir}/${file}:10:5)`;

            expect(deployedAt('/srv/app', at('dist/users.js'))).not.toBe(deployedAt('/srv/app', at('dist/admins.js')));
            expect(deployedAt('/srv/app', at('node_modules/drizzle-orm/pg-core/session.js')))
                .not.toBe(deployedAt('/srv/app', at('node_modules/drizzle-orm/pg-core/query.js')));
        });
    });
});
