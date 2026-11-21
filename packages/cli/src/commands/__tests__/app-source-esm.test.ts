/**
 * Every spfn command loads the app's source as ESM, and `spfn db` refuses a
 * second copy of @spfn/core — rows of issue #349
 *
 * Each row runs the real bin, as a package script runs it (plain `node`, so it
 * re-spawns itself under tsx with the CLI's module hook), on a fixture app in
 * a temporary directory: a package.json with no `"type"`, `@spfn/core` and
 * `drizzle-orm` linked into its `node_modules`, one entity and the entity
 * registry `spfn create` scaffolds, which makes `db generate` load the
 * entities in its own process (drizzle-kit loads them again in its). Run against
 * the built packages: `pnpm --filter @spfn/core build` and
 * `pnpm --filter spfn build` first. `spfn db generate` connects to no
 * database; it is handed a URL nothing listens on.
 *
 * Copies are counted from `@spfn/core`'s own registry, which a preload writes
 * out when the spfn process exits, beside the format each evaluation of the
 * entity recorded on `globalThis` (`typeof require`: a function only in
 * CommonJS) — the CLI imports `@spfn/core/db` itself, so only the entity's own
 * record shows that it was loaded, and how.
 *
 * | #  | process                                              | catches                                                 |
 * |----|------------------------------------------------------|---------------------------------------------------------|
 * | R1 | `spfn db generate`, an entity importing @spfn/core   | a CommonJS copy of @spfn/core coming back silently: no  |
 * |    |                                                      | process but a marked one ever refused it                |
 * | R2 | `spfn db generate`, an entity with top-level `await` | the entity loaded as CommonJS: drizzle's checks pass on |
 * |    |                                                      | a CommonJS copy, so nothing else tells the two apart    |
 * | R4 | `spfn db generate`, an entity importing a second     | the db mark not set: the second copy loads unrefused    |
 * |    | install of @spfn/core/logger                         |                                                         |
 * | R5 | `spfn env list` started as `node --import tsx`, an   | the bin taking a tsx it did not start for the hook: the |
 * |    | env schema with top-level `await` importing          | schema loads as CommonJS and fails; the schema loaded   |
 * |    | @spfn/core/env                                       | by tsx's `tsImport`: a second @spfn/core/env            |
 * | R6 | `spfn db push` with and without `--schema`, and      | a push or tenant move going on without the config's     |
 * |    | `db tenant export`, a drizzle.config.ts using        | schemaFilter: `--schema` diffed `public`, which the     |
 * |    | `__dirname`                                          | filter excluded (a DROP TABLE there under `--force`)    |
 * | R7 | `spfn db generate` by a CLI whose @spfn/core is not  | the refusal advising to dedupe the app, when the cause  |
 * |    | the app's (the app has its own install)              | is the CLI's install                                    |
 * | R8 | the bin as its own re-spawned child, without the     | the relaunch guard gone: a child without the hook       |
 * |    | hook (`SPFN_CLI_RELAUNCHED_IN` set, no `--import`);  | re-spawns itself, without bound once the hook argument  |
 * |    | each bin process counts itself, the third exits      | goes too (773 processes in round 1)                     |
 * | R9 | the bin whose `process.execve` throws (as Node 26.1+  | the failed relaunch taken for "no tsx": the command     |
 * |    | does on a failed exec), replaced by a preload        | runs on without the hook, saying nothing                |
 * | R10| a copy of the bin beside a `tsx` that is there but   | any failure to resolve tsx taken for "not installed":   |
 * |    | broken (package.json that does not parse, an entry   | the command runs on without the hook, saying nothing;   |
 * |    | file missing), and beside no tsx                     | and a missing tsx no longer run without it              |
 *
 * R3 and the provision runner's refusal are in `provision-runner.test.ts`.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliRoot = join(__dirname, '../../..');
const coreRoot = join(cliRoot, '../core');
const bin = join(cliRoot, 'bin/spfn.js');
const drizzleOrm = realpathSync(join(coreRoot, 'node_modules/drizzle-orm'));

/** The `globalThis` key each evaluation of the entity records its format under. */
const ENTITY_FORMATS = 'app-source-esm:entity-formats';

/**
 * The spfn process's `@spfn/core` evaluations, `<evaluator>×<count>` per entry,
 * and the entity's formats, when it exits.
 */
