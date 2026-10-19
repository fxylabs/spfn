/**
 * States Generator Tests
 *
 * | #   | situation                                                              | expected                                                   |
 * |-----|------------------------------------------------------------------------|------------------------------------------------------------|
 * | G1  | one state router (`consent`, `member`, `workspaces`) mounted with `.packages()` | the documented output, byte for byte               |
 * | G2  | two state routers mounted `[a.router, b.router]`                       | a's ids then b's, each in declaration order                |
 * | G3  | two state routers both declaring `consent`                             | refused; the message names both trails                     |
 * | G4  | a package router that mounted the state router, mounted by the app     | collected once; G1 output                                  |
 * | G5  | the state router nested in `routes`                                    | collected, before `_packageRouters`                        |
 * | G6  | `states.router.use([...])` then mounted                                | collected; `_surfaceNamespace` survives the chain too      |
 * | G7  | an app router mounting no state router                                 | refused; the message names the router path                 |
 * | G8  | router file missing                                                    | warn, no output file                                       |
 * | G9  | a manifest id that is not an identifier (`'my-state'`)                 | key quoted; the file loads and `stateIds` holds it         |
 * | G10 | generate twice                                                         | second run byte-identical                                  |
 * | G11 | the G1 output committed as `fixtures/states.generated.ts`              | equal to it; `StateId` is the union of the three ids       |
 * | G12 | a conditional spread in the router                                     | `ConditionalRegistrationError`                             |
 * | G13 | keyed state with two key fields `{ a, b }`                             | `key: ['a', 'b']` in that order                            |
 * | G14 | the generated `stateManifest`, loaded                                  | deep-equal to `stateManifest(list)` for the same states    |
 * | G15 | the route-map generator on the G1 fixture                              | its output is what it was before this generator existed    |
 * | G16 | `defineStateRouter({}).router` mounted, nothing else declares a state  | written; `stateIds` `[]`, `stateManifest` `{}`; it loads   |
 * | G16b| an empty state router mounted beside a non-empty one                   | the non-empty one's ids, no refusal                        |
 * | G17 | the `.spfnrc.ts` fence of `state/README.md`, as a project's config     | `loadCodegenConfig` finds the `@spfn/core:states` entry    |
 *
 * Every fixture is a real router file written to a temporary directory and
 * loaded for real — jiti is not mocked. The state modules import
 * `@spfn/core/state` and `@spfn/core/route` as an app does; the fixture's
 * `tsconfig.json` maps `@spfn/core/*` to this package's sources, the alias
 * mechanism the route-map tests exercise. `@sinclair/typebox` is imported by
 * absolute path, since the temporary directory has no node_modules — except in
 * G17, where the README's config imports `@spfn/core/codegen` as an app does
 * and the project's `node_modules/@spfn/core` links to this (built) package.
 */

import { Type } from '@sinclair/typebox';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createJiti } from 'jiti';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Logger } from '@spfn/core/logger';
import { createRouteMapGenerator } from '../generators/route-map';
import { createStatesGenerator, StatesGeneratorError } from '../generators/states';
import { loadCodegenConfig } from '../core/config-loader';
import { ConditionalRegistrationError } from '../generators/contract-guard';
import { defineRouter } from '../../route/router';
import { defineState } from '../../state/state-builder';
import { stateManifest } from '../../state/state-routes';
import type { StateId } from './fixtures/states.generated';

const OUTPUT_PATH = 'src/generated/states.ts';
const ROUTE_MAP_PATH = 'src/generated/route-map.ts';

const CORE_SRC = resolve(__dirname, '../..').replace(/\\/g, '/');
const CORE_PACKAGE = resolve(__dirname, '../../..');
const TYPEBOX_MODULE = createRequire(__filename).resolve('@sinclair/typebox').replace(/\\/g, '/');
const FIXTURE = readFileSync(join(__dirname, 'fixtures/states.generated.ts'), 'utf-8');

const STATE_IMPORTS = `import { Type } from '${TYPEBOX_MODULE}';\n`
    + 'import { defineState, defineStateRouter } from \'@spfn/core/state\';\n\n';

const ROUTER_IMPORTS = 'import { defineRouter, route } from \'@spfn/core/route\';\n';

/** A keyless state, with a write when `write` is set. */
function keyless(id: string, write = false): string
{
    return `defineState('${id}')\n`
        + '    .value(Type.String())\n'
        + '    .read(async () => ({ value: \'v\' }))'
        + (write ? '\n    .write(Type.Object({ v: Type.String() }), async () => {})' : '');
}

/** A keyed state, its key fields in the order given. */
function keyed(id: string, fields: string[]): string
{
    return `defineState('${id}')\n`
        + `    .key(Type.Object({ ${fields.map(field => `${field}: Type.String()`).join(', ')} }))\n`
        + '    .value(Type.String())\n'
        + '    .canRead(() => true)\n'
        + '    .read(async () => ({ value: \'v\' }))';
}

