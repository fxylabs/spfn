/**
 * Where a test plans a push on PGlite: one session, so the transaction that
 * always rolls back runs its `BEGIN`, its statements and its `ROLLBACK` on
 * the same connection, as push's own does on one pg client
 * (createPushConnection).
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import type { PlanConnection } from '../../utils/push-steps.js';

export function planConnectionOn(client: PGlite): PlanConnection
{
    const db = drizzle({ client });

    return {
        db,
        inRolledBackTransaction: async work =>
        {
            await client.exec('BEGIN');
            try
            {
                return await work(db);
            }
            finally
            {
                await client.exec('ROLLBACK');
            }
        },
    };
}
