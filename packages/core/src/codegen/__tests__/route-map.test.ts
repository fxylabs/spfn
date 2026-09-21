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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createJiti } from 'jiti';
import { createRouteMapGenerator, RouteMapGeneratorError } from '../generators/route-map';
import { ConditionalRegistrationError } from '../generators/contract-guard';

const OUTPUT_PATH = 'src/generated/route-map.ts';

/** Absolute specifiers a fixture imports, with separators a TS string accepts. */
const ROUTER_MODULE = resolve(__dirname, '../../route/router').replace(/\\/g, '/');
const ROUTE_BUILDER_MODULE = resolve(__dirname, '../../route/route-builder').replace(/\\/g, '/');

const IMPORTS = `import { defineRouter, defineUnmappedRouter } from '${ROUTER_MODULE}';\n`
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

/**
 * The generated file, loaded.
 *
 * A map that names a route is only worth what the file it is written to holds:
 * a path that closed its own string literal, or a name that landed on the
 * prototype, is visible here and in no assertion over the text.
 */
function loadGeneratedMap(): Record<string, { method: string; path: string }>
{
    const jiti = createJiti(projectDir, { interopDefault: true, moduleCache: false });

    return (jiti(join(projectDir, OUTPUT_PATH)) as { routeMap: Record<string, { method: string; path: string }> })
        .routeMap;
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
            'quirky: { method: \'GET\', path: "/it\'s" },',
        ]);
        expect(loadGeneratedMap().quirky.path).toBe('/it\'s');
    });

    it('escapes a backslash in a path', async () =>
    {
        writeRouter(
            'const windowsish = route.get(\'/a\\\\b\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ windowsish });\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'windowsish: { method: \'GET\', path: "/a\\\\b" },',
        ]);
        expect(loadGeneratedMap().windowsish.path).toBe('/a\\b');
    });

    it('escapes every line terminator a path can carry', async () =>
    {
        const terminators = { newline: '\\n', carriageReturn: '\\r', lineSep: '\\u2028', paragraphSep: '\\u2029' };

        writeRouter(
            Object.entries(terminators)
                .map(([name, escape]) => `const ${name} = route.get('/c${escape}d').handler(async () => ({}));\n`)
                .join('')
            + `\nexport const appRouter = defineRouter({ ${Object.keys(terminators).join(', ')} });\n`,
        );

        await generate();

        expect(loadGeneratedMap()).toEqual({
            newline: { method: 'GET', path: '/c\nd' },
            carriageReturn: { method: 'GET', path: '/c\rd' },
            lineSep: { method: 'GET', path: '/c\u2028d' },
            paragraphSep: { method: 'GET', path: '/c\u2029d' },
        });
    });

    it('quotes a numeric and a non-ASCII route name', async () =>
    {
        writeRouter(
            'const getUser = route.get(\'/users/:id\').handler(async () => ({}));\n'
            + 'const listUsers = route.get(\'/users\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ \'2fa\': getUser, \'사용자\': listUsers });\n',
        );

        expect(entriesOf(await generate())).toEqual([
            '"2fa": { method: \'GET\', path: \'/users/:id\' },',
            '"사용자": { method: \'GET\', path: \'/users\' },',
        ]);
        expect(Object.keys(loadGeneratedMap())).toEqual(['2fa', '사용자']);
    });

    it('emits __proto__ as a computed key, so the route stays an own property', async () =>
    {
        writeRouter(
            'const weird = route.get(\'/weird\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ [\'__proto__\']: weird } as any);\n',
        );

        expect(entriesOf(await generate())).toEqual([
            '["__proto__"]: { method: \'GET\', path: \'/weird\' },',
        ]);
        expect(Object.keys(loadGeneratedMap())).toEqual(['__proto__']);
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

    it('warns and writes nothing when the router file is absent', async () =>
    {
        const generator = createRouteMapGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: `./${OUTPUT_PATH}`,
        });

        await expect(generator.generate({ cwd: projectDir, trigger: { type: 'manual' } })).resolves.toBeUndefined();
        expect(existsSync(join(projectDir, OUTPUT_PATH))).toBe(false);
    });

    it('ignores additionalRouteDirs when collecting, not only when watching', async () =>
    {
        writeFile(
            'src/features/reports.ts',
            `import { route } from '${ROUTE_BUILDER_MODULE}';\n\n`
            + 'export const listReports = route.get(\'/reports\').handler(async () => ({}));\n',
        );
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ getRoot });\n',
        );

        const generator = createRouteMapGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: `./${OUTPUT_PATH}`,
            additionalRouteDirs: ['src/features'],
        });

        await generator.generate({ cwd: projectDir, trigger: { type: 'manual' } });

        expect(Object.keys(loadGeneratedMap())).toEqual(['getRoot']);
    });
});

