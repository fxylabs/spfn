/**
 * Route Map Generator Tests
 *
 * Every fixture is a real router file written to a temporary directory and
 * loaded for real — jiti is not mocked. The point of the change these tests
 * cover is that the generator stopped reading the source text, so a test that
 * stubbed the loading away would test the thing that was removed.
 *
 * Fixtures import `defineRouter` and `route` from the source files directly
 * rather than from `@spfn/core/route`: both modules are free of runtime
 * `@spfn/*` imports, so the fixture loads without the package having been built
 * and without a node_modules link inside the temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createRouteMapGenerator, RouteMapGeneratorError } from '../generators/route-map';

const OUTPUT_PATH = 'src/generated/route-map.ts';

/** Absolute specifiers a fixture imports, with separators a TS string accepts. */
const ROUTER_MODULE = resolve(__dirname, '../../route/router').replace(/\\/g, '/');
const ROUTE_BUILDER_MODULE = resolve(__dirname, '../../route/route-builder').replace(/\\/g, '/');

const IMPORTS = `import { defineRouter } from '${ROUTER_MODULE}';\n`
    + `import { route } from '${ROUTE_BUILDER_MODULE}';\n\n`;

let projectDir: string;

function writeFile(relativePath: string, content: string): void
{
    const absolutePath = join(projectDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

function writeRouter(body: string): void
{
    writeFile('src/server/router.ts', IMPORTS + body);
}

async function generate(): Promise<string>
{
    const generator = createRouteMapGenerator({
        name: '@spfn/core:route-map',
        routerPath: './src/server/router.ts',
        outputPath: `./${OUTPUT_PATH}`,
    });

    await generator.generate({ cwd: projectDir, trigger: { type: 'manual' } });

    return readFileSync(join(projectDir, OUTPUT_PATH), 'utf-8');
}

/** The `name: { method, path }` lines, in the order they were written. */
function entriesOf(content: string): string[]
{
    return content
        .split('\n')
        .filter(line => line.includes('{ method:'))
        .map(line => line.trim());
}

beforeEach(() =>
{
    projectDir = mkdtempSync(join(tmpdir(), 'spfn-route-map-'));
});

afterEach(() =>
{
    rmSync(projectDir, { recursive: true, force: true });
});

describe('route-map generator - how the router is written', () =>
{
    it('reads a multi-line defineRouter, as it always did', async () =>
    {
        writeRouter(
            'export const createUser = route.post(\'/users\').handler(async () => ({}));\n'
            + 'export const getUser = route.get(\'/users/:id\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({\n'
            + '    createUser,\n'
            + '    getUser,\n'
            + '});\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'createUser: { method: \'POST\', path: \'/users\' },',
            'getUser: { method: \'GET\', path: \'/users/:id\' },',
        ]);
    });

    it('reads a one-line defineRouter', async () =>
    {
        writeRouter(
            'export const createUser = route.post(\'/users\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ createUser });\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'createUser: { method: \'POST\', path: \'/users\' },',
        ]);
    });

    it('names an aliased route by the key the runtime registers it under', async () =>
    {
        writeRouter(
            'export const createUser = route.post(\'/users\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ create: createUser });\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'create: { method: \'POST\', path: \'/users\' },',
        ]);
    });

    it('reads every defineRouter call in the file, not only the first', async () =>
    {
        writeRouter(
            'const listUsers = route.get(\'/users\').handler(async () => ({}));\n'
            + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + 'const users = defineRouter({\n'
            + '    listUsers,\n'
            + '});\n\n'
            + 'export const appRouter = defineRouter({\n'
            + '    getRoot,\n'
            + '    users,\n'
            + '});\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'getRoot: { method: \'GET\', path: \'/\' },',
            'listUsers: { method: \'GET\', path: \'/users\' },',
        ]);
    });
});

describe('route-map generator - walking the router', () =>
{
    it('flattens three levels of nesting, each route under its own key', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const listUsers = route.get(\'/users\').handler(async () => ({}));\n'
            + 'const listKeys = route.get(\'/users/:id/keys\').handler(async () => ({}));\n\n'
            + 'const keys = defineRouter({ listKeys });\n'
            + 'const users = defineRouter({ listUsers, keys });\n\n'
            + 'export const appRouter = defineRouter({ getRoot, users });\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'getRoot: { method: \'GET\', path: \'/\' },',
            'listUsers: { method: \'GET\', path: \'/users\' },',
            'listKeys: { method: \'GET\', path: \'/users/:id/keys\' },',
        ]);
    });

    it('leaves package routes out, including a package attached to a nested router', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const listUsers = route.get(\'/users\').handler(async () => ({}));\n'
            + 'const login = route.post(\'/_auth/login\').handler(async () => ({}));\n'
            + 'const audit = route.get(\'/_ops/audit\').handler(async () => ({}));\n\n'
            + 'const authRouter = defineRouter({ login });\n'
            + 'const opsRouter = defineRouter({ audit });\n'
            + 'const users = defineRouter({ listUsers }).packages([opsRouter]);\n\n'
            + 'export const appRouter = defineRouter({ getRoot, users }).packages([authRouter]);\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'getRoot: { method: \'GET\', path: \'/\' },',
            'listUsers: { method: \'GET\', path: \'/users\' },',
        ]);
    });

    it('quotes a route name that is not an identifier', async () =>
    {
        writeRouter(
            'const getUser = route.get(\'/users/:id\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ \'get-user\': getUser });\n',
        );

        expect(entriesOf(await generate())).toEqual([
            '"get-user": { method: \'GET\', path: \'/users/:id\' },',
        ]);
    });

    it('escapes a path that would close its own string literal', async () =>
    {
        writeRouter(
            'const quirky = route.get("/it\'s").handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ quirky });\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'quirky: { method: \'GET\', path: \'/it\\\'s\' },',
        ]);
    });

    it('writes an empty map for an empty router', async () =>
    {
        writeRouter('export const appRouter = defineRouter({});\n');

        const content = await generate();

        expect(entriesOf(content)).toEqual([]);
        expect(content).toContain('export const routeMap: Record<string, RouteInfo> = {\n};');
        expect(content).toContain('export type RouteName = keyof RouteMap;');
    });

    it('finds the router under "default" and under "router"', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + 'export default defineRouter({ getRoot });\n',
        );
        expect(entriesOf(await generate())).toEqual(['getRoot: { method: \'GET\', path: \'/\' },']);

        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + 'export const router = defineRouter({ getRoot });\n',
        );
        expect(entriesOf(await generate())).toEqual(['getRoot: { method: \'GET\', path: \'/\' },']);
    });
});

