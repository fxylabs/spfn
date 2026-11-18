/**
 * The codegen loader, in this process — rows R3–R7 and R10 of the #335 design
 *
 * Each fixture is an app in a temporary directory with no `"type"` in its
 * package.json and `@spfn/core` linked into its `node_modules`, so the router
 * imports the built package as an app does. The loader's `import()` is Node's
 * own even under vitest (`../loader/register.ts`), so these rows run the real
 * hooks; the rows that need the CLI's processes and tsx beside the hooks (R1,
 * R2, R8, R9) are in the CLI's `codegen-loader.test.ts`.
 *
 * | #   | fixture                                                              | what would otherwise pass silently                  |
 * |-----|----------------------------------------------------------------------|-----------------------------------------------------|
 * | R3  | a package with a module-scope counter, three generations, a project  | packages re-evaluated on every load (copies, leak)  |
 * |     | route that reads NODE_ENV so every generation varies it              |                                                     |
 * | R4  | `paths` only in `src/server/tsconfig.json` (`baseUrl: ../..`), read  | resolving through the root tsconfig only            |
 * |     | from a route module two directories below the router                 |                                                     |
 * | R5  | `@/*: ["./dist/*", "./src/*"]` with a partial `dist`                 | one target per key, for every import                |
 * | R6  | a route module conditional on NODE_ENV, below type-only lines        | the proxy restored before the ESM graph evaluates;  |
 * |     |                                                                      | a line number of the transform, not the source      |
 * | R7  | a package's NODE_ENV-dependent route, and an unrelated project read  | the verdict flipping on an unrelated project file   |
 * | R10 | `.spfnrc.ts` importing `@spfn/core/codegen` in a type-less app       | `loadCodegenConfig` turning asynchronous            |
 * | R11 | a `"type": "module"` app importing JSON with and without             | JSON served as a module's source (`Unexpected token`)|
 * |     | `with { type: 'json' }`, then the JSON edited                        | or read once per process (a stale map)              |
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createRouteMapGenerator } from '../generators/route-map';
import { CodegenOrchestrator } from '../core/orchestrator';
import { loadCodegenConfig } from '../core/config-loader';
import { ConditionalRegistrationError } from '../generators/contract-guard';
import { routerFiles } from '../generators/router-module';

const CORE_PACKAGE = resolve(__dirname, '../../..');
const OUTPUT_PATH = 'src/generated/route-map.ts';

let appDir: string;

function write(path: string, content: string): void
{
    mkdirSync(dirname(join(appDir, path)), { recursive: true });
    writeFileSync(join(appDir, path), content, 'utf-8');
}

/** A counter on `globalThis`, bumped each time the module it is written into is evaluated. */
function counts(name: string): string
{
    return `globalThis.${name} = (globalThis.${name} ?? 0) + 1;\n`;
}

function evaluations(name: string): number
{
    return (globalThis as unknown as Record<string, number | undefined>)[name] ?? 0;
}

/** A package under the app's `node_modules`, ESM by its `type`, importing the built `@spfn/core`. */
function writePackage(name: string, source: string): void
{
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, type: 'module', main: 'index.js' }));
    write(`node_modules/${name}/index.js`, source);
}

async function generate(): Promise<string>
{
    const generator = createRouteMapGenerator({
        name: '@spfn/core:route-map',
        routerPath: './src/server/router.ts',
        outputPath: `./${OUTPUT_PATH}`,
    });

    await new CodegenOrchestrator({ generators: [generator], cwd: appDir, throwOnError: true }).generateAll('manual');

    return readFileSync(join(appDir, OUTPUT_PATH), 'utf-8');
}

function pathsOf(content: string): string[]
{
    return [...content.matchAll(/path: '([^']+)'/g)].map(match => match[1]);
}

