/**
 * Which requests a restricted session may make
 *
 * A session is restricted while its account has a requirement outstanding — a
 * password to change (#362), a second factor to enrol (#309). The global
 * `authenticate` middleware then has to know whether the request in front of
 * it is one that requirement admits. What makes it one is which route
 * definition matched — not the path the request named, which a prefix mount
 * (`root.route('/api', app)`) changes without changing the route.
 *
 * So the classification puts a marker on each route a restricted session may
 * reach, as one of the route's own middlewares (`restrictedRouteMarker`),
 * carrying which requirements admit it, and the middleware looks for that
 * marker among the handlers Hono matched for this request, inside the route
 * chain it is itself running in (`restrictedRouteAdmits`). The marker is a
 * function object this module mints and never hands to anything but the
 * router, so the only way onto a route is the classification.
 *
 * Only a registered gate may be exempted by a marker (`registerEnrolmentGate`)
 * — `authenticate`, the middleware every marked route runs, registers its
 * own handler. Another producer of a person principal asking from its own
 * place in a chain (`optionalAuth`, `opsOrUser`, a one-time token) is answered
 * no, wherever it stands.
 *
 * Why nothing else can satisfy it:
 *
 * - an app route at a marked route's path on another method is never
 *   matched for this request, so its handlers are not in the list at all;
 * - an app route at the same path and method is registered before the package
 *   routes (core registers an app's own routes first), so it runs first — and
 *   its chain ends where the next chain's `authenticate` begins, which is where
 *   the search stops;
 * - an app `'*'` middleware is matched under its own path and method `ALL`, and
 *   the search never leaves the entries of this route's path and method;
 * - a path no route matched never runs `authenticate`, which is a route-level
 *   middleware in core, and answers 404.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { RouterRoute } from 'hono/types';
import { matchedRoutes } from 'hono/route';
import { COMPOSED_HANDLER } from 'hono/utils/constants';

import { assertRequestFromThisHono } from './hono-copy';
import { isMethodListed, type SecondFactorMethod } from './second-factor-policy';

/**
 * What an account can be held to before its session may do anything else, in
 * the order a refusal names them: the password first, since changing it is the
 * one thing an operator-seeded account must do before anything else.
 */
export const SESSION_REQUIREMENTS = ['passwordChange', 'secondFactorEnrolment'] as const;

export type SessionRequirement = typeof SESSION_REQUIREMENTS[number];

/**
 * What an enrolment route needs listed to be one: a method, or nothing.
 *
 * `null` for a route every enrolment-only session reaches (`mfaStatus`,
 * `getAuthSession`, `logout`, the step-up pair), and for a route whose own
 * method gate answers an unlisted method with its 404 — that gate, not this
 * middleware, is the refusal there.
 */
export type EnrolmentRequirement = SecondFactorMethod | null;

/**
 * Which requirements a marked route admits a session held to: under
 * `secondFactorEnrolment` while its method is listed (`null`: always), and
 * under `passwordChange` when true. A requirement absent is one the route
 * does not admit.
 */
export interface RestrictedRouteAdmission
{
    secondFactorEnrolment?: EnrolmentRequirement;
    passwordChange?: true;
}

/** Every marker minted, and what it admits. Module state: nothing outside reads or adds to it. */
const MARKERS = new WeakMap<Function, RestrictedRouteAdmission>();

/** The middlewares a marker answers to. */
const GATES = new WeakSet<Function>();

/** Called once by `authenticate` at import, with its own handler. */
export function registerEnrolmentGate(handler: MiddlewareHandler): void
{
    GATES.add(handler);
}

/** Whether `handler` is a registered gate — the place a route's marker has to follow. */
export function isEnrolmentGate(handler: Function): boolean
{
    return GATES.has(registeredHandler(handler));
}

/**
 * A fresh marker for one route a restricted session may reach: a middleware
 * that does nothing but pass the request on, recognised later by identity.
 */
export function restrictedRouteMarker(admits: RestrictedRouteAdmission): MiddlewareHandler
{
    const marker: MiddlewareHandler = async (_c, next) =>
    {
        await next();
    };

    MARKERS.set(marker, admits);

    return marker;
}

/**
 * The handler as it was registered.
 *
 * `app.route()` wraps every handler of a sub-app that has its own error
 * handler, and keeps the original under `COMPOSED_HANDLER`; a mount inside a
 * mount wraps the wrapper.
 */
function registeredHandler(handler: Function): Function
{
    const composed = (handler as { [COMPOSED_HANDLER]?: Function })[COMPOSED_HANDLER];

    return composed === undefined ? handler : registeredHandler(composed);
}

/**
 * The handlers Hono matched for this request.
 *
 * `matchedRoutes` reads them off the request under a symbol private to the copy
 * of Hono that built it. Within one copy a request always carries them, so a
 * request it cannot read was built by another copy (see `hono-copy.ts`) — a
 * broken process, refused as an error. It used to read as "no enrolment route",
 * which answered every enrolment-only session 403 on the very routes it may use,
 * as if that were policy.
 */
function readMatchedRoutes(c: Context): RouterRoute[]
{
    assertRequestFromThisHono(c);

    return matchedRoutes(c);
}

/**
 * Whether the route this request matched admits a session held to
 * `requirement` — for `secondFactorEnrolment`, under the policy in force.
 *
 * Read from the middleware that calls it, which must be a registered gate: the
 * search starts after the entry Hono is running (`c.req.routeIndex`) and stays
 * inside that route's chain — the entries of the same method and path, up to
 * the next appearance of the gate, which is where the next route at this path
 * begins, since every route behind the gate runs it before its own middlewares.
 *
 * @throws Error when the request was built by another copy of Hono, whose match
 *   result cannot be read
 */
export function restrictedRouteAdmits(c: Context, requirement: SessionRequirement): boolean
{
    const routes = readMatchedRoutes(c);
    const self = routes[c.req.routeIndex];

    if (self === undefined)
    {
        return false;
    }

    const caller = registeredHandler(self.handler);

    if (!GATES.has(caller))
    {
        return false;
    }

    for (const entry of routes.slice(c.req.routeIndex + 1))
    {
        const handler = registeredHandler(entry.handler);

        if (entry.method !== self.method || entry.path !== self.path || handler === caller)
        {
            return false;
        }

        if (MARKERS.has(handler))
        {
            return admitsUnder(MARKERS.get(handler)!, requirement);
        }
    }

    return false;
}

/** Whether a marker's admission covers `requirement` now. */
function admitsUnder(admits: RestrictedRouteAdmission, requirement: SessionRequirement): boolean
{
    if (requirement === 'passwordChange')
    {
        return admits.passwordChange === true;
    }

    const requires = admits.secondFactorEnrolment;

    return requires === null || (requires !== undefined && isMethodListed(requires));
}
