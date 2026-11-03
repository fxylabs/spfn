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

const requestTenantStore = new AsyncLocalStorage<number>();

/** Run `next` with `tenantId` as the request's tenant. */
export function runWithRequestTenant<T>(tenantId: number, next: () => Promise<T>): Promise<T>
{
    return requestTenantStore.run(tenantId, next);
}

/** The tenant a guard authorized this request for, or undefined outside a guarded request. */
export function requestTenant(): number | undefined
{
    return requestTenantStore.getStore();
}

/** Throw when a guard authorized this request for a tenant other than `tenantId`. */
export function assertRequestTenant(tenantId: number): void
{
    const guarded = requestTenantStore.getStore();

    if (guarded !== undefined && guarded !== tenantId)
    {
        throw new TenantMismatchError(guarded, tenantId, 'guard');
    }
}