beforeEach(() =>
{
    appDir = mkdtempSync(join(tmpdir(), 'spfn-codegen-loader-'));
    write('package.json', JSON.stringify({ name: 'loader-fixture', private: true }));
    mkdirSync(join(appDir, 'node_modules/@spfn'), { recursive: true });
    symlinkSync(CORE_PACKAGE, join(appDir, 'node_modules/@spfn/core'), 'dir');
});

afterEach(() =>
{
    rmSync(appDir, { recursive: true, force: true });
});

describe('codegen loader - packages evaluate once, the project on every load', () =>
{
    it('R3 a package\'s module scope runs once over three generations with the environment varied, the project\'s on every load', async () =>
    {
        const packageCounter = `__r3Package_${Date.now()}`;
        const projectCounter = `__r3Project_${Date.now()}`;

        writePackage('r3-pkg', counts(packageCounter)
            + 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'export const pkgRouter = defineRouter({ r3Status: route.get(\'/_r3/status\').handler(async () => ({})) });\n');
        write('src/server/routes/probe.ts', counts(projectCounter)
            + 'import { route } from \'@spfn/core/route\';\n'
            + 'const verbose = process.env.NODE_ENV !== \'production\';\n'
            + 'export const getProbe = route.get(\'/probe\').handler(async () => ({ verbose }));\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { pkgRouter } from \'r3-pkg\';\n'
            + 'import { getProbe } from \'./routes/probe\';\n'
            + 'export const appRouter = defineRouter({ getProbe }).packages([pkgRouter]);\n');

        for (let run = 0; run < 3; run++)
        {
            expect(pathsOf(await generate())).toEqual(['/probe', '/_r3/status']);
        }

        expect(evaluations(packageCounter)).toBe(1);
        // A baseline load and a load per varied NODE_ENV value, each generation.
        expect(evaluations(projectCounter)).toBe(9);
    });

    it('R7 a package\'s NODE_ENV-dependent route is not refused because an unrelated project file reads NODE_ENV', async () =>
    {
        writePackage('r7-pkg', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'const zzStatus = route.get(\'/_zz/status\').handler(async () => ({}));\n'
            + 'const zzDebug = route.get(\'/_zz/debug\').handler(async () => ({}));\n'
            + 'export const zzRouter = defineRouter({ zzStatus, ...(process.env.NODE_ENV !== \'production\' ? { zzDebug } : {}) });\n');
        write('src/server/routes/probe.ts', 'import { route } from \'@spfn/core/route\';\n'
            + 'const verbose = process.env.NODE_ENV !== \'production\';\n'
            + 'export const getProbe = route.get(\'/probe\').handler(async () => ({ verbose }));\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { zzRouter } from \'r7-pkg\';\n'
            + 'import { getProbe } from \'./routes/probe\';\n'
            + 'export const appRouter = defineRouter({ getProbe }).packages([zzRouter]);\n');

        expect(pathsOf(await generate())).toEqual(['/probe', '/_zz/status']);
    });
});

