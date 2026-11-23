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
export { getDrizzleConfig, detectDialect, drizzleKitSchemaFiles, generateDrizzleConfigFile, renderDrizzleConfig, renderSchemaFilesConfig } from './manager/config-generator';
export type { DrizzleConfigOptions, RenderableDrizzleConfig } from './manager/config-generator';

// Schema Helpers
export * from './schema';

// Migration discovery & status (function packages + project)
export {
    collectMigrationStatus,
    countPendingMigrations,
    DEFAULT_QUEUE_SCHEMA,
    discoverFunctionMigrations,
    formatPendingMigrations,
    functionMigrationsTable,
    hasMigrationTargets,
    isQueueSchemaName,
    JobsDeclarationError,
    MigrationBookkeepingMismatchError,
    migrationTargets,
    MISMATCH_OVERRIDE_NOTE,
    pendingFunctionMigrations,
    pendingMigrationTargets,
    pendingMigrationsSummary,
    projectMigrationsDir,
    readJobsDeclaration,
    readMigrationEntries,
    PROJECT_MIGRATIONS_TABLE,
    PROJECT_TARGET_NAME,
    RUN_MIGRATIONS_HINT,
} from './migrations';
export type {
    FunctionMigrationEntry,
    FunctionMigrationInfo,
    FunctionMigrationSource,
    JobsDeclaration,
    MigrationStatus,
    MigrationStatusDb,
    MigrationTargetStatus,
    PendingFunctionMigrations,
} from './migrations';

// Transaction
export { Transactional, getTransaction, getTransactionContext, runWithTransaction, runInTransaction, onBeforeCommit, onAfterCommit, onAfterRollback } from './transaction';
export type { TransactionContext, TransactionDB, NestedFrameGate, TransactionalOptions, RunInTransactionOptions, BeforeCommitCallback, AfterCommitCallback, AfterRollbackCallback } from './transaction';

// PostgreSQL Error Utilities
export { fromPostgresError, databaseErrorMessage } from './postgres-errors';

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
export type { CountOptions, ReadOptions } from './query-utils';

// App privileges: the per-table declaration, its manifest (privileges.json), and the step that applies them
export {
    APP_PRIVILEGES,
    APP_PRIVILEGES_MANIFEST_FILE,
    APP_PRIVILEGES_MANIFEST_VERSION,
    APP_PRIVILEGES_MARKER,
    AppPrivilegesError,
    AppPrivilegesManifestError,
    DEFAULT_APP_PRIVILEGES,
    BOOKKEEPING_SCHEMA,
    appPrivileges,
    appRelationPrivileges,
    alterOwnerLines,
    applyAppPrivileges,
    catalogRows,
    checkAppPrivileges,
    compareAppPrivileges,
    declaredAppPrivileges,
    foreignOwnedObjects,
    isAppPrivilege,
    planAppPrivileges,
    queueOwnershipTransfer,
    quoteIdentifier,
    reassignOwnedLine,
    readAppPrivilegesManifest,
    readMigrationsAppPrivileges,
    readPrivilegeCatalog,
    renderAppPrivilegesManifest,
    writeAppPrivilegesManifest,
} from './privileges';
export type {
    AppPrivilege,
    AppPrivilegeDrift,
    AppPrivilegeHeldElsewhere,
    AppPrivilegesCheck,
    AppPrivilegesManifest,
    AppPrivilegesPlan,
    AppPrivilegesRun,
    AppPrivilegesTarget,
    AppPublicGrantByOther,
    AppRelation,
    AppRoles,
    AppSchemaDrift,
    AppSchemaPrivilegeHeldElsewhere,
    AppTablePrivileges,
    CatalogColumnGrant,
    CatalogDb,
    CatalogGrant,
    CatalogRelation,
    CatalogRole,
    CatalogSchema,
    ForeignOwnedObject,
    ForeignOwnedRelation,
    ForeignOwnedSchema,
    GrantByOther,
    GrantDb,
    GranteeChange,
    MigrationsAppPrivileges,
    OwnedObject,
    OwnedRelation,
    OwnedSchema,
    PrivilegeCatalog,
    PrivilegeHeldElsewhere,
    PublicGrantByOther,
    QueuePlan,
    RefusedRevoke,
    RelationKind,
    RevokeGrantsByOthers,
    SchemaChange,
    SchemaPrivilegeHeldElsewhere,
} from './privileges';

// Tenant-aware layer (tenantKey() is exported with the schema helpers)
export { TenantRepository, defineTenancy, tenantList, TenantMismatchError, listTenancyTables } from './tenant';
export type {
    Tenancy,
    TenancyOptions,
    TenancyGuardOptions,
    TenancyOnDelete,
    TenancyReferenceOptions,
    TenancyTableOptions,
    TenantListOptions,
    TenantListTable,
    TenantListWhereValue,
    TenantBindingKey,
    TenantSource,
} from './tenant';