describe('route-map generator - conditional registration', () =>
{
    it('refuses a router that registers a route behind a flag', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const admin = route.get(\'/admin\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({\n'
            + '    getRoot,\n'
            + '    ...(process.env.ENABLE_ADMIN ? { admin } : {}),\n'
            + '});\n',
        );

        await expect(generate()).rejects.toThrow(ConditionalRegistrationError);
        await expect(generate()).rejects.toThrow(/registers routes conditionally/);
        expect(existsSync(join(projectDir, OUTPUT_PATH))).toBe(false);
    });

    it('accepts a spread of a plain object', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const base = { getRoot };\n\n'
            + 'export const appRouter = defineRouter({ ...base });\n',
        );

        expect(entriesOf(await generate())).toEqual(['getRoot: { method: \'GET\', path: \'/\' },']);
    });

    it('pins NODE_ENV so the same router does not load two ways', async () =>
    {
        const shellValue = process.env.NODE_ENV;
        delete process.env.NODE_ENV;

        writeRouter(
            'const env = route.get(`/${process.env.NODE_ENV}`).handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ env });\n',
        );

        try
        {
            expect(entriesOf(await generate())).toEqual(['env: { method: \'GET\', path: \'/production\' },']);
        }
        finally
        {
            if (shellValue === undefined)
            {
                delete process.env.NODE_ENV;
            }
            else
            {
                process.env.NODE_ENV = shellValue;
            }
        }
    });
});

describe('route-map generator - package routers', () =>
{
    /** An app route and a package route under one name, as `@spfn/auth` mounts. */
    function writeCollidingRouter(): void
    {
        writeRouter(
            'const appLogout = route.post(\'/logout\').handler(async () => ({}));\n'
            + 'const packageLogout = route.post(\'/_auth/logout\').handler(async () => ({}));\n\n'
            + 'const authRouter = defineRouter({ logout: packageLogout });\n\n'
            + 'export const appRouter = defineRouter({ logout: appLogout }).packages([authRouter]);\n',
        );
    }

    it('refuses an app route a package router also registers, naming which side is the package', async () =>
    {
        writeCollidingRouter();

        await expect(generate()).rejects.toThrow(RouteMapGeneratorError);
        await expect(generate()).rejects.toThrow(/also registered by a package router/);
        await expect(generate()).rejects.toThrow(/packages\[0\]\.logout/);
    });

    it('sees the collision through a nested package router', async () =>
    {
        writeRouter(
            'const appAudit = route.get(\'/audit\').handler(async () => ({}));\n'
            + 'const packageAudit = route.get(\'/_ops/audit\').handler(async () => ({}));\n\n'
            + 'const opsRouter = defineRouter({ nested: defineRouter({ audit: packageAudit }) });\n'
            + 'const users = defineRouter({ audit: appAudit }).packages([opsRouter]);\n\n'
            + 'export const appRouter = defineRouter({ users });\n',
        );

        await expect(generate()).rejects.toThrow(/also registered by a package router/);
    });

    it('allows two package routers to share a name, which the app\'s merge order decides', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const authLogout = route.post(\'/_auth/logout\').handler(async () => ({}));\n'
            + 'const cmsLogout = route.post(\'/_cms/logout\').handler(async () => ({}));\n\n'
            + 'const authRouter = defineRouter({ logout: authLogout });\n'
            + 'const cmsRouter = defineRouter({ logout: cmsLogout });\n\n'
            + 'export const appRouter = defineRouter({ getRoot }).packages([authRouter, cmsRouter]);\n',
        );

        expect(entriesOf(await generate())).toEqual(['getRoot: { method: \'GET\', path: \'/\' },']);
    });

    it('does not refuse a package route that is missing a method', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const halfBuilt = route.post(\'/_auth/login\');\n\n'
            + 'const authRouter = defineRouter({ halfBuilt } as any);\n\n'
            + 'export const appRouter = defineRouter({ getRoot }).packages([authRouter]);\n',
        );

        expect(entriesOf(await generate())).toEqual(['getRoot: { method: \'GET\', path: \'/\' },']);
    });
});

