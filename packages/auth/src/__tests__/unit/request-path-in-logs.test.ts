/**
 * No auth log line names the request path except through loggedPath (#489, spfn/spfn#164)
 *
 * `logging.redactPaths` holds only while every line that names the request
 * path reads it through `loggedPath(c)`. Core's scan held core's sources to
 * that and never read auth's, where `authenticate`, `requirePermissions`,
 * `requireAnyPermission`, `requireRole` and `roleGuard` logged `c.req.path`
 * as it came. This is the same scanner, `scripts/lib/request-path-scan.mjs`,
 * over auth's production sources, with auth's own exact lists.
 *
 * The Next.js side has no `loggedPath`: `ctx.path` is the backend path the RPC
 * proxy built from the route's template with the caller's params filled in,
 * and `redactPaths` is a backend option `createServer` applies — the Next.js
 * process never reads it. A line there names the route by its template
 * (`ctx.route.path`), as core's proxy does, or names no path; what it logs of
 * `ctx.path` otherwise is listed below with the reason.
 *
 * | #    | goes unnoticed without the row                                          |
 * | ---- | ----------------------------------------------------------------------- |
 * | A13  | a new auth log line that names the request path itself, past redaction  |
 * | A13b | a path that reaches a log line through a call, unread by A13            |
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { againstList, productionSources, scanFile } from '../../../../../scripts/lib/request-path-scan.mjs';

const authSource = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Logged reads that do not write a path a caller chose. `<file> <expression>`
 * → how many times the file logs it; exact, as core's list is.
 */
const LOGGED_NOT_A_REQUEST = new Map<string, number>([
    // logged only when it equals an entry of the application's CSRF exempt list
    ['nextjs/interceptors/csrf.ts ctx.path', 1],
    // the provider segment of a path the rule matches only as /_auth/oauth/\w+/(url|link)
    ['nextjs/interceptors/oauth.ts provider (ctx.path)', 2],
    ['nextjs/interceptors/oauth.ts ctx.path', 1],
]);

/** Every read of the request path, logged or not. `<file> <expression>` → count; exact. */
const READS = new Map<string, number>([
    // the path the client signed, verified against its proof
    ['server/middleware/auth-profiles.ts c.req.path', 1],
    ['server/client-proof/guard.ts c.req.path', 1],
    // the exempt-list match and its one warning (which logs only a listed entry), the
    // exempt line above, and the route lookup
    ['nextjs/interceptors/csrf.ts ctx.path', 4],
    // the provider segment, above
    ['nextjs/interceptors/oauth.ts ctx.path', 2],
    // which of a rule's paths this request is
    ['nextjs/interceptors/general-auth.ts ctx.path', 3],
    ['nextjs/interceptors/device-login.ts ctx.path', 5],
    ['nextjs/interceptors/login-register.ts ctx.path', 3],
    ['nextjs/interceptors/mfa-verify.ts ctx.path', 3],
    ['nextjs/interceptors/password-reset.ts ctx.path', 3],
    ['nextjs/interceptors/signup-link.ts ctx.path', 3],
]);

describe('request path in auth log lines', () =>
{
    const results = productionSources(authSource).map(file => scanFile(authSource, file));

    it('A13: no auth log call names the request path itself', () =>
    {
        const { unlisted, inexact } = againstList(authSource, results.flatMap(result => result.logged), LOGGED_NOT_A_REQUEST);

        expect(unlisted, 'name the path with loggedPath(c), or the route by its template on the Next.js side').toEqual([]);
        expect(inexact, 'the list names each logged non-request path exactly').toEqual([]);
    });

    it('A13b: every read of the request path in auth is listed', () =>
    {
        const { unlisted, inexact } = againstList(authSource, results.flatMap(result => result.reads), READS);

        expect(unlisted, 'a read that reaches a log line goes through loggedPath(c); one that does not is listed here').toEqual([]);
        expect(inexact, 'the list names each read exactly: drop removed ones, count each expression').toEqual([]);
    });
});