describe('route-map generator - refusals', () =>
{
    it('fails on a duplicate name, naming both branches', async () =>
    {
        writeRouter(
            'const listUsers = route.get(\'/users\').handler(async () => ({}));\n'
            + 'const listAdmins = route.get(\'/admins\').handler(async () => ({}));\n\n'
            + 'const admin = defineRouter({ list: listAdmins });\n'
            + 'const users = defineRouter({ list: listUsers });\n\n'
            + 'export const appRouter = defineRouter({ users, admin });\n',
        );

        await expect(generate()).rejects.toThrow(RouteMapGeneratorError);
        await expect(generate()).rejects.toThrow(/router\.users\.list/);
        await expect(generate()).rejects.toThrow(/router\.admin\.list/);
    });

    it('names the file and the cause when the router will not load', async () =>
    {
        writeRouter(
            'throw new Error(\'DATABASE_URL is required\');\n\n'
            + 'export const appRouter = defineRouter({});\n',
        );

        await expect(generate()).rejects.toThrow(/src[/\\]server[/\\]router\.ts/);
        await expect(generate()).rejects.toThrow(/DATABASE_URL is required/);
        await expect(generate()).rejects.toThrow(/importable without side effects/);
    });

    it('lists the export names it tried when no router is found', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + 'export const theRouter = defineRouter({ getRoot });\n',
        );

        await expect(generate()).rejects.toThrow(/appRouter, default, router/);
    });

    it('refuses a route registered before .handler() was called', async () =>
    {
        writeRouter(
            'const createUser = route.post(\'/users\');\n\n'
            + 'export const appRouter = defineRouter({ createUser } as any);\n',
        );

        await expect(generate()).rejects.toThrow(/router\.createUser/);
        await expect(generate()).rejects.toThrow(/no method or path/);
    });

    it('refuses a router entry that is neither a route nor a router', async () =>
    {
        writeRouter(
            'export const appRouter = defineRouter({ getRoot: \'/\' } as any);\n',
        );

        await expect(generate()).rejects.toThrow(/neither a route nor a router/);
    });
});

describe('route-map generator - output', () =>
{
    it('is byte-identical across runs', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const createUser = route.post(\'/users\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ getRoot, createUser });\n',
        );

        expect(await generate()).toBe(await generate());
    });

    it('still accepts the deprecated additionalRouteDirs, and still watches it', () =>
    {
        const generator = createRouteMapGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            additionalRouteDirs: ['src/features'],
        });

        expect(generator.watchPatterns).toEqual([
            './src/server/router.ts',
            'src/server/routes/**/*.ts',
            'src/features/**/*.ts',
        ]);
    });

    it('warns and returns when the router file is absent', async () =>
    {
        const generator = createRouteMapGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
        });

        await expect(generator.generate({ cwd: projectDir, trigger: { type: 'manual' } })).resolves.toBeUndefined();
    });
});
