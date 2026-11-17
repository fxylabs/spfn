/**
 * One `hono` for this package and the server that runs it
 *
 * The enrolment gate reads which route a request matched (`matchedRoutes`), and
 * Hono keeps that on the request under a symbol private to the copy of Hono
 * that built it. Within one copy every request carries it. A request built by
 * another copy carries none this package can read — and neither can anything
 * else here that relies on the server's Hono being this package's.
 *
 * Two copies come from two places: `@spfn/core` and this package resolving two
 * installed versions of `hono`, or one installed `hono` evaluated in two module
 * formats — an app run as CommonJS by a TypeScript loader beside a server run
 * as ESM, which `@spfn/core` also refuses at boot.
 */

import { Hono } from 'hono';
import { HonoRequest } from 'hono/request';
import type { Context } from 'hono';

const TWO_COPIES = 'two copies of hono are loaded in this process — the one the server runs on and the one '
    + '@spfn/auth imports. Check that `hono` resolves to one install for the app, @spfn/core and @spfn/auth '
    + '(`pnpm why hono`), and that the server runs as one module format: under `spfn dev` from a spfn CLI of the '
    + 'same release as @spfn/core, or with "type": "module" in the app\'s package.json.';

/** Refuse a boot whose app was built by another Hono than this package's. Called from `afterRoutes`. */
export function assertAppFromThisHono(app: unknown): void
{
    if (!(app instanceof Hono))
    {
        throw new Error(`Refusing to start: @spfn/auth cannot read the server's routes — ${TWO_COPIES}`);
    }
}

/**
 * Refuse a request built by another Hono than this package's — an error, a 500,
 * never an answer that reads as policy.
 */
export function assertRequestFromThisHono(c: Context): void
{
    if (!(c.req instanceof HonoRequest))
    {
        throw new Error(`@spfn/auth cannot read which route this request matched — ${TWO_COPIES}`);
    }
}
