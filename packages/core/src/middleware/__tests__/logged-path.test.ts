/**
 * A declared path prefix is redacted in every core log line that names the request path (spfn/spfn#164)
 *
 * The rows build the server the way an app does — `createServer` from a
 * `defineServerConfig()` — and capture every line the built logger writes, at
 * every level, so a site that reads the path itself shows up as the secret in
 * the output. The transaction context (T4) needs a database and sits in
 * `db/transaction/__tests__/logged-path.integration.test.ts`; the rate-limit
 * warning (T11) in `rate-limit.test.ts`, which mocks the cache; the source scan
 * (T13) in `request-path-in-logs.test.ts`; the Next.js lines (T14) beside their
 * other rows.
 *
 * | #   | situation                                                              | goes unnoticed without the row                                  |
 * | --- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
 * | T1  | proxy-guard tag mode, unsigned call under a declared prefix            | the issue's debug line carrying the token                       |
 * | T2  | proxy-guard strict mode, same call                                     | the strict warn staying raw, or the 403 body starting to echo it |
 * | T3  | a route under the prefix throws                                        | the error handler's warn and its `onError` context carrying it at the default level |
 * | T5  | the auto-applied request logger                                        | a request logger that honours only its own options              |
 * | T6  | `/api/%69mport/…`: redacted, and excluded by `excludePaths` given through `middleware.logger` | the percent-encoded bypass of either rule, or `middleware.logger` options ignored |
 * | T7  | `/api/importer/x` and the bare `/api/import`                           | matching beyond or short of a segment boundary                  |
 * | T8  | a path nothing declared                                                | a silent change to every app's path fields                      |
 * | T9  | entries that are not literal prefixes                                  | a typo that redacts nothing                                     |
 * | T10 | a hand-written `app.ts` with its own RequestLogger and ErrorHandler   | the declaration published only on the auto-configured path      |
 * | T15a | a path-parameter validation failure under the prefix                 | the logged 400 body (`fields[].value`) quoting the segment      |
 * | T15b | an error whose message and cause quote the segment, with and without `includeStack` | the error handler's line carrying either message     |
 * | T15c | the request logger's `Request failed` line, downstream throwing a message quoting the segment | that line carrying the message |
 * | T16a | spellings the router does not serve (`//`, case, `%2F`, double encoding, `..` after decoding) | a 404 logging the token the client meant for the route |
 * | T16b | a mixed-case entry; the same rules beside the boundary, and an undeclared 404 | an entry that matches nothing, over-redaction, or a 404's path no longer written as received |
 * | T15d | a `Referer` under the prefix in the `onError` context                 | the referring page's token in the context's headers             |
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Type } from '@sinclair/typebox';

import { Logger } from '@spfn/core/logger';
import { NotFoundError } from '@spfn/core/errors';
import { route, defineRouter } from '@spfn/core/route';
import { ErrorHandler, RequestLogger, loggedPath, setRedactPaths, type OnErrorContext } from '@spfn/core/middleware';
import { defineServerConfig } from '../../server/config-builder';
import { createServer } from '../../server/create-server';
import { validateServerConfig } from '../../server/validation';
import { captureLoggerClass } from '../../logger/__tests__/helpers/leak-probe';

import type { ServerConfigBuilder } from '../../server/config-builder';

const SECRET = 'capability-token-1f3a9c';
const REDACTED = '/api/import/[redacted]';
const PROXY_SECRET = 'a'.repeat(48);

const appRouter = defineRouter({
    redeemImport: route.get('/api/import/:token').handler(async () => ({ ok: true })),
    failImport: route.get('/api/import/:token/fail').handler(async () =>
    {
        throw new NotFoundError({ message: 'No such import' });
    }),
    getImporter: route.get('/api/importer/:id').handler(async () => ({ ok: true })),
    getImportRoot: route.get('/api/import').handler(async () => ({ ok: true })),
    checkImport: route.get('/api/import/:token/check')
        .input({ params: Type.Object({ token: Type.String({ pattern: '^[a-z-]+$' }) }) })
        .handler(async () => ({ ok: true })),
    checkUser: route.get('/users/:id/check')
        .input({ params: Type.Object({ id: Type.String({ pattern: '^[a-z-]+$' }) }) })
        .handler(async () => ({ ok: true })),
    failUser: route.get('/users/:id/fail').handler(async () =>
    {
        throw new NotFoundError({ message: 'No such user' });
    }),
});

function serverConfig(configure: (builder: ServerConfigBuilder) => ServerConfigBuilder = builder => builder)
{
    return configure(defineServerConfig()
        .port(0)
        .infrastructure({ database: false, redis: false })
        .routes(appRouter))
        .build();
}

function get(app: Hono, path: string): Promise<Response>
{
    return Promise.resolve(app.fetch(new Request(`http://localhost${path}`)));
}

/** The `path` field of each captured line with this message */
function pathsOf(lines: { message: string; context?: Record<string, unknown> }[], message: string): unknown[]
{
    return lines.filter(line => line.message === message).map(line => line.context?.path);
}

