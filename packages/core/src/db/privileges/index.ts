/**
 * App privileges: the `appPrivileges` declaration and its manifest
 */

export {
    APP_PRIVILEGES,
    APP_PRIVILEGES_MARKER,
    AppPrivilegesError,
    DEFAULT_APP_PRIVILEGES,
    appPrivileges,
    declaredAppPrivileges,
    isAppPrivilege,
} from './declaration';
export type { AppPrivilege, AppTablePrivileges } from './declaration';

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
