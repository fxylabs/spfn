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
 * | R12 | two apps, each refused alone (a route gated on its own key), whose   | loads sharing one process.env: one app accepted,    |
 * |     | generations run side by side                                         | process.env left a Proxy                            |
 * | R13 | `experimentalDecorators: true`, a decorator that accepts only the    | standard decorators for an app written for legacy   |
 * |     | legacy call                                                          | ones: the router throws at load                     |
 * | R14 | `useDefineForClassFields: false`, a field declared over a value the  | define semantics resetting the field to undefined   |
 * |     | base constructor sets                                                |                                                     |
 * | R16 | a route module whose decorator throws at module scope, below type    | a line of the transform, the generation query,      |
 * |     | lines                                                                | helper frames, the router named as what failed      |
 * | R17 | a TypeScript syntax error in a route module                          | `Unexpected token` naming no file                   |
 * | R18 | a route module importing a file that does not exist                  | the missing path named before the importer          |
 * | R19 | `.spfnrc.ts` using `__dirname` (CommonJS) at line 4                   | a config that fails to load read as "no generators" |
 * | R21 | a custom generator file using `__dirname`                            | a configured generator skipped with a log line      |
 * | R24 | a route module failing to read `src/server/data/missing.txt`         | the file named in the message taken for the origin  |
 * | R25 | an import of a name the module does not export                       | V8's source line above the message not read         |
 * | R26 | `with { type: 'javascript' }` and an unknown attribute on JSON;       | the hook's JSON loading dropping Node's attribute   |
 * |     | `with { type: 'json' }` on a TypeScript module                       | checks                                              |
 * | R27 | a JSON file starting with U+FEFF                                     | a byte-order mark Node, tsx and esbuild accept      |
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createRouteMapGenerator } from '../generators/route-map';
import { CodegenOrchestrator } from '../core/orchestrator';
import { createGeneratorsFromConfig, loadCodegenConfig } from '../core/config-loader';
import { ConditionalRegistrationError } from '../generators/contract-guard';
import { routerFiles } from '../generators/router-module';

const CORE_PACKAGE = resolve(__dirname, '../../..');
const OUTPUT_PATH = 'src/generated/route-map.ts';

let appDir: string;

function write(path: string, content: string, root = appDir): void
{
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, 'utf-8');
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

async function generate(root = appDir): Promise<string>
{
    const generator = createRouteMapGenerator({
        name: '@spfn/core:route-map',
        routerPath: './src/server/router.ts',
        outputPath: `./${OUTPUT_PATH}`,
    });

    await new CodegenOrchestrator({ generators: [generator], cwd: root, throwOnError: true }).generateAll('manual');

    return readFileSync(join(root, OUTPUT_PATH), 'utf-8');
}

function pathsOf(content: string): string[]
{
    return [...content.matchAll(/path: '([^']+)'/g)].map(match => match[1]);
}

/** Every app a row made, removed after it. */
const apps: string[] = [];

/** A type-less app in a temporary directory, with `@spfn/core` linked into its `node_modules`. */
function makeApp(): string
{
    const root = mkdtempSync(join(tmpdir(), 'spfn-codegen-loader-'));

    apps.push(root);
    write('package.json', JSON.stringify({ name: 'loader-fixture', private: true }), root);
    mkdirSync(join(root, 'node_modules/@spfn'), { recursive: true });
    symlinkSync(CORE_PACKAGE, join(root, 'node_modules/@spfn/core'), 'dir');

    return root;
}

beforeEach(() =>
{
    appDir = makeApp();
});

