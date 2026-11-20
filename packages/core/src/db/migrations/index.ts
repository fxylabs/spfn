/**
 * Migration discovery and status — the read-only half of the migration story.
 *
 * `spfn db status`, the server boot gate, the detailed health endpoint and the
 * CLI's push preview and function-package applies all answer "what is applied,
 * what is still waiting?" from here.
 */

export {
    discoverFunctionMigrations,
    functionMigrationsTable,
    readMigrationEntries,
} from './discovery';

export type {
    FunctionMigrationEntry,
    FunctionMigrationInfo,
} from './discovery';

export {
    collectMigrationStatus,
    countPendingMigrations,
    hasMigrationTargets,
    MigrationBookkeepingMismatchError,
    migrationTargets,
    pendingFunctionMigrations,
    pendingMigrationTargets,
    projectMigrationsDir,
    PROJECT_MIGRATIONS_TABLE,
    PROJECT_TARGET_NAME,
} from './status';

export type {
    FunctionMigrationSource,
    MigrationStatus,
    MigrationStatusDb,
    MigrationTargetStatus,
    PendingFunctionMigrations,
} from './status';

export {
    formatPendingMigrations,
    MISMATCH_OVERRIDE_NOTE,
    pendingMigrationsSummary,
    RUN_MIGRATIONS_HINT,
} from './format';
