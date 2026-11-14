/**
 * Which requests are on a second-factor enrolment route
 *
 * The global `authenticate` middleware has to know whether the request in front
 * of it is one an enrolment-only session may make, and it cannot import the
 * router to find out — the router imports the middleware's module graph, and
 * madge refuses the cycle. So the router hands its resolved set here at import
 * (`registerEnrolmentRoutes`, called by `routes/index.ts`) and the middleware
 * reads it (`isEnrolmentRequest`).
 *
 * Keyed by method and path, which is how the route was registered. Only the
 * routes of `mainAuthRouter` are ever handed in, so a route an application
 * mounts itself is never an enrolment route.
 */

import { isMethodListed, type SecondFactorMethod } from './second-factor-policy';

/**
 * What an enrolment route needs listed to be one: a method, or nothing.
 *
 * `null` for a route every enrolment-only session reaches (`mfaStatus`,
 * `getAuthSession`, `logout`), and for a route whose own method gate answers
 * an unlisted method with its 404 — that gate, not this middleware, is the
 * refusal there.
 */
export type EnrolmentRequirement = SecondFactorMethod | null;

let enrolmentRoutes: ReadonlyMap<string, EnrolmentRequirement> = new Map();

function routeKey(method: string, path: string): string
{
    return `${method.toUpperCase()} ${path}`;
}

/** Called once by the router module at import, with every enrolment route it mounts. */
export function registerEnrolmentRoutes(
    routes: { method: string; path: string; requires: EnrolmentRequirement }[],
): void
{
    enrolmentRoutes = new Map(routes.map(route => [routeKey(route.method, route.path), route.requires]));
}

/** Whether an enrolment-only session may make this request under the policy in force. */
export function isEnrolmentRequest(method: string, path: string): boolean
{
    const key = routeKey(method, path);

    if (!enrolmentRoutes.has(key))
    {
        return false;
    }

    const requires = enrolmentRoutes.get(key)!;

    return requires === null || isMethodListed(requires);
}