const DUMP = `const { writeFileSync } = require('node:fs');
process.on('exit', () =>
{
    const registry = globalThis[Symbol.for('@spfn/core:module-evaluations')];

    if (registry !== undefined && process.argv[1].endsWith('spfn.js'))
    {
        writeFileSync(process.env.DUMP_FILE, JSON.stringify({
            core: Object.fromEntries([...registry.evaluations].map(([entry, evaluations]) =>
                [entry, evaluations.map(evaluation => \`\${evaluation.evaluator}×\${evaluation.count ?? 1}\`)])),
            entity: globalThis[Symbol.for('${ENTITY_FORMATS}')] ?? [],
        }));
    }
});
`;

let appDir: string;

function write(path: string, content: string): void
{
    mkdirSync(dirname(join(appDir, path)), { recursive: true });
    writeFileSync(join(appDir, path), content);
}

function writeEntity(prelude = ''): void
{
    write('src/server/entities/example.entity.ts', `${prelude}import { pgTable, text } from 'drizzle-orm/pg-core';\n`
        + 'import { id } from \'@spfn/core/db\';\n'
        + `((globalThis as any)[Symbol.for('${ENTITY_FORMATS}')] ??= []).push(typeof require === 'function' ? 'commonjs' : 'module');\n`
        + 'export const examples = pgTable(\'examples\', { id: id(), name: text(\'name\').notNull() });\n');
    // The scaffold's registry: with it, db generate loads the entities in its own process.
    write('src/server/entities/config.ts', 'export * from \'./example.entity\';\n');
}