afterEach(() =>
{
    setRedactPaths(undefined);
    vi.restoreAllMocks();
});

describe('a declared path prefix is redacted in every core log line (#164)', () =>
{
    it('T1: proxy-guard tag mode logs the unsigned call\'s path redacted, at debug, and no line carries the token', async () =>
    {
        const app = await createServer(serverConfig(builder => builder
            .proxyGuard({ mode: 'tag', secret: PROXY_SECRET })
            .logging({ redactPaths: ['/api/import'] })));
        const { lines, output } = captureLoggerClass(Logger);

        expect((await get(app, `/api/import/${SECRET}`)).status).toBe(200);

        expect(pathsOf(lines, 'Unverified request (would reject in strict mode)')).toEqual([REDACTED]);
        expect(output()).not.toContain(SECRET);
    });

    it('T2: proxy-guard strict mode logs the rejection redacted and answers the same 403 body', async () =>
    {
        const app = await createServer(serverConfig(builder => builder
            .proxyGuard({ mode: 'strict', secret: PROXY_SECRET })
            .logging({ redactPaths: ['/api/import'] })));
        const { lines, output } = captureLoggerClass(Logger);

        const response = await get(app, `/api/import/${SECRET}`);

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden', message: 'Request origin could not be verified' });
        expect(pathsOf(lines, 'Rejected unverified request')).toEqual([REDACTED]);
        expect(output()).not.toContain(SECRET);
    });

    it('T3: a route that throws under the prefix: the error handler\'s line and its onError context are redacted', async () =>
    {
        const onError = vi.fn<(err: Error, context: OnErrorContext) => void>();
        const app = await createServer(serverConfig(builder => builder
            .middleware({ onError })
            .logging({ redactPaths: ['/api/import'] })));
        const { lines, output } = captureLoggerClass(Logger);

        expect((await get(app, `/api/import/${SECRET}/fail`)).status).toBe(404);
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

        expect(lines.filter(line => line.message === 'Error occurred').map(line => [line.level, line.context?.path]))
            .toEqual([['warn', REDACTED]]);
        expect(onError.mock.calls[0][1].path).toBe(REDACTED);
        expect(output()).not.toContain(SECRET);
    });

    it('T5: the auto-applied request logger writes the redacted path on both of its lines', async () =>
    {
        const app = await createServer(serverConfig(builder => builder.logging({ redactPaths: ['/api/import'] })));
        const { lines, output } = captureLoggerClass(Logger);

        await get(app, `/api/import/${SECRET}`);

        expect(pathsOf(lines, 'Request received')).toEqual([REDACTED]);
        expect(pathsOf(lines, 'Request completed')).toEqual([REDACTED]);
        expect(output()).not.toContain(SECRET);
    });

    it('T6a: a percent-encoded spelling of a declared prefix, served by its route, is redacted', async () =>
    {
        const app = await createServer(serverConfig(builder => builder.logging({ redactPaths: ['/api/import'] })));
        const { lines, output } = captureLoggerClass(Logger);

        expect((await get(app, `/api/%69mport/${SECRET}`)).status).toBe(200);

        expect(pathsOf(lines, 'Request received')).toEqual([REDACTED]);
        expect(output()).not.toContain(SECRET);
    });

    it('T6b: excludePaths given through middleware.logger also excludes the percent-encoded spelling', async () =>
    {
        const app = await createServer(serverConfig(builder => builder
            .middleware({ logger: { excludePaths: ['/api/import'] } })));
        const { lines } = captureLoggerClass(Logger);

        expect((await get(app, `/api/%69mport/${SECRET}`)).status).toBe(200);
        expect((await get(app, '/api/importer/7')).status).toBe(200);

        expect(pathsOf(lines, 'Request received')).toEqual(['/api/importer/7']);
    });

    it('T7: a prefix covers itself and what lies below it on a segment boundary, nothing else', async () =>
    {
        setRedactPaths(['/api/import']);
        const app = new Hono();
        app.get('*', c => c.text(loggedPath(c)));

        const logged = async (path: string): Promise<string> => (await get(app, path)).text();

        expect(await logged('/api/import')).toBe(REDACTED);
        expect(await logged('/api/import/')).toBe(REDACTED);
        expect(await logged(`/api/import/${SECRET}/more`)).toBe(REDACTED);
        expect(await logged('/api/importer/x')).toBe('/api/importer/x');
        expect(await logged('/api/impor')).toBe('/api/impor');
        expect(await logged('/v1/api/import/x')).toBe('/v1/api/import/x');
    });

    it('T8: a path nothing declared is written as before, by every site', async () =>
    {
        const onError = vi.fn<(err: Error, context: OnErrorContext) => void>();
        const app = await createServer(serverConfig(builder => builder
            .middleware({ onError })
            .proxyGuard({ mode: 'tag', secret: PROXY_SECRET })
            .logging({ redactPaths: ['/api/import'] })));
        const { lines } = captureLoggerClass(Logger);

        await get(app, '/users/123/fail');
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

        const paths = ['Request received', 'Unverified request (would reject in strict mode)', 'Error occurred', 'Request completed']
            .map(message => pathsOf(lines, message));
        expect(paths).toEqual([['/users/123/fail'], ['/users/123/fail'], ['/users/123/fail'], ['/users/123/fail']]);
        expect(onError.mock.calls[0][1].path).toBe('/users/123/fail');
    });

    it('T9: an entry that is not a literal path prefix refuses the boot, from the builder and from a plain config', async () =>
    {
        const bad = ['api/import', '/api/import/', '/', '/api/import?x=1', '/api/import#a', '/api/import/:token', '/api/*', ''];

        for (const entry of bad)
        {
            expect(() => defineServerConfig().logging({ redactPaths: [entry] }), entry).toThrow(/redactPaths entry/);
            expect(() => validateServerConfig({ logging: { redactPaths: [entry] } }), entry).toThrow(/redactPaths entry/);
        }

        await expect(createServer({ logging: { redactPaths: ['/api/import/'] } })).rejects.toThrow(/redactPaths entry/);
        expect(() => validateServerConfig({ logging: { redactPaths: '/api/import' as unknown as string[] } }))
            .toThrow(/Must be an array/);
        expect(() => validateServerConfig({ logging: { redactPaths: ['/api/import', '/share'] } })).not.toThrow();
    });

    it('T10: a hand-written app.ts wiring its own RequestLogger and ErrorHandler is redacted too', async () =>
    {
        const appDir = mkdtempSync(join(tmpdir(), 'i164-app-'));
        const cwd = process.cwd();

        mkdirSync(join(appDir, 'src', 'server'), { recursive: true });
        writeFileSync(join(appDir, 'src', 'server', 'app.ts'), handWrittenApp());

        try
        {
            process.chdir(appDir);
            const app = await createServer({ logging: { redactPaths: ['/api/import'] } });
            const { lines, output } = captureLoggerClass(Logger);

            expect((await get(app, `/api/import/${SECRET}`)).status).toBe(500);

            expect(pathsOf(lines, 'Request received')).toEqual([REDACTED]);
            expect(pathsOf(lines, 'Error occurred')).toEqual([REDACTED]);
            expect(output()).not.toContain(SECRET);
        }
        finally
        {
            process.chdir(cwd);
            rmSync(appDir, { recursive: true, force: true });
        }
    });

    it('T15a: a path-parameter validation failure under the prefix logs status and duration, not the 400 body', async () =>
    {
        const app = await createServer(serverConfig(builder => builder.logging({ redactPaths: ['/api/import'] })));
        const segment = SECRET.toUpperCase();
        const completed = async (path: string): Promise<{ context: Record<string, unknown>; output: string }> =>
        {
            const { lines, output } = captureLoggerClass(Logger);
            expect((await get(app, path)).status).toBe(400);
            vi.restoreAllMocks();

            return { context: lines.find(line => line.message === 'Request completed')!.context!, output: output() };
        };

        const declared = await completed(`/api/import/${segment}/check`);
        expect([declared.context.path, declared.context.status, typeof declared.context.duration, 'response' in declared.context])
            .toEqual([REDACTED, 400, 'number', false]);
        expect(declared.output).not.toContain(segment);

        // The same failure outside the prefix still logs the body, value and all
        const undeclared = await completed(`/users/${segment}/check`);
        expect(JSON.stringify(undeclared.context.response)).toContain(`"value":"${segment}"`);
    });

    it('T15b: an error quoting the segment is logged by name, status and stack under the prefix, with no message', async () =>
    {
        setRedactPaths(['/api/import']);

        for (const includeStack of [true, false])
        {
            const app = new Hono();
            app.get('*', () =>
            {
                const error = new NotFoundError({ message: `Import ${SECRET} not found` });
                error.cause = new Error(`No row for ${SECRET}`);
                throw error;
            });
            app.onError(ErrorHandler({ includeStack }));
            const logged = async (path: string): Promise<{ error: Record<string, unknown>; output: string }> =>
            {
                const { lines, output } = captureLoggerClass(Logger);
                await get(app, path);
                vi.restoreAllMocks();
                const line = lines.find(entry => entry.message === 'Error occurred')!;

                return { error: (line.error ?? line.context?.error) as Record<string, unknown>, output: output() };
            };

            const declared = await logged(`/api/import/${SECRET}`);
            expect([declared.error.name, declared.error.statusCode, 'message' in declared.error, 'stack' in declared.error])
                .toEqual(['NotFoundError', 404, false, includeStack]);
            expect(declared.error.cause).toMatchObject({ name: 'Error' });
            expect(declared.error.cause).not.toHaveProperty('message');
            expect(declared.output, `includeStack: ${includeStack}`).not.toContain(SECRET);

            expect((await logged('/users/1')).error).toMatchObject({
                message: `Import ${SECRET} not found`,
                cause: { message: `No row for ${SECRET}` },
            });
        }
    });

    it('T15c: the request logger\'s Request failed line under the prefix carries the error without its message', async () =>
    {
        setRedactPaths(['/api/import']);
        const app = new Hono();
        app.get('*', async (c) =>
        {
            await RequestLogger()(c, async () =>
            {
                throw new Error(`Import ${SECRET} not found`);
            }).catch(() => undefined);

            return c.text('done');
        });
        const { lines, output } = captureLoggerClass(Logger);

        await get(app, `/api/import/${SECRET}`);

        const failed = lines.find(line => line.message === 'Request failed')!;
        expect([failed.context?.path, failed.error?.name, failed.error && 'message' in failed.error])
            .toEqual([REDACTED, 'Error', false]);
        expect(output()).not.toContain(SECRET);
    });

    it('T15d: a Referer under the prefix reaches the onError context redacted; any other is unchanged', async () =>
    {
        const onError = vi.fn<(err: Error, context: OnErrorContext) => void>();
        const app = await createServer(serverConfig(builder => builder
            .middleware({ onError })
            .logging({ redactPaths: ['/api/import'] })));
        captureLoggerClass(Logger);

        const referers = [`https://app.test/api/import/${SECRET}?x=1`, `https://app.test//API/import/${SECRET}`, 'https://app.test/users/7?tab=a'];

        for (const referer of referers)
        {
            await Promise.resolve(app.fetch(new Request('http://localhost/users/1/fail', { headers: { referer } })));
        }
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(3));

        expect(onError.mock.calls.map(([, context]) => context.request.headers.referer))
            .toEqual([`https://app.test${REDACTED}`, `https://app.test${REDACTED}`, 'https://app.test/users/7?tab=a']);
    });

    it('T16a: a spelling of a declared prefix the router does not serve is redacted in its 404 lines', async () =>
    {
        const app = await createServer(serverConfig(builder => builder.logging({ redactPaths: ['/api/import'] })));
        const spellings = [
            `//api/import/${SECRET}`,
            `/api//import/${SECRET}`,
            `/API/Import/${SECRET}`,
            `/api%2Fimport/${SECRET}`,
            `/api/%2569mport/${SECRET}`,
            `/x/..%2Fapi/import/${SECRET}`,
            `/..%2Fapi/import/${SECRET}`,
        ];

        for (const spelling of spellings)
        {
            const { lines, output } = captureLoggerClass(Logger);

            expect((await get(app, spelling)).status, spelling).toBe(404);
            expect(pathsOf(lines, 'Request completed'), spelling).toEqual([REDACTED]);
            expect(output(), spelling).not.toContain(SECRET);
            vi.restoreAllMocks();
        }
    });

    it('T16b: an entry is matched in the same spelling; beside the boundary and outside every prefix a path is written as received', async () =>
    {
        setRedactPaths(['/api/import', '/Share']);
        const app = new Hono();
        app.get('*', c => c.text(loggedPath(c)));

        const logged = async (path: string): Promise<string> => (await get(app, path)).text();

        expect(await logged('/API/Importer/x')).toBe('/API/Importer/x');
        expect(await logged('//api/importer/x')).toBe('//api/importer/x');
        expect(await logged('/v1/api/import/x')).toBe('/v1/api/import/x');
        expect(await logged(`/Share/${SECRET}`)).toBe('/Share/[redacted]');
        expect(await logged(`/share/${SECRET}`)).toBe('/Share/[redacted]');
        expect(await logged('//Users/%2569d')).toBe('//Users/%2569d');
    });
});

/**
 * A Level-3 `app.ts` outside the package: it reaches the built middleware by
 * absolute path, the copy `createServer` publishes the declaration into
 */
function handWrittenApp(): string
{
    const middleware = new URL('../../../dist/middleware/index.js', import.meta.url).pathname;

    return [
        `import { Hono } from '${fileURLToPath(import.meta.resolve('hono'))}';`,
        `import { ErrorHandler, RequestLogger } from '${middleware}';`,
        'export default () =>',
        '{',
        '    const app = new Hono();',
        "    app.use('*', RequestLogger());",
        "    app.get('/api/import/:token', () => { throw new Error('boom'); });",
        '    app.onError(ErrorHandler());',
        '    return app;',
        '};',
    ].join('\n');
}
