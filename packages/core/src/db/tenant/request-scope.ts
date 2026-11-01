/**
 * The tenant a request was authorized for
 *
 * `tenancy.guard()` runs the rest of the request inside `runWithRequestTenant`,
 * and TenantRepository compares every call's tenant with it (rule R6). It is an
 * AsyncLocalStorage, so two requests in flight at once never see each other's.
 *
 * @internal
 */

import { AsyncLocalStorage } from 'async_hooks';
import { TenantMismatchError } from './errors';

const requestTenant = new AsyncLocalStorage<number>();

/** Run `next` with `tenantId` as the request's tenant. */
export function runWithRequestTenant<T>(tenantId: number, next: () => Promise<T>): Promise<T>
{
    return requestTenant.run(tenantId, next);
}

/** Throw when a guard authorized this request for a tenant other than `tenantId`. */
export function assertRequestTenant(tenantId: number): void
{
    const guarded = requestTenant.getStore();

    if (guarded !== undefined && guarded !== tenantId)
    {
        throw new TenantMismatchError(guarded, tenantId, 'guard');
    }
}