/** `spfn <args>` through the bin, as a package script starts it, or after `launcher` (Node options). */
function spfn(args: string[], launcher: string[] = []): { status: number | null; output: string }
{
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        DUMP_FILE: join(appDir, 'dump.json'),
        DATABASE_URL: 'postgres://nobody@127.0.0.1:9/none',
        NODE_OPTIONS: `--require ${join(appDir, 'dump.cjs')}`,
        PATH: `${join(cliRoot, 'node_modules/.bin')}:${process.env.PATH}`,
    };

    delete env.SPFN_APP_URL;

    const result = spawnSync(process.execPath, [...launcher, bin, ...args], { cwd: appDir, env, encoding: 'utf8', timeout: 60_000 });

    return { status: result.status, output: `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
}

function dbGenerate(): { status: number | null; output: string }
{
    return spfn(['db', 'generate']);
}

function dump(): { core: Record<string, string[]>; entity: string[] }
{
    return JSON.parse(readFileSync(join(appDir, 'dump.json'), 'utf8'));
}

beforeEach(() =>
{
    appDir = mkdtempSync(join(tmpdir(), 'spfn-app-source-esm-'));
    mkdirSync(join(appDir, 'node_modules/@spfn'), { recursive: true });
    symlinkSync(coreRoot, join(appDir, 'node_modules/@spfn/core'), 'dir');
    symlinkSync(drizzleOrm, join(appDir, 'node_modules/drizzle-orm'), 'dir');
    write('package.json', JSON.stringify({ name: 'app-source-esm-fixture', private: true }));
    write('dump.cjs', DUMP);
});

afterEach(() =>
{
    rmSync(appDir, { recursive: true, force: true });
});

it('R1 spfn db generate evaluates every @spfn/core entry once, as ESM, in a type-less app', () =>
{
    writeEntity();

    const { status, output } = dbGenerate();

    expect(status, output).toBe(0);
    expect(dump().entity).toEqual(['module']);
    expect(Object.entries(dump().core).filter(([, copies]) => copies.join() !== 'esm×1')).toEqual([]);
});

it('R2 spfn db generate loads an entity with top-level await', () =>
{
    writeEntity('await Promise.resolve();\n');

    const { status, output } = dbGenerate();

    expect(status, output).toBe(0);
    expect(readdirSync(join(appDir, 'src/server/drizzle'), { recursive: true }).some(file => String(file).endsWith('.sql'))).toBe(true);
});

it('R4 spfn db generate refuses a second install of @spfn/core', () =>
{
    mkdirSync(join(appDir, 'node_modules/second-core/dist/logger'), { recursive: true });
    write('node_modules/second-core/package.json', JSON.stringify({ name: 'second-core', type: 'module' }));
    copyFileSync(join(coreRoot, 'dist/logger/index.js'), join(appDir, 'node_modules/second-core/dist/logger/index.js'));
    writeEntity('import \'second-core/dist/logger/index.js\';\n');

    const { status, output } = dbGenerate();

    expect(status, output).not.toBe(0);
    expect(output).toContain('Refusing a second copy of @spfn/core in this process: @spfn/core/logger was loaded from two installs');
    expect(output).toContain('Two installs of @spfn/core: dedupe');
});

it('R5 spfn env list started under node --import tsx loads an env schema with top-level await', () =>
{
    write('spfn.config.js', 'export default { env: { schemas: [\'src/env.schema.ts\'] } };\n');
    write('src/env.schema.ts', 'import \'@spfn/core/env\';\nawait Promise.resolve();\n'
        + 'export const envSchema = { R5_KEY: { key: \'R5_KEY\', type: \'string\', description: \'r5\' } };\n');

    const { status, output } = spfn(['env', 'list'], ['--import', pathToFileURL(createRequire(bin).resolve('tsx')).href]);

    expect(status, output).toBe(0);
    expect(output).toContain('R5_KEY');
    // tsx's tsImport would evaluate what the schema imports again, in a namespace of its own
    expect(Object.entries(dump().core).filter(([, copies]) => copies.join() !== 'esm×1')).toEqual([]);
});

it('R6 spfn db push, with and without --schema, and db tenant stop on a drizzle.config.ts they cannot read as ESM', () =>
{
    writeEntity();
    write('drizzle.config.ts', 'import { join } from \'node:path\';\n'
        + 'export default { schema: join(__dirname, \'src/server/entities\'), schemaFilter: [\'app\'] };\n');

    const config = join(realpathSync(appDir), 'drizzle.config.ts');
    const runs = [
        ['db', 'push', '--dry-run'],
        ['db', 'push', '--dry-run', '--schema', 'src/server/entities/example.entity.ts'],
        ['db', 'tenant', 'export', '1'],
    ].map(args => ({ args: args.join(' '), ...spfn(args) }));

    for (const run of runs)
    {
        expect({ args: run.args, status: run.status }, run.output).toEqual({ args: run.args, status: 1 });
        expect(run.output).toContain(`❌ Could not load ${config}: __dirname is not defined in ES module scope. `
            + `spfn reads ${config} as ESM`);
        // the plan is never made: no scope, no diff
        expect(run.output).not.toContain('Schema from');
    }
});

it('R7 spfn db generate run by a CLI that is not the app\'s own names the CLI as the second install', () =>
{
    const appCore = join(appDir, 'node_modules/@spfn/core');

    rmSync(appCore);
    mkdirSync(appCore);
    cpSync(join(coreRoot, 'dist'), join(appCore, 'dist'), { recursive: true });
    copyFileSync(join(coreRoot, 'package.json'), join(appCore, 'package.json'));
    symlinkSync(join(coreRoot, 'node_modules'), join(appCore, 'node_modules'), 'dir');
    write('pnpm-lock.yaml', '');
    writeEntity();

    const { status, output } = dbGenerate();

    expect(status, output).not.toBe(0);
    expect(output).toContain(`Two installs of @spfn/core: this spfn CLI is not the app's own — it brings its @spfn/core (\`${realpathSync(coreRoot)}\`) `
        + `beside the app's (\`${realpathSync(appCore)}\`). Run the app's own spfn: \`pnpm exec spfn db generate\``);
    expect(output).not.toContain('dedupe');
});

it('R8 the bin started as its own re-spawned child without the module hook stops, and starts no process', () =>
{
    const depthFile = join(appDir, 'depth.log');

    // Every bin process in the chain counts itself (its main thread: the preload
    // runs in tsx's loader thread too) and the third ends at once, so even a bin
    // without its guard cannot re-spawn itself without bound.
    write('depth-cap.cjs', `if (require('node:worker_threads').isMainThread && process.argv[1] === ${JSON.stringify(bin)})\n{\n`
        + '    const depth = Number(process.env.R8_DEPTH ?? 0) + 1;\n'
        + '    process.env.R8_DEPTH = String(depth);\n'
        + `    require('node:fs').appendFileSync(${JSON.stringify(depthFile)}, depth + '\\n');\n`
        + '    if (depth > 2) process.exit(97);\n}\n');

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        SPFN_CLI_RELAUNCHED_IN: realpathSync(appDir),
        NODE_OPTIONS: `--require ${join(appDir, 'depth-cap.cjs')}`,
        PATH: `${join(cliRoot, 'node_modules/.bin')}:${process.env.PATH}`,
    };
    const result = spawnSync(process.execPath, [bin, '--version'], { cwd: appDir, env, encoding: 'utf8', timeout: 60_000 });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('the CLI\'s module hook (dist/dev-loader/register.js) did not register in the process spfn re-spawned');
    expect(readFileSync(depthFile, 'utf8')).toBe('1\n');
});

