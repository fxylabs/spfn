/**
 * spfn/surface — the client on a surface other than `/_ops`
 *
 * Lists and calls commands on `/_app` against a real local HTTP server that
 * mounts `/_app` and `/_ops` side by side, so the namespace the client is
 * given is the only thing that decides which surface it sees. Also pins the
 * library's promises: it prints nothing unless asked, refuses a URL that
 * would carry its credential in the clear, and never imports the CLI's
 * terminal stack.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@sinclair/typebox';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineMiddleware, defineRouter, registerRoutes } from '@spfn/core/route';
import { createOpsRouter, opsRoute } from '@spfn/core/ops';
import { defineSurface } from '@spfn/core/surface';

import { fetchOpsManifest } from '../../utils/ops/client.js';
import { buildCommandPath } from '../command-path.js';
import { createSurfaceClient, SurfaceManifestError } from '../client.js';
import type { SurfaceWarning } from '../manifest-trust.js';

const SURFACE_DIR = fileURLToPath(new URL('..', import.meta.url));

function bearer(name: string, expected: string)
{
    return defineMiddleware(name, async (c, next) =>
    {
        if (c.req.header('authorization') !== `Bearer ${expected}`)
        {
            return c.json({ error: 'unauthorized' }, 401);
        }

        return await next();
    }, { skips: ['auth'] });
}

function testApp(): Hono
{
    const surface = defineSurface({ namespace: '/_app', auth: bearer('signedTokenAuth', 'app-token') });
    const appSurface = surface.router({
        pageAdd: surface.route.post('/pages')
            .input({ body: Type.Object({ title: Type.String() }) })
            .effect('write')
            .summary('Add a page')
            .handler(async (c) => ({ added: (await c.data()).body.title })),
        pageGet: surface.route.get('/pages/:id')
            .input({ params: Type.Object({ id: Type.String() }) })
            .effect('read')
            .handler(async (c) => ({ id: (await c.data()).params.id })),
        pageDrop: surface.route.delete('/pages/:id')
            .input({ params: Type.Object({ id: Type.String() }) })
            .effect('destructive')
            .summary('Drop a page for good')
            .handler(async (c) => ({ dropped: (await c.data()).params.id })),
    });
    const opsSurface = createOpsRouter({
        listSignups: opsRoute.get('/signups').handler(async () => ({ items: [] })),
    }, { auth: bearer('opsTokenAuth', 'ops-token') });

    const app = new Hono();
    registerRoutes(app, defineRouter({}).packages([appSurface, opsSurface]));

    return app;
}

async function bodyOf(req: IncomingMessage): Promise<Buffer | undefined>
{
    const chunks: Buffer[] = [];
    for await (const chunk of req)
    {
        chunks.push(chunk as Buffer);
    }

    return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

/** A node HTTP server in front of the Hono app, so the client goes over a real socket. */
function serve(app: Hono): Server
{
    return createServer(async (req, res) =>
    {
        const headers = Object.entries(req.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
        const response = await app.fetch(new Request(`http://127.0.0.1${req.url}`, {
            method: req.method,
            headers,
            body: await bodyOf(req),
        }));

        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
    });
}

let server: Server;
let appUrl: string;

beforeAll(async () =>
{
    server = serve(testApp());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () =>
{
    await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('createSurfaceClient on /_app', () =>
{
    it('lists the /_app commands and calls one by name', async () =>
    {
        const client = createSurfaceClient({ appUrl, namespace: '/_app', token: 'app-token' });

        const manifest = await client.manifest();
        expect(manifest.commands.map(command => [command.name, command.method, command.path])).toEqual([
            ['pageAdd', 'POST', '/_app/pages'],
            ['pageDrop', 'DELETE', '/_app/pages/:id'],
            ['pageGet', 'GET', '/_app/pages/:id'],
        ]);

        expect(await client.call('pageAdd', { params: {}, query: {}, body: { title: 'Hello' } }))
            .toEqual({ status: 200, body: { added: 'Hello' } });
        expect(await client.call('pageGet', { params: { id: 'a/b' }, query: {}, body: undefined }))
            .toEqual({ status: 200, body: { id: 'a/b' } });
    });

    it('resolves a token function before each request', async () =>
    {
        const token = vi.fn(async () => 'app-token');
        const client = createSurfaceClient({ appUrl, namespace: '/_app', token });

        await client.call('pageAdd', { params: {}, query: {}, body: { title: 'x' } });

        expect(token).toHaveBeenCalledTimes(2);
    });

    it('describes a command without naming any CLI', async () =>
    {
        const client = createSurfaceClient({ appUrl, namespace: '/_app', token: 'app-token' });
        const usage = client.describe(await client.manifest(), 'pageAdd');

        expect(usage).toMatch(/^pageAdd {2}POST \/_app\/pages/);
        expect(usage).toContain('title');
        expect(usage).not.toContain('spfn ops');
        expect(() => client.describe({ manifestVersion: 1, commands: [] }, 'pageAdd')).toThrow(/Unknown command/);
    });

    it('22 — lists each command with the effect and summary its route declared', async () =>
    {
        const onWarning = vi.fn();
        const client = createSurfaceClient({ appUrl, namespace: '/_app', token: 'app-token', onWarning });

        const manifest = await client.manifest();

        expect(manifest.commands.map(command => [command.name, command.effect, command.summary])).toEqual([
            ['pageAdd', 'write', 'Add a page'],
            ['pageDrop', 'destructive', 'Drop a page for good'],
            ['pageGet', 'read', undefined],
        ]);
        expect(manifest.commands.some(command => command.metadataRejected)).toBe(false);
        expect(onWarning).not.toHaveBeenCalled();
        expect(client.describe(manifest, 'pageAdd')).toContain('Effect: write');
    });

    it('throws the status when the app refuses the token', async () =>
    {
        const client = createSurfaceClient({ appUrl, namespace: '/_app', token: 'ops-token' });

        const refusal = await client.manifest().catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(SurfaceManifestError);
        expect(refusal).toMatchObject({ status: 401 });
    });
});

describe('two surfaces on one app', () =>
{
    it('sees only its own namespace, and `spfn ops` sees only /_ops', async () =>
    {
        const appClient = createSurfaceClient({ appUrl, namespace: '/_app', token: 'app-token' });
        const appNames = (await appClient.manifest()).commands.map(command => command.name);
        const opsNames = (await fetchOpsManifest(appUrl, 'ops-token')).commands.map(command => command.name);

        expect(appNames).toEqual(['pageAdd', 'pageDrop', 'pageGet']);
        expect(opsNames).toEqual(['listSignups']);
    });
});

describe('warnings', () =>
{
    function announcing(commands: unknown[]): void
    {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ manifestVersion: 1, commands }),
            { status: 200 },
        ));
    }

    it('drops a command outside the namespace and tells onWarning', async () =>
    {
        announcing([
            { name: 'pageAdd', method: 'POST', path: '/_app/pages', input: {} },
            { name: 'listSignups', method: 'GET', path: '/_ops/signups', input: {} },
        ]);
        const onWarning = vi.fn();
        const client = createSurfaceClient({ appUrl: 'https://app.example', namespace: '/_app', token: 't', onWarning });

        const manifest = await client.manifest();

        expect(manifest.commands.map(command => command.name)).toEqual(['pageAdd']);
        expect(onWarning).toHaveBeenCalledWith(
            expect.stringContaining('outside /_app/'),
            { kind: 'command', reason: expect.stringContaining('outside /_app/') },
        );
    });

    it('prints nothing when no onWarning is given', async () =>
    {
        announcing([{ name: 'stray', method: 'GET', path: '/elsewhere', input: {} }]);
        const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await createSurfaceClient({ appUrl: 'https://app.example', namespace: '/_app', token: 't' }).manifest();

        expect(printed).not.toHaveBeenCalled();
        expect(logged).not.toHaveBeenCalled();
    });

    it('builds a metadata warning without the metadata field', () =>
    {
        const warning: SurfaceWarning = { kind: 'metadata', command: 'x', reason: 'r' };

        expect(warning.kind).toBe('metadata');
    });
});