describe('route-map generator - the method it emits', () =>
{
    it('refuses a method the generated file could not be typed with', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'getRoot.method = \'get\' as any;\n\n'
            + 'export const appRouter = defineRouter({ getRoot });\n',
        );

        await expect(generate()).rejects.toThrow(RouteMapGeneratorError);
        await expect(generate()).rejects.toThrow(/is not an HttpMethod/);
    });

    it('refuses a method that is only a property of Object.prototype', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'getRoot.method = \'toString\' as any;\n\n'
            + 'export const appRouter = defineRouter({ getRoot });\n',
        );

        await expect(generate()).rejects.toThrow(/is not an HttpMethod/);
    });
});

describe('route-map generator - tsconfig path aliases', () =>
{
    /** A route module reached only through the project's own `@/*` alias. */
    function writeAliasedRoutes(): void
    {
        writeFile(
            'src/server/routes/users.ts',
            `import { route } from '${ROUTE_BUILDER_MODULE}';\n\n`
            + 'export const listUsers = route.get(\'/users\').handler(async () => ({}));\n',
        );
        writeRouter(
            'import { listUsers } from \'@/server/routes/users\';\n\n'
            + 'export const appRouter = defineRouter({ listUsers });\n',
        );
    }

    it('loads a router that imports through the project\'s "@/*" alias', async () =>
    {
        writeAliasedRoutes();
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(entriesOf(await generate())).toEqual(['listUsers: { method: \'GET\', path: \'/users\' },']);
    });

    it('reads the alias through an extends chain and a baseUrl', async () =>
    {
        writeAliasedRoutes();
        writeFile('tsconfig.paths.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
        writeFile('tsconfig.json', JSON.stringify({ extends: './tsconfig.paths.json', compilerOptions: { strict: true } }));

        expect(entriesOf(await generate())).toEqual(['listUsers: { method: \'GET\', path: \'/users\' },']);
    });

    it('loads a router whose aliases live only in src/server/tsconfig.json', async () =>
    {
        // What `spfn init` scaffolds, and the tsconfig `spfn build` compiles the
        // server with. A backend-only app has `@/*` nowhere else.
        writeAliasedRoutes();
        writeFile(
            'src/server/tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@/*': ['./src/*'] } } }),
        );

        expect(entriesOf(await generate())).toEqual(['listUsers: { method: \'GET\', path: \'/users\' },']);
    });

    it('names the unresolved specifier when the alias is not configured', async () =>
    {
        writeAliasedRoutes();

        const thrown = await generate().catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(RouteMapGeneratorError);
        expect((thrown as Error).message).toContain('@/server/routes/users');
        expect((thrown as Error).message).toContain('did not resolve');
        expect((thrown as Error).message).not.toContain('without side effects');
    });
});

describe('route-map generator - a package router that publishes no route map', () =>
{
    /**
     * The ops surface, as `createOpsRouter` builds it: an app route and an ops
     * command under one name, which is what naming an ops command after the
     * surface it inspects produces.
     */
    function writeOpsCollision(body = ''): void
    {
        writeRouter(
            'const listExamples = route.get(\'/examples\').handler(async () => ({}));\n'
            + 'const opsListExamples = route.get(\'/_ops/examples\').handler(async () => ({}));\n\n'
            + 'const opsRouter = defineUnmappedRouter({ listExamples: opsListExamples });\n\n'
            + body
            + 'export const appRouter = defineRouter({ listExamples }).packages([opsRouter]);\n',
        );
    }

    it('allows an app route whose name it shares, because no merge overwrites it', async () =>
    {
        writeOpsCollision();

        expect(entriesOf(await generate())).toEqual([
            'listExamples: { method: \'GET\', path: \'/examples\' },',
        ]);
    });

    it('leaves its routes out of the map, exactly as a published package router is left out', async () =>
    {
        writeOpsCollision();
        await generate();

        expect(Object.keys(loadGeneratedMap())).toEqual(['listExamples']);
        expect(loadGeneratedMap().listExamples.path).toBe('/examples');
    });

    it('is skipped at any depth below itself', async () =>
    {
        writeRouter(
            'const purge = route.post(\'/purge\').handler(async () => ({}));\n'
            + 'const opsPurge = route.post(\'/_ops/cache/purge\').handler(async () => ({}));\n\n'
            + 'const cache = defineRouter({ purge: opsPurge });\n'
            + 'const opsRouter = defineUnmappedRouter({ cache });\n\n'
            + 'export const appRouter = defineRouter({ purge }).packages([opsRouter]);\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'purge: { method: \'POST\', path: \'/purge\' },',
        ]);
    });

    it('is skipped when a published package router mounts it', async () =>
    {
        writeRouter(
            'const audit = route.get(\'/audit\').handler(async () => ({}));\n'
            + 'const opsAudit = route.get(\'/_ops/audit\').handler(async () => ({}));\n'
            + 'const login = route.post(\'/_auth/login\').handler(async () => ({}));\n\n'
            + 'const opsRouter = defineUnmappedRouter({ audit: opsAudit });\n'
            + 'const authRouter = defineRouter({ login }).packages([opsRouter]);\n\n'
            + 'export const appRouter = defineRouter({ audit }).packages([authRouter]);\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'audit: { method: \'GET\', path: \'/audit\' },',
        ]);
    });

    it('still refuses the collision with a package that does publish a map', async () =>
    {
        writeRouter(
            'const appLogout = route.post(\'/logout\').handler(async () => ({}));\n'
            + 'const packageLogout = route.post(\'/_auth/logout\').handler(async () => ({}));\n'
            + 'const opsLogout = route.post(\'/_ops/logout\').handler(async () => ({}));\n\n'
            + 'const opsRouter = defineUnmappedRouter({ logout: opsLogout });\n'
            + 'const authRouter = defineRouter({ logout: packageLogout });\n\n'
            + 'export const appRouter = defineRouter({ logout: appLogout })\n'
            + '    .packages([opsRouter, authRouter]);\n',
        );

        await expect(generate()).rejects.toThrow(/also registered by a package router/);
        await expect(generate()).rejects.toThrow(/packages\[1\]\.logout/);
    });
});