afterEach(() =>
{
    apps.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
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

    it('R26 an import attribute other than type: json is refused as Node refuses it, on JSON and on a module', async () =>
    {
        write('package.json', JSON.stringify({ name: 'loader-fixture', private: true, type: 'module' }));
        write('src/server/segments.json', JSON.stringify({ first: 'one' }));
        write('src/server/routes/first.ts', 'export const first: string = \'one\';\n');

        // The imported name is used: TypeScript drops an import nothing reads.
        const refusal = async (importLine: string): Promise<{ name: string; code: string; message: string }> =>
        {
            write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
                + `${importLine}\n`
                + `export const imported = ${/import \{? ?(\w+)/.exec(importLine)![1]};\n`
                + 'export const appRouter = defineRouter({ root: route.get(\'/\').handler(async () => ({})) });\n');

            const error = await generate().then(() => undefined, (thrown: Error) => thrown.cause as Error & { code: string });

            return { name: error?.constructor.name ?? '', code: error?.code ?? '', message: error?.message ?? '' };
        };
        const segments = realpathSync(join(appDir, 'src/server/segments.json'));
        const first = realpathSync(join(appDir, 'src/server/routes/first.ts'));

        expect(await refusal('import segments from \'./segments.json\' with { type: \'javascript\' };')).toEqual({
            name: 'TypeError',
            code: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
            message: `Import attribute "type" with value "javascript" is not supported in ${segments}`,
        });
        expect(await refusal('import segments from \'./segments.json\' with { type: \'json\', mode: \'x\' };')).toEqual({
            name: 'TypeError',
            code: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
            message: `Import attribute "mode" with value "x" is not supported in ${segments}`,
        });
        expect(await refusal('import { first } from \'./routes/first\' with { type: \'json\' };')).toEqual({
            name: 'TypeError',
            code: 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE',
            message: `Module "${first}" is not of type "json"`,
        });
    });

    it('R27 a project JSON file starting with a byte-order mark loads, as Node, tsx and esbuild load it', async () =>
    {
        write('src/server/segments.json', `\uFEFF${JSON.stringify({ first: 'bom' })}`);
        write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'import segments from \'./segments.json\' with { type: \'json\' };\n'
            + 'import { first } from \'./segments.json\';\n'
            + 'const root = route.get(`/${segments.first}/${first}`).handler(async () => ({}));\n'
            + 'export const appRouter = defineRouter({ root });\n');

        expect(pathsOf(await generate())).toEqual(['/bom/bom']);
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

describe('codegen loader - the tsconfig\'s runtime options', () =>
{
    it('R13 a legacy decorator runs as one under experimentalDecorators', async () =>
    {
        write('tsconfig.json', JSON.stringify({ compilerOptions: { experimentalDecorators: true } }));
        write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'function legacyOnly(target: unknown, ...rest: unknown[]): void\n'
            + '{\n'
            + '    if (typeof target !== \'function\' || rest.length !== 0) throw new Error(\'expected legacy decorator invocation\');\n'
            + '}\n'
            + '@legacyOnly class Decorated {}\n'
            + 'const decorated = route.get(`/${Decorated.name}`).handler(async () => ({}));\n'
            + 'export const appRouter = defineRouter({ decorated });\n');

        expect(pathsOf(await generate())).toEqual(['/Decorated']);
    });

    it('R14 a declared field keeps what the base constructor set under useDefineForClassFields: false', async () =>
    {
        write('src/server/tsconfig.json', JSON.stringify({ compilerOptions: { useDefineForClassFields: false } }));
        write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'class Base { constructor() { (this as { segment?: string }).segment = \'base-set\'; } }\n'
            + 'class Child extends Base { segment!: string; }\n'
            + 'const child = route.get(`/${new Child().segment}`).handler(async () => ({}));\n'
            + 'export const appRouter = defineRouter({ child });\n');

        expect(pathsOf(await generate())).toEqual(['/base-set']);
    });
});

describe('codegen loader - a failed load names the file and line of the source', () =>
{
    /** The generation's error, and the stack of the load error it carries. */
    async function failure(): Promise<{ message: string; stack: string }>
    {
        const error = await generate().then(() => undefined, (thrown: Error) => thrown);

        return { message: error?.message ?? '', stack: String((error?.cause as Error | undefined)?.stack) };
    }

    it('R16 a decorator throwing at module scope is named at its source line, without the query or helper frames', async () =>
    {
        write('src/server/routes/boom.ts', 'import type { RouteDef } from \'@spfn/core/route\';\n'
            + 'type Unused = RouteDef<any>;\n'
            + 'function tag(value: unknown, context: unknown): void { throw new Error(\'boom in a decorator\'); }\n'
            + '@tag class Tagged {}\n'
            + 'export const tagged = Tagged;\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { tagged } from \'./routes/boom\';\n'
            + 'export const appRouter = defineRouter({ tagged });\n');

        const { message, stack } = await failure();
        const boom = realpathSync(join(appDir, 'src/server/routes/boom.ts'));

        expect(message).toMatch(/^Failed to load src\/server\/router\.ts \(at src\/server\/routes\/boom\.ts:3:\d+\): boom in a decorator/);
        expect(stack.split('\n')[1]).toMatch(new RegExp(`^\\s+at tag \\(${boom}:3:\\d+\\)$`));
        expect(stack).toContain(`${boom}:4:`);
        expect(stack).not.toContain('spfn-gen');
        expect(stack).not.toContain('__esDecorate');
    });

    it('R17 a TypeScript syntax error names the file, line and column', async () =>
    {
        write('src/server/routes/broken.ts', 'import { route } from \'@spfn/core/route\';\n'
            + '\n'
            + 'export const broken = ;\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { broken } from \'./routes/broken\';\n'
            + 'export const appRouter = defineRouter({ broken });\n');

        const { message } = await failure();

        expect(message).toMatch(/^Failed to load src\/server\/router\.ts \(at src\/server\/routes\/broken\.ts:3:23\): .*broken\.ts:3:23 Expression expected/);
    });

    it('R18 a missing import names the importer', async () =>
    {
        write('src/server/routes/needs.ts', 'import { later } from \'../lib/later\';\n'
            + 'export const needs = later;\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { needs } from \'./routes/needs\';\n'
            + 'export const appRouter = defineRouter({ needs });\n');

        const { message } = await failure();

        expect(message).toMatch(/^Failed to load src\/server\/router\.ts \(at src\/server\/routes\/needs\.ts\): Cannot find module '\.\.\/lib\/later' imported from /);
    });

    it('R24 a project file a route reads is not where the load failed: the route line that read it is', async () =>
    {
        write('src/server/routes/probe.ts', 'import { readFileSync } from \'node:fs\';\n'
            + 'import { join } from \'node:path\';\n'
            + 'import { route } from \'@spfn/core/route\';\n'
            + 'const text = readFileSync(join(import.meta.dirname, \'../data/missing.txt\'), \'utf8\');\n'
            + 'export const getProbe = route.get(`/probe/${text}`).handler(async () => ({}));\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { getProbe } from \'./routes/probe\';\n'
            + 'export const appRouter = defineRouter({ getProbe });\n');

        const { message } = await failure();

        expect(message).toContain('src/server/data/missing.txt');
        expect(message).toMatch(/^Failed to load src\/server\/router\.ts \(at src\/server\/routes\/probe\.ts:4:\d+\): ENOENT/);
    });

    it('R25 an import of a name the module does not export is named at the importing line', async () =>
    {
        write('src/server/routes/named.ts', 'export const other = 1;\n');
        write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { missing } from \'./routes/named\';\n'
            + 'export const appRouter = defineRouter({ missing });\n');

        const { message } = await failure();

        expect(message).toMatch(/^Failed to load src\/server\/router\.ts \(at src\/server\/router\.ts:2\): .*does not provide an export named 'missing'/);
    });
});

