/**
 * Database Module Exports
 *
 * Entry point for DB module (Pure re-export only)
 */

// Manager (DB Instance, Factory, Connection)
export {
    createDatabaseFromEnv,
    initDatabase,
    getDatabase,
    setDatabase,
    setDatabaseProvider,
    closeDatabase,
    getDatabaseInfo,
    forceReconnectDatabase,
    createDatabaseConnection,
    checkConnection,
} from './manager';

// Reconnect trigger (query-error driven pool rebuild)
export {
    reportDatabaseError,
    isConnectionLevelError,
    resetConnectionErrorCounter,
} from './manager/reconnect-trigger';

export type {
    DatabaseClients,
    DatabaseInitOptions,
    DatabaseOptions,
    PoolConfig,
    RetryConfig,
    DatabaseProvider,
    DatabaseTransaction,
    DefaultDatabase,
    DrizzleDatabase,
} from './manager';

// Drizzle Config Generator
export { getDrizzleConfig, detectDialect, generateDrizzleConfigFile, renderDrizzleConfig } from './manager/config-generator';
export type { DrizzleConfigOptions, RenderableDrizzleConfig } from './manager/config-generator';

// Schema Helpers
export * from './schema';

// Migration discovery & status (function packages + project)
export {
    collectMigrationStatus,
    countPendingMigrations,
    discoverFunctionMigrations,
    filterPendingEntries,
    formatPendingMigrations,
    functionMigrationsTable,
    hasMigrationTargets,
    migrationTargets,
    pendingMigrationTargets,
    pendingMigrationsSummary,
    projectMigrationsDir,
    readMigrationEntries,
    PROJECT_MIGRATIONS_TABLE,
    PROJECT_TARGET_NAME,
    RUN_MIGRATIONS_HINT,
} from './migrations';
export type {
    FunctionMigrationEntry,
    FunctionMigrationInfo,
    MigrationStatus,
    MigrationStatusDb,
    MigrationTargetStatus,
} from './migrations';

// Transaction
export { Transactional, getTransaction, getTransactionContext, runWithTransaction, runInTransaction, onBeforeCommit, onAfterCommit, onAfterRollback } from './transaction';
export type { TransactionContext, TransactionDB, NestedFrameGate, TransactionalOptions, RunInTransactionOptions, BeforeCommitCallback, AfterCommitCallback, AfterRollbackCallback } from './transaction';

// PostgreSQL Error Utilities
export { fromPostgresError } from './postgres-errors';

// Helper Functions
export {
    findOne,
    findMany,
    create,
    createMany,
    upsert,
    updateOne,
    updateMany,
    deleteOne,
    deleteMany,
    count,
} from './helpers';

// Repository Pattern
export { BaseRepository, RepositoryError } from './repository';
export type { RepositoryDatabase } from './repository';
