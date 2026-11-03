/**
 * Tenant errors
 *
 * @internal exported through `@spfn/core/db`
 */

/** Where the tenant a call was checked against came from. */
export type TenantSource = 'transaction' | 'guard';

/** Which binding a call was checked against: `app.tenant_id` or `app.user_id`. */
export type TenantBindingKey = 'tenant' | 'user';

/**
 * A call named a tenant other than the one its transaction or its request is
 * bound to — or, with `key: 'user'`, a user other than the one its transaction
 * is bound to. Thrown before any SQL runs: it is a programming error, not a
 * request a client can correct, so it carries no HTTP status and surfaces as
 * a 500.
 */
export class TenantMismatchError extends Error
{
    readonly expected: number;
    readonly received: number;
    readonly source: TenantSource;
    readonly key: TenantBindingKey;

    constructor(expected: number, received: number, source: TenantSource, key: TenantBindingKey = 'tenant')
    {
        super(mismatchMessage(expected, received, source, key));

        this.name = 'TenantMismatchError';
        this.expected = expected;
        this.received = received;
        this.source = source;
        this.key = key;
    }
}

function mismatchMessage(expected: number, received: number, source: TenantSource, key: TenantBindingKey): string
{
    if (key === 'user')
    {
        return `User ${received} does not match the user ${expected} this transaction is bound to`;
    }

    return source === 'guard'
        ? `Tenant ${received} does not match the tenant ${expected} this request was authorized for by tenancy.guard()`
        : `Tenant ${received} does not match the tenant ${expected} this transaction is bound to`;
}