describe('refusals', () =>
{
    it('refuses http to a remote host and accepts https or loopback http', () =>
    {
        expect(() => createSurfaceClient({ appUrl: 'http://app.example', namespace: '/_app', token: 't' }))
            .toThrow(/over http/);
        expect(() => createSurfaceClient({ appUrl: 'ftp://app.example', namespace: '/_app', token: 't' }))
            .toThrow(/must be https/);
        expect(() => createSurfaceClient({ appUrl: 'not a url', namespace: '/_app', token: 't' }))
            .toThrow(/Invalid app URL/);
        for (const url of ['https://app.example', 'http://localhost:8790', 'http://[::1]:8790'])
        {
            expect(() => createSurfaceClient({ appUrl: url, namespace: '/_app', token: 't' })).not.toThrow();
        }
    });

    it.each(['app', '/_app/', '/', '/_a%70p', '/:x'])('refuses the namespace %j', (namespace) =>
    {
        expect(() => createSurfaceClient({ appUrl: 'https://app.example', namespace, token: 't' }))
            .toThrow(/namespace .* is invalid/);
    });

    it('refuses to build a request for a path outside its namespace', () =>
    {
        const command = { name: 'x', method: 'GET' as const, path: '/_ops/signups', input: {} };

        expect(() => buildCommandPath(command, {}, {}, '/_app'))
            .toThrow(/^Refusing command path "\/_ops\/signups" because it .*outside \/_app\//);
        expect(buildCommandPath(command, {}, { limit: '5' }, '/_ops')).toBe('/_ops/signups?limit=5');
    });
});

describe('source', () =>
{
    function sourceFiles(dir: string): string[]
    {
        return readdirSync(dir).flatMap((entry) =>
        {
            const full = join(dir, entry);

            return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
        });
    }

    it('imports neither commander nor chalk anywhere under src/surface', () =>
    {
        const files = sourceFiles(SURFACE_DIR).filter(file => !file.includes('__tests__'));
        expect(files.length).toBeGreaterThan(0);

        for (const file of files)
        {
            expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"](commander|chalk)['"]|require\(['"](commander|chalk)['"]\)/);
        }
    });
});
