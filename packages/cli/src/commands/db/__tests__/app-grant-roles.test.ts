/**
 * Who the app privileges step grants to (#405, B7) — no database
 *
 * The role is what each app URL connects as (`current_user`), never the URL's
 * user name: behind a pooler that is `role.tenant`, and with
 * DATABASE_WRITE_URL set the server ignores DATABASE_URL. Without these rows a
 * step could grant to a role name that does not exist, to the URL the server
 * does not use, or quietly prefer a stale DATABASE_APP_ROLE over the URL.
 */

import { describe, expect, it } from 'vitest';

import { AppGrantRefusal, resolveGrantRoles } from '../utils/app-grants.js';

const POOLER_URL = 'postgresql://app_user.tenant42:secret@pooler:6543/acme';
const WRITE_URL = 'postgresql://writer:secret@primary:5432/acme';
const READ_URL = 'postgresql://reader:secret@replica:5432/acme';

/** `current_user` as the database would answer for each URL. */
const ROLES: Record<string, string> = { [POOLER_URL]: 'app_user', [WRITE_URL]: 'app_writer', [READ_URL]: 'app_reader' };
const currentUser = async (url: string) => ROLES[url];

describe('resolveGrantRoles', () =>
{
    it('B7 takes the role the URL connects as, not its user name, and says how it was found', async () =>
    {
        expect(await resolveGrantRoles({ DATABASE_URL: POOLER_URL }, currentUser))
            .toEqual({ app: { name: 'app_user', source: 'current_user of DATABASE_URL' } });
    });

    it('B7 prefers DATABASE_WRITE_URL, the URL the server writes with, and adds a read role of its own', async () =>
    {
        expect(await resolveGrantRoles({ DATABASE_URL: POOLER_URL, DATABASE_WRITE_URL: WRITE_URL, DATABASE_READ_URL: READ_URL }, currentUser)).toEqual({
            app: { name: 'app_writer', source: 'current_user of DATABASE_WRITE_URL' },
            read: { name: 'app_reader', source: 'current_user of DATABASE_READ_URL' },
        });
    });

    it('B7 a read URL connecting as the app role adds no read role', async () =>
    {
        expect(await resolveGrantRoles({ DATABASE_URL: POOLER_URL, DATABASE_READ_URL: POOLER_URL }, currentUser))
            .toEqual({ app: { name: 'app_user', source: 'current_user of DATABASE_URL' } });
    });

    it('B7 DATABASE_APP_ROLE names the role only without an app URL; with neither there is none', async () =>
    {
        expect(await resolveGrantRoles({ DATABASE_APP_ROLE: 'app_user' }, currentUser))
            .toEqual({ app: { name: 'app_user', source: 'DATABASE_APP_ROLE' } });
        expect(await resolveGrantRoles({}, currentUser)).toBeUndefined();
    });

    it('B7 DATABASE_APP_ROLE naming another role than the URL is refused, naming both roles and no URL', async () =>
    {
        const refusal = await resolveGrantRoles({ DATABASE_URL: POOLER_URL, DATABASE_APP_ROLE: 'old_app' }, currentUser).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(AppGrantRefusal);
        expect((refusal as Error).message).toContain('DATABASE_APP_ROLE names the role old_app, but DATABASE_URL connects as app_user');
        expect((refusal as Error).message).not.toContain('secret');
    });
});
