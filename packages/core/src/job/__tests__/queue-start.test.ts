/**
 * The boot rule's answer for a queue schema owned by roles the app role is
 * not (#171) — no database: `queueStart` is a pure function of the facts,
 * and these states need a third role, which the integration rows' machines
 * cannot create. What each row keeps from passing unnoticed — a boot that
 * sends the operator in a circle:
 *
 * - O1 an older queue a third role owns whole, the app role none of it: the
 *   boot naming `spfn db migrate` without the role it has to connect as, so
 *   an operator whose DATABASE_OWNER_URL connects as another role runs it,
 *   the owner step prints the transfer and changes nothing, and the boot
 *   names the same command again;
 * - O2 an older queue the app role and a third role own parts of: the
 *   transfer naming the app role's part only, so after it runs the third
 *   role's part still stops the owner step;
 * - O3 an older queue two roles other than the app role own parts of —
 *   a schema a DBA created as one, pg-boss's objects the owner's: the boot
 *   naming `spfn db migrate` (`step` `owner`), whose owner step changes
 *   nothing there, instead of the transfer naming both;
 * - O4 the O3 queue with the bootstrap superuser owning the schema: the
 *   transfer naming REASSIGN OWNED BY that role, which PostgreSQL refuses,
 *   instead of its schema's ALTER … OWNER TO.
 */

import { describe, expect, it } from 'vitest';

import { queueOwnershipTransfer } from '../../db';
import { QUEUE_SCHEMA_VERSION, type QueueSchemaState } from '../queue-schema';
import { queueStart } from '../queue-start';

const SCHEMA = 'spfn_queue';
const APP = 'app_user';

/** An older pg-boss queue the app role may read, owned as `owners` says, the app role's part `ownedBy`. */
function olderQueue(owners: string[], ownedBy: string[] = [], bootstrapOwned: QueueSchemaState['bootstrapOwned'] = []): QueueSchemaState
{
    return {
        schema: SCHEMA,
        exists: true,
        ownsSchema: ownedBy.includes(owners[0]),
        ownsObjects: false,
        ownedBy,
        owners,
        bootstrapOwned,
        usage: true,
        mayCreateOnDatabase: false,
        notPgBoss: false,
        version: QUEUE_SCHEMA_VERSION - 1,
    };
}

function refusal(state: QueueSchemaState)
{
    const start = queueStart(state, APP, true);

    expect(start.kind).toBe('refused');

    return start.kind === 'refused' ? start.error : undefined;
}

describe('queueStart on a queue other roles own', () =>
{
    it('O1 one third role owns all of it: the owner step, naming that role as the one DATABASE_OWNER_URL connects as', () =>
    {
        const error = refusal(olderQueue(['dba']));

        expect(error?.step).toBe('owner');
        expect(error?.message).toContain('Run spfn db migrate (or spfn db push) with DATABASE_OWNER_URL connecting as dba, which owns the schema and every '
            + 'object in it, or as a role that inherits dba, then start again');
    });

    it('O2 the app role and a third role own parts: no step, the transfer naming both', () =>
    {
        const error = refusal(olderQueue([APP, 'dba'], [APP]));

        expect(error?.step).toBeNull();
        expect(error?.message).toContain(`${APP}, dba own the schema or objects in it (${APP} being role ${APP} or a role it inherits)`);
        expect(error?.message).toContain(queueOwnershipTransfer([APP, 'dba'], '<owner>'));
    });

    it('O3 two roles other than the app role own parts: no step, the transfer naming both', () =>
    {
        const error = refusal(olderQueue(['dba', 'app_owner']));

        expect(error?.step).toBeNull();
        expect(error?.message).toContain(`dba, app_owner own the schema or objects in it (none of them role ${APP} or a role it inherits)`);
        expect(error?.message).toContain('REASSIGN OWNED BY dba, app_owner TO <owner>;');
        expect(error?.message).not.toContain('Run spfn db');
    });

    it('O4 the bootstrap superuser owns the schema: its schema given by ALTER … OWNER TO, not REASSIGN OWNED', () =>
    {
        const error = refusal(olderQueue(['postgres', 'app_owner'], [], [{ owner: 'postgres', kind: 'SCHEMA', object: SCHEMA }]));

        expect(error?.step).toBeNull();
        expect(error?.message).toContain('REASSIGN OWNED BY app_owner TO <owner>;');
        expect(error?.message).toContain(`ALTER SCHEMA ${SCHEMA} OWNER TO <owner>;`);
        expect(error?.message).not.toMatch(/REASSIGN OWNED BY [^;]*postgres[^;]* TO/);
    });
});
