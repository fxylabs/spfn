/**
 * pg-boss's lost race on its own install and migration plans
 *
 * Each plan takes pg-boss's advisory lock, so two installs or two migrations
 * of one queue schema run one after the other: the second finds the work
 * done and fails — its install on an object that `already exists`, its
 * migration on the `division by zero` its first statement raises when the
 * schema is already at the version it migrates to. pg-boss's own start
 * ignores exactly those two messages (`contractor.js`); a tool running the
 * plans beside a starting app treats them the same, then reads the version
 * again. The messages are read from the pinned pg-boss, never restated.
 */

import { createRequire } from 'node:module';

const pgBossFile = createRequire(import.meta.url);

/** The messages pg-boss's plans module names its lost races by. */
const { CREATE_RACE_MESSAGE, MIGRATE_RACE_MESSAGE }: { CREATE_RACE_MESSAGE: string; MIGRATE_RACE_MESSAGE: string } = pgBossFile('pg-boss/src/plans.js');

/**
 * Whether `error`, raised running the queue schema's install plan
 * (`queueInstallSql`) or its migration plan (`queueMigrationSql`), is the one
 * pg-boss's own start ignores as a lost race on that plan. Nothing is known
 * then but that another connection held the lock first: read the version
 * again and judge from that.
 */
export function isQueueSchemaRace(error: unknown, plan: 'install' | 'migration'): boolean
{
    const message = error instanceof Error ? error.message : String(error);

    return message.includes(plan === 'install' ? CREATE_RACE_MESSAGE : MIGRATE_RACE_MESSAGE);
}
