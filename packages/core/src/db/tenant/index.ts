/**
 * Tenant-aware layer
 *
 * `tenantKey()` (exported with the other schema helpers) marks a table as shared
 * by many tenants; TenantRepository scopes every query it builds to one tenant.
 */

export { TenantRepository } from './tenant-repository';