it('R9 the bin whose relaunch fails stops with the error rather than run without the module hook', () =>
{
    // Node 26.1+ throws from a failed execve (E2BIG, EACCES, …); this one always does.
    write('execve-fails.cjs', `if (require('node:worker_threads').isMainThread && process.argv[1] === ${JSON.stringify(bin)})\n{\n`
        + '    process.execve = () => { throw Object.assign(new Error(\'E2BIG: argument list too long, execve\'), { code: \'E2BIG\' }); };\n}\n');

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_OPTIONS: `--require ${join(appDir, 'execve-fails.cjs')}`,
        PATH: `${join(cliRoot, 'node_modules/.bin')}:${process.env.PATH}`,
    };

    delete env.SPFN_CLI_RELAUNCHED_IN;

    const result = spawnSync(process.execPath, [bin, '--version'], { cwd: appDir, env, encoding: 'utf8', timeout: 60_000 });

    expect({ status: result.status, stdout: result.stdout }, result.stderr).toEqual({ status: 1, stdout: '' });
    expect(result.stderr).toContain('Error: spfn could not re-run itself under tsx and its module hook:');
    expect(result.stderr).toContain('E2BIG: argument list too long, execve');
});

describe('R10 resolving tsx for the relaunch', () =>
{
    /** A copy of the bin in `<appDir>/cli/bin`, so `tsx` resolves from `<appDir>/cli`; `dist/` is the built one. */
    function binCopy(tsxFiles: Record<string, string> | null): string
    {
        mkdirSync(join(appDir, 'cli/bin'), { recursive: true });
        copyFileSync(bin, join(appDir, 'cli/bin/spfn.js'));
        write('cli/package.json', JSON.stringify({ name: 'spfn-copy', type: 'module' }));
        symlinkSync(join(cliRoot, 'dist'), join(appDir, 'cli/dist'), 'dir');
        Object.entries(tsxFiles ?? {}).forEach(([file, content]) => write(`cli/node_modules/tsx/${file}`, content));

        return join(appDir, 'cli/bin/spfn.js');
    }

    /** The environment, without what would find a tsx elsewhere: vitest's NODE_PATH holds pnpm's store. */
    function cleanEnv(): NodeJS.ProcessEnv
    {
        const env: NodeJS.ProcessEnv = { ...process.env };

        delete env.SPFN_CLI_RELAUNCHED_IN;
        delete env.NODE_OPTIONS;
        delete env.NODE_PATH;

        return env;
    }

    function version(copy: string): { status: number | null; stdout: string; stderr: string }
    {
        return spawnSync(process.execPath, [copy, '--version'], { cwd: appDir, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 });
    }

    /** Whether `tsx` resolves from `from` in a process of its own, as the bin resolves it. */
    function resolvable(from: string): boolean
    {
        return spawnSync(process.execPath, ['-e', `require('node:module').createRequire(${JSON.stringify(from)}).resolve('tsx')`], { env: cleanEnv() }).status === 0;
    }

    it.each([
        ['a package.json that does not parse', { 'package.json': '{ "name": "tsx",' }, 'Invalid package config'],
        ['its entry file missing', { 'package.json': JSON.stringify({ name: 'tsx', exports: { '.': './dist/loader.mjs' } }) }, 'tsx/dist/loader.mjs'],
    ])('a tsx with %s stops the command, saying so', (_case, files, cause) =>
    {
        const result = version(binCopy(files));

        expect({ status: result.status, stdout: result.stdout }, result.stderr).toEqual({ status: 1, stdout: '' });
        expect(result.stderr).toContain('Error: spfn could not resolve tsx, which it re-runs itself under:');
        expect(result.stderr).toContain(cause);
    });

    it('no tsx runs the command without the hook', (context) =>
    {
        const copy = binCopy(null);

        // A tsx in a directory above the temporary one (/tmp/node_modules) would be found instead.
        context.skip(resolvable(copy), 'a tsx is installed above the temporary directory');

        const result = version(copy);

        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
        expect(result.stdout.trim()).toBe(JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version);
    });
});
