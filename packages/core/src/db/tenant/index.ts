/**
 * Tenant-aware layer
 *
 * `tenantKey()` (exported with the other schema helpers) marks a table as shared
 * by many tenants; TenantRepository scopes every query it builds to one tenant.
 * `defineTenancy()` adds the database's own enforcement: tenancy tables with
 * composite foreign keys and a row-level security policy, and a route guard.
 */

export { TenantRepository } from './tenant-repository';
export { defineTenancy } from './tenancy';
export type {
    Tenancy,
    TenancyOptions,
    TenancyGuardOptions,
    TenancyReferenceOptions,
    TenantListTable,
} from './tenancy';
export { TenantMismatchError } from './errors';

/** @internal the tenancy boot check (server) reads it through this entry, so it sees the app's registry */
export { listTenancyTables } from './registry';
export type { TenantSource } from './errors';