describe('route-map generator - it scans the router it was pointed at', () =>
{
    it('generates for an app whose file also declares an unmounted conditional router', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const testRoute = route.get(\'/__test\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ getRoot });\n\n'
            + 'export const testRouter = defineRouter({\n'
            + '    ...(process.env.ENABLE_TEST ? { testRoute } : {}),\n'
            + '});\n',
        );

        expect(entriesOf(await generate())).toEqual(['getRoot: { method: \'GET\', path: \'/\' },']);
    });

    it('still refuses a conditional spread in a nested router the app router mounts', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const purge = route.post(\'/admin/purge\').handler(async () => ({}));\n\n'
            + 'const admin = defineRouter({ ...(process.env.ENABLE_ADMIN ? { purge } : {}) });\n\n'
            + 'export const appRouter = defineRouter({ getRoot, admin });\n',
        );

        await expect(generate()).rejects.toThrow(ConditionalRegistrationError);
        expect(existsSync(join(projectDir, OUTPUT_PATH))).toBe(false);
    });

    it('refuses the conditional in a router it found by falling back to "router"', async () =>
    {
        // `appRouter` is absent, so the loader takes `router` — and the guard has
        // to read that one, not the first defineRouter the file happens to write.
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const admin = route.get(\'/admin\').handler(async () => ({}));\n\n'
            + 'export const helperRouter = defineRouter({ getRoot });\n\n'
            + 'export const router = defineRouter({\n'
            + '    ...(process.env.ENABLE_ADMIN ? { admin } : {}),\n'
            + '});\n',
        );

        await expect(generate()).rejects.toThrow(ConditionalRegistrationError);
    });

    it('accepts a static helper spread, as @spfn/mcp writes its router', async () =>
    {
        writeFile(
            'src/server/metadata.ts',
            `import { route } from '${ROUTE_BUILDER_MODULE}';\n\n`
            + 'export function metadataRoutes(prefix)\n'
            + '{\n'
            + '    return {\n'
            + '        wellKnown: route.get(`${prefix}/.well-known`).handler(async () => ({})),\n'
            + '    };\n'
            + '}\n',
        );
        writeRouter(
            'import { metadataRoutes } from \'./metadata\';\n\n'
            + 'const mcpPost = route.post(\'/mcp\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({\n'
            + '    mcpPost,\n'
            + '    ...metadataRoutes(\'/mcp\'),\n'
            + '});\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'mcpPost: { method: \'POST\', path: \'/mcp\' },',
            'wellKnown: { method: \'GET\', path: \'/mcp/.well-known\' },',
        ]);
    });

    it('accepts a JSDoc that spells a conditional defineRouter in prose', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + '/**\n'
            + ' * The app router.\n'
            + ' *\n'
            + ' * Written as defineRouter({ ... }); a flag-gated route would read\n'
            + ' * defineRouter({ ...(flags.beta ? { betaRoute } : {}) }) and is refused.\n'
            + ' */\n'
            + 'export const appRouter = defineRouter({ getRoot });\n',
        );

        expect(entriesOf(await generate())).toEqual(['getRoot: { method: \'GET\', path: \'/\' },']);
    });
});
