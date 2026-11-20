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
 * | R6 | `spfn db push`, a drizzle.config.ts using            | the CLI's ESM read of a config drizzle-kit reads fine   |
 * |    | `__dirname`, with and without `--schema`             | failing silently: `--schema` dropped its schemaFilter   |
 * |    |                                                      | unsaid                                                  |
 *
 * R3 and the provision runner's refusal are in `provision-runner.test.ts`.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

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

it('R6 spfn db push names a drizzle.config.ts it cannot read as ESM, with and without --schema', () =>
{
    writeEntity();
    write('drizzle.config.ts', 'import { join } from \'node:path\';\n'
        + 'export default { schema: join(__dirname, \'src/server/entities\'), schemaFilter: [\'app\'] };\n');

    const config = join(realpathSync(appDir), 'drizzle.config.ts');
    const withConfig = spfn(['db', 'push', '--dry-run']);
    const withSchema = spfn(['db', 'push', '--dry-run', '--schema', 'src/server/entities/example.entity.ts']);

    expect(withConfig.status, withConfig.output).toBe(1);
    expect(withConfig.output).toContain(`Could not load drizzle.config.ts: ${config}: __dirname is not defined in ES module scope. `
        + `spfn reads ${config} as ESM`);
    expect(withSchema.output).toContain(`drizzle.config.ts could not be loaded, so a schemaFilter it declares is not applied: ${config}: `
        + '__dirname is not defined in ES module scope');
});