describe('codegen loader - resolution', () =>
{
    it('R4 resolves `paths` declared only in src/server/tsconfig.json, from a file two directories below the router', async () =>
    {
        write('src/server/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@/*': ['./src/*'] } } }));
        write('src/server/lib/segment.ts', 'export const segment: string = \'r4\';\n');
        write('src/server/routes/admin/users.ts', 'import { route } from \'@spfn/core/route\';\n'
            + 'import { segment } from \'@/server/lib/segment\';\n'
            + 'export const listUsers = route.get(`/${segment}/users`).handler(async () => ({}));\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { listUsers } from \'@/server/routes/admin/users\';\n'
            + 'export const appRouter = defineRouter({ listUsers });\n');

        expect(pathsOf(await generate())).toEqual(['/r4/users']);
    });

    it('R5 tries every target of a `paths` entry per import: one module from a partial dist, another only in src', async () =>
    {
        write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./dist/*', './src/*'] } } }));
        write('dist/server/lib/segment.js', 'export const segment = \'from-dist\';\n');
        write('src/server/lib/segment.ts', 'export const segment: string = \'from-src\';\n');
        write('src/server/routes/users.ts', 'import { route } from \'@spfn/core/route\';\n'
            + 'import { segment } from \'@/server/lib/segment\';\n'
            + 'export const listUsers = route.get(`/${segment}`).handler(async () => ({}));\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { listUsers } from \'@/server/routes/users\';\n'
            + 'export const appRouter = defineRouter({ listUsers });\n');

        expect(pathsOf(await generate())).toEqual(['/from-dist']);
    });
});

describe('codegen loader - JSON', () =>
{
    it('R11 a "type": "module" app imports JSON in both forms, and the next generation reads an edited file', async () =>
    {
        write('package.json', JSON.stringify({ name: 'loader-fixture', private: true, type: 'module' }));
        write('src/server/segments.json', JSON.stringify({ first: 'one' }));
        write('src/server/more.json', JSON.stringify({ second: 'two' }));
        write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'import segments from \'./segments.json\' with { type: \'json\' };\n'
            + 'import more from \'./more.json\';\n'
            + 'import { second } from \'./more.json\';\n'
            + 'const first = route.get(`/${segments.first}`).handler(async () => ({}));\n'
            + 'const other = route.get(`/${more.second}/${second}`).handler(async () => ({}));\n'
            + 'export const appRouter = defineRouter({ first, other });\n');

        expect(pathsOf(await generate())).toEqual(['/one', '/two/two']);

        write('src/server/segments.json', JSON.stringify({ first: 'uno' }));

        expect(pathsOf(await generate())).toEqual(['/uno', '/two/two']);
        expect([...routerFiles().get(join(appDir, 'src/server/router.ts')) ?? []])
            .toContain(realpathSync(join(appDir, 'src/server/segments.json')));
    });
});

describe('codegen loader - the environment probe across the asynchronous load', () =>
{
    it('R6 a route module conditional on NODE_ENV is refused, naming the key and its line in the source', async () =>
    {
        write('src/server/routes/admin.ts', 'import type { RouteDef } from \'@spfn/core/route\';\n'
            + 'import { route } from \'@spfn/core/route\';\n'
            + '\n'
            + 'interface Unused { a: RouteDef<any> }\n'
            + 'type Also = Unused;\n'
            + '\n'
            + 'const enabled = process.env.NODE_ENV !== \'production\';\n'
            + 'const admin = route.get(\'/admin\').handler(async () => ({}));\n'
            + 'export const adminRoutes = enabled ? { admin } : {};\n');
        write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'import { adminRoutes } from \'./routes/admin\';\n'
            + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'export const appRouter = defineRouter({ getRoot, ...adminRoutes });\n');

        const refusal = await generate().then(() => undefined, (error: Error) => error);

        expect(refusal).toBeInstanceOf(ConditionalRegistrationError);
        expect(refusal?.message).toContain('NODE_ENV (read at src/server/routes/admin.ts:7), production → development');
        expect(refusal?.message).toContain('+ admin (GET /admin)');
    });
});

describe('codegen loader - .spfnrc.ts', () =>
{
    it('R10 loadCodegenConfig returns the config itself, synchronously, from a .spfnrc.ts importing @spfn/core/codegen', () =>
    {
        write('.spfnrc.ts', 'import { defineConfig, defineGenerator } from \'@spfn/core/codegen\';\n'
            + 'const routerPath: string = \'./src/server/router.ts\';\n'
            + 'export default defineConfig({ generators: [defineGenerator({ name: \'@spfn/core:route-map\', routerPath })] });\n');

        const config = loadCodegenConfig(appDir);

        expect(config).not.toBeInstanceOf(Promise);
        expect(config.generators).toEqual([{ name: '@spfn/core:route-map', routerPath: './src/server/router.ts' }]);
    });
});
