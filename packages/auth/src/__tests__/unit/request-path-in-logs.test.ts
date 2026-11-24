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
 * (`ctx.route.path`), as core's proxy does, or names no path. No auth line
 * logs `ctx.path` or a piece of it: the CSRF-exempt lines once did, because
 * the path equalled an entry of the application's exempt list (which can name
 * a webhook path carrying a capability), and the OAuth lines logged the
 * `:provider` segment, any `\w+` a caller sends.
 *
 * The scan knows an interceptor context mostly by its declared shape, not its
 * name: a parameter or `const` typed `RequestInterceptorContext` or
 * `ResponseInterceptorContext` (directly, in a union, through `Pick` and the
 * like, or through the file's own type alias), and the first parameter of an
 * interceptor rule's `request`/`response`. The one place it still goes by
 * name: a parameter or `const` named exactly `ctx` with no shape of its own
 * to go by — typed `any`, typed `unknown`, or left with no annotation at all
 * — is a context too, since nothing else gives the scan something to read.
 * A name other than `ctx`, or a `ctx` typed to something concrete that is not
 * one of the known context types, is not. It follows a path handed as an
 * argument of its own to a function the same file declares, into a logger
 * call there. What it does not see — a differently-named untyped helper
 * parameter, a path handed inside another value or to a function from
 * another file — is still a read, and A13b's exact list is what catches a
 * new one; A13d shows which names are seen by shape, A13f by name.
 *
 * | #    | goes unnoticed without the row                                          |
 * | ---- | ----------------------------------------------------------------------- |
 * | A13  | a new auth log line that names the request path itself, past redaction  |
 * | A13b | a path that reaches a log line by a way the scan does not follow        |
 * | A13c | a context's raw Request read for its URL (`ctx.request.url`)            |
 * | A13d | a context known by another name, or a non-context taken for one         |
 * | A13e | a path handed to a same-file function that logs it (the exempt warning) |
 * | A13f | a context named `ctx` with no shape of its own — `any`, `unknown`, or untyped — still read by name |
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { againstList, productionSources, scanFile } from '../../../../../scripts/lib/request-path-scan.mjs';

const authSource = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Logged reads that do not write a path a caller chose. `<file> <expression>`
 * → how many times the file logs it; exact, as core's list is. Auth has none.
 */
const LOGGED_NOT_A_REQUEST = new Map<string, number>([]);

/** Every read of the request path, logged or not. `<file> <expression>` → count; exact. */
const READS = new Map<string, number>([
    // the path the client signed, verified against its proof
    ['server/middleware/auth-profiles.ts c.req.path', 1],
    ['server/client-proof/guard.ts c.req.path', 1],
    // the route lookup, the exempt-list match, and the ignored-exemption
    // warning's once-per-entry key (the warning logs the route's template)
    ['nextjs/interceptors/csrf.ts ctx.path', 3],
    // the provider segment the OAuth state is sealed for
    ['nextjs/interceptors/oauth.ts ctx.path', 1],
    // which of a rule's paths this request is
    ['nextjs/interceptors/general-auth.ts ctx.path', 3],
    ['nextjs/interceptors/device-login.ts ctx.path', 5],
    ['nextjs/interceptors/login-register.ts ctx.path', 3],
    ['nextjs/interceptors/mfa-verify.ts ctx.path', 3],
    ['nextjs/interceptors/password-reset.ts ctx.path', 3],
    ['nextjs/interceptors/signup-link.ts ctx.path', 3],
]);

/** A fixture scanned as if it were a file of auth's: its logged sites and reads, as `<line> <text>` */
function scanned(lines: string[]): { logged: string[]; reads: string[] }
{
    const { logged, reads } = scanFile(authSource, join(authSource, 'fixture.ts'), lines.join('\n'));

    return { logged: logged.map(site => `${site.line} ${site.text}`), reads: reads.map(site => `${site.line} ${site.text}`) };
}

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

    it('A13c: a context\'s request is a raw Request, read for its URL', () =>
    {
        expect(scanned([
            'function handler(ctx: RequestInterceptorContext)',
            '{',
            "    logger.warn('raw', { url: ctx.request.url, at: ctx.request['url'], headers: ctx.request.headers });",
            '}',
        ])).toEqual({
            logged: ['3 ctx.request.url', "3 ctx.request['url']"],
            reads: ['3 ctx.request.url', "3 ctx.request['url']"],
        });
    });

    it('A13d: a context is known by its declared shape, whatever its name', () =>
    {
        expect(scanned([
            'type Proposal = RequestInterceptorContext | ResponseInterceptorContext;',
            'const rule = { pathPattern: /x/, request: async (context, next) => log.info(\'rule\', { p: context.path }) };',
            "function typed(c: Proposal) { log.info('alias', { p: c.path }); }",
            "function picked(c: Pick<ResponseInterceptorContext, 'path'>) { log.info('pick', { p: c.path }); }",
            "function taken({ path }: RequestInterceptorContext) { log.info('destructured', { path }); }",
            "function untyped(context) { log.info('not seen', { p: context.path }); }",
            "function other(ctx: { path: string; request: Request }) { log.info('not a context', { p: ctx.path, u: ctx.request.url }); }",
        ])).toEqual({
            logged: ['2 context.path', '3 c.path', '4 c.path', '5 path ((parameter) { path })'],
            reads: ['2 context.path', '3 c.path', '4 c.path', '5 (parameter) { path }'],
        });
    });

    it('A13f: a context named ctx with no shape of its own — any, unknown, or untyped — is read by name', () =>
    {
        expect(scanned([
            "export function probe(ctx: any) { authLogger.interceptor.csrf.warn('x', { path: ctx.path }); }",
            "function asUnknown(ctx: unknown) { log.info('cast', { p: (ctx as { path: string }).path }); }",
            "function bare(ctx) { log.info('bare', { p: ctx.path }); }",
            "function notCtx(context: any) { log.info('not ctx', { p: context.path }); }",
            "function shapedCtx(ctx: { path: string }) { log.info('not any/unknown/absent', { p: ctx.path }); }",
        ])).toEqual({
            logged: ['1 ctx.path', '2 (ctx as { path: string }).path', '3 ctx.path'],
            reads: ['1 ctx.path', '2 (ctx as { path: string }).path', '3 ctx.path'],
        });
    });

    it('A13e: a path handed to a function of the same file is followed into its logger call', () =>
    {
        expect(scanned([
            "function report(path: string) { log.warn('entry ignored', { path }); }",
            'function relay(entry: string) { report(entry); }',
            "function byRoute(ctx: RequestInterceptorContext) { log.warn('entry ignored', { route: ctx.route?.path }); }",
            'function check(ctx: RequestInterceptorContext)',
            '{',
            '    report(ctx.path);',
            '    relay(ctx.path);',
            '    byRoute(ctx);',
            '}',
        ])).toEqual({
            logged: ['6 ctx.path → report()', '7 ctx.path → relay()'],
            reads: ['6 ctx.path', '7 ctx.path'],
        });
    });
});
