/**
 * No core log line names the request path except through loggedPath (spfn/spfn#164)
 *
 * `logging.redactPaths` holds only while every line that names the request
 * path reads it through `loggedPath(c)`. About twenty sites used to read
 * `c.req.path` or the URL themselves, which is how proxy-guard came to log a
 * capability route's token. This row scans core's production sources so a new
 * site cannot bring that back. What the scan reads as the request path, and as
 * a logger call, is said once in the scanner, `scripts/lib/request-path-scan.mjs`,
 * which auth's suite runs over auth's sources too (#489).
 *
 * T13: none of the paths is an argument of a logger call, except the exact
 * list below.
 *
 * T13b: every other read of the request path, as above, is on an exact list
 * too. A path handed to a
 * function and logged there (`selectStore(…, c.req.path)`), or folded into a
 * string a logger receives later (the transaction context), is not something
 * T13 can follow; a new read has to be listed here, and whoever lists it reads
 * where it goes.
 *
 * | #    | goes unnoticed without the row                                         |
 * | ---- | ---------------------------------------------------------------------- |
 * | T13  | a new log line that names the request path itself, bypassing redaction |
 * | T13b | a path that reaches a log line through a call or a context string      |
 * | T13d | a read spelled through an alias, destructuring, element access or `param()` |
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { againstList, productionSources, scanFile } from '../../../../../scripts/lib/request-path-scan.mjs';

const coreSource = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Logged expressions that are not a request's path. `<file> <expression>` →
 * how many times the file logs it. The list is exact: a count that differs, or
 * a file that does not exist, fails the row.
 */
const LOGGED_NOT_A_REQUEST = new Map<string, number>([
    // SPFN_API_URL's base path, warned about once at proxy creation
    ['nextjs/proxy/rpc.ts basePath (new URL(apiUrl).pathname)', 1],
]);

/**
 * Reads of the request that are not logged. `<file> <expression>` → count;
 * exact, as above.
 */
const READS_NOT_LOGGED = new Map<string, number>([
    // the helpers themselves: loggedPath and isRedactedPath
    ['middleware/logged-path.ts c.req.path', 2],
    // the noise filter, matched against the path the router serves
    ['middleware/request-logger.ts c.req.path', 2],
    // the skip list, and the raw URL the proxy signed
    ['middleware/proxy-guard.ts c.req.path', 1],
    ['middleware/proxy-guard.ts c.req.url', 1],
    // the counter key's namespace when the route has no pattern
    ['middleware/rate-limit.ts c.req.path', 1],
    // query parsing
    ['route/validation.ts c.req.url', 1],
    // the WebSocket upgrade's token and event list
    ['event/ws/handler.ts req.url', 1],
    // the route's params, validated; a failure's 400 body quotes the value, and
    // the request logger leaves bodies out under a declared prefix
    ['route/register-routes.ts c.req.param', 1],
    // the tenant id; a refusal names the parameter, not its value
    ['db/tenant/tenancy.ts c.req.param', 1],
]);

describe('request path in core log lines', () =>
{
    const results = productionSources(coreSource).map(file => scanFile(coreSource, file));

    it('T13: no core log call names the request path itself (#164)', () =>
    {
        const { unlisted, inexact } = againstList(coreSource, results.flatMap(result => result.logged), LOGGED_NOT_A_REQUEST);

        expect(unlisted, 'name the path with loggedPath(c): it applies logging.redactPaths').toEqual([]);
        expect(inexact, 'the list names each logged non-request path exactly').toEqual([]);
    });

    it('T13b: every other read of the request path or URL in core is listed', () =>
    {
        const { unlisted, inexact } = againstList(coreSource, results.flatMap(result => result.reads), READS_NOT_LOGGED);

        expect(unlisted, 'a read that reaches a log line goes through loggedPath(c); one that does not is listed here').toEqual([]);
        expect(inexact, 'the list names each read exactly: drop removed ones, count each expression').toEqual([]);
    });

    it('T13c: the scan follows a path through a const and a template, and into a shorthand property', () =>
    {
        const fixture = [
            'function handler(c: Context)',
            '{',
            '    const path = c.req.path;',
            '    const route = `${c.req.method} ${path}`;',
            "    logger.warn('alias', { path });",
            "    logger.debug('derived', { context: route });",
            "    guardLogger.info('direct', { url: new URL(c.req.url).pathname });",
            "    logger.info('helper', { path: loggedPath(c) });",
            '}',
        ].join('\n');
        const { logged, reads } = scanFile(coreSource, join(coreSource, 'fixture.ts'), fixture);

        expect(logged.map(site => `${site.line} ${site.text}`)).toEqual([
            '5 path (c.req.path)',
            '6 route (path (c.req.path))',
            '7 new URL(c.req.url).pathname',
            '7 c.req.url',
        ]);
        expect(reads.map(site => `${site.line} ${site.text}`)).toEqual(['3 c.req.path', '7 c.req.url']);
    });

    it('T13d: the scan sees a read through an alias, destructuring, element access and param()', () =>
    {
        const fixture = [
            'function handler(c: Context)',
            '{',
            '    const { path } = c.req;',
            '    const request = c.req;',
            '    const { raw } = request;',
            '    const { req: { url: href } } = c;',
            "    logger.info('destructured', { path, href });",
            "    logger.info('element', { at: c.req['path'], raw: raw.url, key: c.req[name] });",
            "    logger.warn('param', { token: c.req.param('token'), all: request.param() });",
            "    logger.debug('clone', { url: c.req.raw.clone().url });",
            '    const { ...rest } = c.req;',
            "    logger.info('rest', { url: rest.url });",
            "    logger.info('not a read', { method: request.method, headers: raw.headers });",
            '}',
        ].join('\n');
        const { logged, reads } = scanFile(coreSource, join(coreSource, 'fixture.ts'), fixture);

        expect(logged.map(site => `${site.line} ${site.text}`)).toEqual([
            '7 path (c.req { path })',
            '7 href (c { req } { url })',
            "8 c.req['path']",
            '8 raw.url',
            '8 c.req[name]',
            '9 c.req.param',
            '9 request.param',
            '10 c.req.raw.clone().url',
            '12 rest.url',
        ]);
        expect(reads.map(site => `${site.line} ${site.text}`)).toEqual([
            '3 c.req { path }',
            '6 c { req } { url }',
            "8 c.req['path']",
            '8 raw.url',
            '8 c.req[name]',
            '9 c.req.param',
            '9 request.param',
            '10 c.req.raw.clone().url',
            '12 rest.url',
        ]);
    });
});