describe('codegen loader - generations side by side', () =>
{
    /** An app whose route map is refused: a route registered only when `key` is set. */
    function gatedApp(key: string): string
    {
        const root = makeApp();

        write('src/server/routes/admin.ts', 'import { route } from \'@spfn/core/route\';\n'
            + `const enabled = process.env.${key} !== undefined;\n`
            + 'const admin = route.get(\'/admin\').handler(async () => ({}));\n'
            + 'export const adminRoutes = enabled ? { admin } : {};\n', root);
        write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'import { adminRoutes } from \'./routes/admin\';\n'
            + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n'
            + 'export const appRouter = defineRouter({ getRoot, ...adminRoutes });\n', root);

        return root;
    }

    it('R12 two apps refused alone are both refused when their generations overlap, and process.env is the real object after', async () =>
    {
        const original = process.env;
        const first = gatedApp('R12_FIRST_ADMIN');
        const second = gatedApp('R12_SECOND_ADMIN');

        for (const root of [first, second])
        {
            await expect(generate(root)).rejects.toBeInstanceOf(ConditionalRegistrationError);
        }

        const together = await Promise.allSettled([generate(first), generate(second)]);

        expect(together.map(result => result.status === 'rejected' && result.reason instanceof ConditionalRegistrationError))
            .toEqual([true, true]);
        expect(process.env).toBe(original);
    });
});

describe('codegen loader - .spfnrc.ts', () =>
{
    it('R19 a .spfnrc.ts that fails to load throws, naming the file and line, with what to write instead', () =>
    {
        write('.spfnrc.ts', 'import { join } from \'node:path\';\n'
            + 'import { defineConfig } from \'@spfn/core/codegen\';\n'
            + '\n'
            + 'const routerPath = join(__dirname, \'src/server/router.ts\');\n'
            + 'export default defineConfig({ generators: [{ name: \'@spfn/core:route-map\', routerPath }] });\n');

        expect(() => loadCodegenConfig(appDir)).toThrow(
            /^Failed to load \.spfnrc\.ts \(at \.spfnrc\.ts:4:\d+\): __dirname is not defined in ES module scope\n\n\.spfnrc\.ts is an ES module: use import\.meta\.dirname/,
        );
    });

    it('R21 a custom generator that fails to load rejects, naming the file and line', async () =>
    {
        write('src/generators/custom.ts', 'import { join } from \'node:path\';\n'
            + 'const template = join(__dirname, \'template.txt\');\n'
            + 'export default () => ({ name: \'custom\', watchPatterns: [], generate: async () => { void template; } });\n');

        await expect(createGeneratorsFromConfig({ generators: [{ path: './src/generators/custom.ts' }] }, appDir))
            .rejects.toThrow(/^Failed to load src\/generators\/custom\.ts \(at src\/generators\/custom\.ts:2:\d+\): __dirname is not defined/);
    });

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
