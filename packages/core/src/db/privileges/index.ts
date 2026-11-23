/**
 * App privileges: the `appPrivileges` declaration, its manifest, and the step
 * that brings the app role to it (plan.ts, catalog.ts)
 */

export {
    APP_COLUMN_PRIVILEGES,
    APP_PRIVILEGES,
    APP_PRIVILEGES_MARKER,
    AppPrivilegesError,
    DEFAULT_APP_PRIVILEGES,
    appPrivileges,
    declaredAppPrivileges,
    isAppPrivilege,
} from './declaration';
export type { AppColumnPrivilege, AppColumnPrivileges, AppPrivilege, AppPrivilegeDeclaration, AppTablePrivileges } from './declaration';

export {
    APP_PRIVILEGES_MANIFEST_FILE,
    APP_PRIVILEGES_MANIFEST_VERSION,
    AppPrivilegesManifestError,
    readAppPrivilegesManifest,
    readMigrationsAppPrivileges,
    renderAppPrivilegesManifest,
    writeAppPrivilegesManifest,
} from './manifest';
export type { AppPrivilegesManifest, MigrationsAppPrivileges } from './manifest';

export { BOOKKEEPING_SCHEMA, appRelationPrivileges, planAppPrivileges, quoteIdentifier } from './plan';
export type {
    AbsentColumns,
    AppPrivilegesPlan,
    AppPrivilegesTarget,
    AppRelation,
    AppRoles,
    CatalogColumnGrant,
    ColumnGrant,
    CatalogGrant,
    CatalogRelation,
    CatalogRole,
    CatalogSchema,
    GrantByOther,
    GranteeChange,
    ForeignOwnedRelation,
    ForeignOwnedSchema,
    PrivilegeCatalog,
    OwnedRelation,
    OwnedSchema,
    PrivilegeHeldElsewhere,
    PublicGrantByOther,
    QueuePlan,
    RelationKind,
    RevokeGrantsByOthers,
    SchemaChange,
    SchemaPrivilegeHeldElsewhere,
} from './plan';

export { applyAppPrivileges, readPrivilegeCatalog } from './catalog';
export type { AppPrivilegesRun, GrantDb, RefusedRevoke } from './catalog';

export { alterOwnerLines, catalogRows, foreignOwnedObjects, queueOwnershipTransfer, reassignOwnedLine } from './ownership';
export type { CatalogDb, ForeignOwnedObject, OwnedObject } from './ownership';

export { checkAppPrivileges, compareAppPrivileges } from './check';
export type {
    AppPrivilegeDrift,
    AppPrivilegeHeldElsewhere,
    AppPrivilegesCheck,
    AppPublicGrantByOther,
    AppSchemaDrift,
    AppSchemaPrivilegeHeldElsewhere,
} from './check';