/** `export const <name> = defineStateRouter({ ... })` over the given declarations. */
function stateRouter(name: string, declarations: Record<string, string>): string
{
    const entries = Object.entries(declarations).map(([id, source]) => `    ${id}: ${source.replace(/\n/g, '\n    ')},`);

    return `export const ${name} = defineStateRouter({\n${entries.join('\n')}\n}, { path: '/${name}' });\n`;
}

/** The G1 states: `consent` keyless with a write, `member` keyed, `workspaces` keyless. */
const G1_STATES = {
    consent: keyless('consent', true),
    member: keyed('member', ['workspaceId']),
    workspaces: keyless('workspaces'),
};

let projectDir: string;

function writeFile(relativePath: string, content: string): void
{
    const absolutePath = join(projectDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

function writeStates(body: string): void
{
    writeFile('src/server/states.ts', STATE_IMPORTS + body);
}

function writeRouter(body: string): void
{
    writeFile('src/server/router.ts', ROUTER_IMPORTS + body);
}

async function generate(): Promise<string>
{
    await createStatesGenerator({
        name: '@spfn/core:states',
        routerPath: './src/server/router.ts',
        outputPath: `./${OUTPUT_PATH}`,
    }).generate({ cwd: projectDir, trigger: { type: 'manual' } });

    return readFileSync(join(projectDir, OUTPUT_PATH), 'utf-8');
}

/** The generated file, loaded: what a browser root executes. */
function loadGenerated(): { stateIds: string[]; stateManifest: Record<string, { key: string[]; write: boolean }> }
{
    return createJiti(projectDir, { interopDefault: true, moduleCache: false })(join(projectDir, OUTPUT_PATH));
}

/** The `id: { key, write }` lines, in the order they were written. */
function entriesOf(content: string): string[]
{
    return content
        .split('\n')
        .filter(line => line.includes('{ key:'))
        .map(line => line.trim());
}

/** The G1 project: the states in their own module, mounted with `.packages()`. */
function writeG1(): void
{
    writeStates(stateRouter('states', G1_STATES));
    writeRouter(
        'import { states } from \'./states\';\n\n'
        + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
        + 'export const appRouter = defineRouter({ getRoot }).packages([states.router]);\n',
    );
}

/** Every warning a generate emitted, joined. */
async function warningsOf(call: () => Promise<unknown>): Promise<string>
{
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() =>
    {
    });

    try
    {
        await call();

        return warn.mock.calls.map(([message]) => String(message)).join('\n');
    }
    finally
    {
        warn.mockRestore();
    }
}

let shellNodeEnv: string | undefined;

beforeEach(() =>
{
    projectDir = mkdtempSync(join(tmpdir(), 'spfn-states-'));
    writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@spfn/core/*': [`${CORE_SRC}/*`] } } }));
    shellNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
});

afterEach(() =>
{
    rmSync(projectDir, { recursive: true, force: true });

    if (shellNodeEnv === undefined)
    {
        delete process.env.NODE_ENV;
    }
    else
    {
        process.env.NODE_ENV = shellNodeEnv;
    }
});

describe('states generator - what it collects', () =>
{
    it('G1 writes the ids and the manifest of one mounted state router, byte for byte', async () =>
    {
        writeG1();

        expect(await generate()).toBe(FIXTURE);
    });

    it('G2 writes the states of two mounted state routers in mount order, each in declaration order', async () =>
    {
        writeStates(
            stateRouter('a', { workspaces: keyless('workspaces'), consent: keyless('consent', true) })
            + stateRouter('b', { member: keyed('member', ['workspaceId']), billing: keyless('billing') }),
        );
        writeRouter(
            'import { a, b } from \'./states\';\n\n'
            + 'export const appRouter = defineRouter({}).packages([a.router, b.router]);\n',
        );

        await generate();

        expect(loadGenerated().stateIds).toEqual(['workspaces', 'consent', 'member', 'billing']);
    });

    it('G4 collects a state router once when a mounted package router had mounted it', async () =>
    {
        writeStates(stateRouter('states', G1_STATES));
        writeRouter(
            'import { states } from \'./states\';\n\n'
            + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const authRouter = defineRouter({}).packages([states.router]);\n\n'
            + 'export const appRouter = defineRouter({ getRoot }).packages([authRouter]);\n',
        );

        expect(await generate()).toBe(FIXTURE);
    });

    it('G5 collects a state router nested in routes, before the mounted package routers', async () =>
    {
        writeStates(
            stateRouter('nested', { member: keyed('member', ['workspaceId']) })
            + stateRouter('mounted', { consent: keyless('consent', true) }),
        );
        writeRouter(
            'import { nested, mounted } from \'./states\';\n\n'
            + 'export const appRouter = defineRouter({ state: nested.router }).packages([mounted.router]);\n',
        );

        await generate();

        expect(loadGenerated().stateIds).toEqual(['member', 'consent']);
    });

    it('G6 collects a state router rebuilt by .use(), and _surfaceNamespace survives every chainable method', async () =>
    {
        writeStates(stateRouter('states', G1_STATES));
        writeRouter(
            'import { states } from \'./states\';\n\n'
            + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'const audit = { name: \'audit\', handler: async (_c: unknown, next: () => Promise<void>) => next() };\n\n'
            + 'export const appRouter = defineRouter({ getRoot }).packages([states.router.use([audit as any])]);\n',
        );

        expect(await generate()).toBe(FIXTURE);

        const surface = Object.defineProperty(defineRouter({}), '_surfaceNamespace', { value: 'ops', enumerable: false });

        for (const rebuilt of [surface.use([]), surface.contractVersion('1.0.0'), surface.packages([])])
        {
            expect(rebuilt._surfaceNamespace).toBe('ops');
            expect(Object.keys(rebuilt)).not.toContain('_surfaceNamespace');
        }
    });

    it('G13 writes the key fields of a keyed state in their declared order', async () =>
    {
        writeStates(stateRouter('states', { pair: keyed('pair', ['b', 'a']), other: keyed('other', ['a', 'b']) }));
        writeRouter(
            'import { states } from \'./states\';\n\n'
            + 'export const appRouter = defineRouter({}).packages([states.router]);\n',
        );

        expect(entriesOf(await generate())).toEqual([
            'pair: { key: [\'b\', \'a\'], write: false },',
            'other: { key: [\'a\', \'b\'], write: false },',
        ]);
    });
});

describe('states generator - an empty state router', () =>
{
    it('G16 writes no id and an empty manifest for a mounted state router declaring no state', async () =>
    {
        writeStates(stateRouter('states', {}));
        writeRouter(
            'import { states } from \'./states\';\n\n'
            + 'export const appRouter = defineRouter({}).packages([states.router]);\n',
        );

        const content = await generate();

        expect(content).toContain('export const stateIds = [] as const;\n');
        expect(content).toContain(
            'export const stateManifest: Readonly<Record<StateId, { readonly key: readonly string[]; readonly write: boolean }>> = {\n};\n',
        );
        expect(loadGenerated().stateIds).toEqual([]);
        expect(loadGenerated().stateManifest).toEqual({});
    });

    it('G16b writes the states of a state router mounted beside an empty one', async () =>
    {
        writeStates(stateRouter('empty', {}) + stateRouter('states', G1_STATES));
        writeRouter(
            'import { empty, states } from \'./states\';\n\n'
            + 'export const appRouter = defineRouter({}).packages([empty.router, states.router]);\n',
        );

        await generate();

        expect(loadGenerated().stateIds).toEqual(['consent', 'member', 'workspaces']);
    });
});

describe('states generator - what it refuses', () =>
{
    it('G3 refuses two state routers declaring the same id, naming both trails', async () =>
    {
        writeStates(
            stateRouter('a', { consent: keyless('consent', true) })
            + stateRouter('b', { consent: keyless('consent') }),
        );
        writeRouter(
            'import { a, b } from \'./states\';\n\n'
            + 'export const appRouter = defineRouter({ nested: a.router }).packages([b.router]);\n',
        );

        const refusal = generate();

        await expect(refusal).rejects.toThrow(StatesGeneratorError);
        await expect(refusal).rejects.toThrow(/"consent" \(router\.nested and router\.packages\[0\]\)/);
        expect(existsSync(join(projectDir, OUTPUT_PATH))).toBe(false);
    });

    it('G7 refuses an app router that mounts no state router, naming the router path', async () =>
    {
        writeRouter(
            'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ getRoot });\n',
        );

        const refusal = generate();

        await expect(refusal).rejects.toThrow(StatesGeneratorError);
        await expect(refusal).rejects.toThrow(/No state router is mounted by \.\/src\/server\/router\.ts/);
        expect(existsSync(join(projectDir, OUTPUT_PATH))).toBe(false);
    });

    it('G8 warns and writes nothing when the router file is missing', async () =>
    {
        const warnings = await warningsOf(() => createStatesGenerator({
            name: '@spfn/core:states',
            routerPath: './src/server/router.ts',
        }).generate({ cwd: projectDir, trigger: { type: 'manual' } }));

        expect(warnings).toMatch(/Router file not found/);
        expect(existsSync(join(projectDir, OUTPUT_PATH))).toBe(false);
    });

    it('G12 refuses a router that mounts conditionally', async () =>
    {
        writeStates(stateRouter('states', G1_STATES));
        writeRouter(
            'import { states } from \'./states\';\n\n'
            + 'const admin = route.get(\'/admin\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({\n'
            + '    ...(process.env.ENABLE_ADMIN ? { admin } : {}),\n'
            + '}).packages([states.router]);\n',
        );

        await expect(generate()).rejects.toThrow(ConditionalRegistrationError);
        expect(existsSync(join(projectDir, OUTPUT_PATH))).toBe(false);
    });
});

describe('states generator - the file it writes', () =>
{
    it('G9 quotes an id that is not an identifier, and the file still loads', async () =>
    {
        // `defineState` accepts lowerCamel ids only, so the marker is set by
        // hand: the generator spells whatever the manifest holds, through the
        // same `toObjectKey` the route map uses.
        writeRouter(
            'const odd = Object.defineProperty(defineRouter({}), \'_stateManifest\', {\n'
            + '    value: { \'my-state\': { key: [], write: false } },\n'
            + '    enumerable: false,\n'
            + '});\n\n'
            + 'export const appRouter = defineRouter({}).packages([odd]);\n',
        );

        expect(entriesOf(await generate())).toEqual(['"my-state": { key: [], write: false },']);
        expect(loadGenerated().stateIds).toEqual(['my-state']);
    });

    it('G10 regenerates byte-identically', async () =>
    {
        writeG1();

        const first = await generate();

        expect(await generate()).toBe(first);
    });

    it('G11 matches the committed fixture, whose StateId is the union of the declared ids', async () =>
    {
        writeG1();

        expect(await generate()).toBe(FIXTURE);
        expectTypeOf<StateId>().toEqualTypeOf<'consent' | 'member' | 'workspaces'>();
    });

    it('G14 writes the manifest stateManifest() builds for the same states', async () =>
    {
        writeG1();
        await generate();

        const list = [
            defineState('consent').value(Type.String()).read(async () => ({ value: 'v' }))
                .write(Type.Object({ v: Type.String() }), async () =>
                {
                }),
            defineState('member').key(Type.Object({ workspaceId: Type.String() })).value(Type.String())
                .canRead(() => true).read(async () => ({ value: 'v' })),
            defineState('workspaces').value(Type.String()).read(async () => ({ value: 'v' })),
        ];

        expect(loadGenerated().stateManifest).toEqual(stateManifest(list as any));
    });

    it('G15 leaves the route map of the same router as it was', async () =>
    {
        writeG1();

        await createRouteMapGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: `./${ROUTE_MAP_PATH}`,
        }).generate({ cwd: projectDir, trigger: { type: 'manual' } });

        const routeMap = readFileSync(join(projectDir, ROUTE_MAP_PATH), 'utf-8');

        expect(routeMap.slice(routeMap.indexOf('export const routeMap'))).toBe(
            'export const routeMap: Record<string, RouteInfo> = {\n'
            + '    getRoot: { method: \'GET\', path: \'/\' },\n'
            + '    // From the package routers this app mounts with .packages(), not its own:\n'
            + '    getConsentState: { method: \'GET\', path: \'/states/consent\' },\n'
            + '    putConsentState: { method: \'PUT\', path: \'/states/consent\' },\n'
            + '    getMemberState: { method: \'GET\', path: \'/states/member\' },\n'
            + '    getWorkspacesState: { method: \'GET\', path: \'/states/workspaces\' },\n'
            + '    getStates: { method: \'GET\', path: \'/states\' },\n'
            + '};\n'
            + '\n'
            + 'export type RouteMap = typeof routeMap;\n'
            + '\n'
            + 'export type RouteName = keyof RouteMap;\n',
        );
        expect(routeMap).toContain(' *   router.packages[0] — 5 routes under /states\n');
    });
});

describe('states generator - the documented config', () =>
{
    /** The first ```typescript fence after "### Declared ids at runtime" in the state README. */
    function readmeConfig(): string
    {
        const readme = readFileSync(join(CORE_PACKAGE, 'src/state/README.md'), 'utf-8');
        const section = readme.slice(readme.indexOf('### Declared ids at runtime'));

        return /```typescript\n([\s\S]*?)```/.exec(section)![1];
    }

    it('G17 loads the README\'s .spfnrc.ts as written, with its states generator', () =>
    {
        const config = readmeConfig();

        expect(config.split('\n')[0]).toBe('// .spfnrc.ts');

        writeFile('.spfnrc.ts', config);
        mkdirSync(join(projectDir, 'node_modules/@spfn'), { recursive: true });
        symlinkSync(CORE_PACKAGE, join(projectDir, 'node_modules/@spfn/core'), 'dir');

        expect(loadCodegenConfig(projectDir).generators).toEqual([expect.objectContaining({ name: '@spfn/core:states' })]);
    });
});
