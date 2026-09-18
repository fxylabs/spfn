/**
 * @spfn/auth - Device Registration Provenance
 *
 * What a registering request said about where it came from: the client address
 * and the `user-agent` header, read once at the top of a route and carried into
 * the key row so the account owner's device list can say "this one appeared
 * from there".
 *
 * Both values are unauthenticated display material. `getClientIp` is documented
 * as best-effort keying material and is spoofable on any request that is not
 * proxy-verified, and a `user-agent` is whatever the caller typed — so nothing
 * in this package decides anything by either one, and neither is ever compared.
 */

import type { Context } from 'hono';
import { getClientIp } from '@spfn/core/middleware';

/**
 * How much of a `user-agent` is kept.
 *
 * Long enough for every real browser and SDK string, short enough that a caller
 * sending a megabyte of header does not write a megabyte of row. Truncation is
 * silent: the value is a label, and a marker would only end up rendered.
 */
export const REGISTERED_USER_AGENT_MAX_LENGTH = 512;

/** Where a device key registration came from, as the request stated it. */
export interface DeviceProvenance
{
    ip?: string;
    userAgent?: string;
}

/**
 * Read the provenance of the request now being handled.
 *
 * Takes the Hono context — a route handler passes `c.raw`, since the route DSL's
 * own `c` is not the context `getClientIp` reads. `'unknown'`, which
 * `getClientIp` answers when nothing resolves, becomes `undefined` and is never
 * stored: a device list showing the literal word to its owner would be claiming
 * to know something it does not.
 */
export function deviceProvenance(c: Context): DeviceProvenance
{
    const ip = getClientIp(c);
    const userAgent = c.req.header('user-agent');

    return {
        ip: ip === 'unknown' ? undefined : ip,
        userAgent: userAgent?.slice(0, REGISTERED_USER_AGENT_MAX_LENGTH),
    };
}
