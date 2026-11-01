/**
 * Tenant errors
 *
 * @internal exported through `@spfn/core/db`
 */

/** Where the tenant a call was checked against came from. */
export type TenantSource = 'transaction' | 'guard';

/**
 * A call named a tenant other than the one its transaction or its request is
 * bound to. Thrown before any SQL runs: it is a programming error, not a
 * request a client can correct, so it carries no HTTP status and surfaces as
 * a 500.
 */
export class TenantMismatchError extends Error
{
    readonly expected: number;
    readonly received: number;
    readonly source: TenantSource;

    constructor(expected: number, received: number, source: TenantSource)
    {
        super(
            source === 'guard'
                ? `Tenant ${received} does not match the tenant ${expected} this request was authorized for by tenancy.guard()`
                : `Tenant ${received} does not match the tenant ${expected} this transaction is bound to`,
        );

        this.name = 'TenantMismatchError';
        this.expected = expected;
        this.received = received;
        this.source = source;
    }
}
