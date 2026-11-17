/**
 * One `@spfn/core` per process — a server process refuses a second copy of an
 * entry of this package: the server's ESM copy beside the CommonJS copy a
 * TypeScript loader made of the same file for the app (issue #329), or a
 * second install of the package, of another version or the same one.
 *
 * | #  | situation                                                            | expected                                          |
 * |----|----------------------------------------------------------------------|---------------------------------------------------|
 * | D1 | before boot: `app.ts`, run as CommonJS by tsx, imports `dist/errors`,| `startServer` refuses, naming `app.ts` — not the  |
 * |    | which requires `dist/logger` the server loaded as ESM; `app.ts` is   | core file between — and the TypeScript remedy     |
 * |    | under `node_modules/(group)/`                                        |                                                   |
 * | D1 | after boot: `app.cjs` requires a dependency that requires            | each import throws the refusal naming `app.cjs` — |
 * |    | `dist/errors` (so `dist/logger`) as CommonJS, twice, with a          | the outermost requirer — and the CommonJS remedy, |
 * |    | structured `Error.prepareStackTrace` (returning the call sites)      | logged once; the server keeps serving             |
 * |    | installed before                                                     |                                                   |
 * | D1 | after boot: a copy of `dist/logger` built as another version, as ESM | the import throws the refusal, naming both        |
 * | D1 | after boot: a byte-identical `dist/logger` from another directory    | the import throws the refusal, naming both        |
 * |    | (a second install of the same version), as ESM                       | locations                                         |
 * | D1 | after boot: `dist/logger` evaluated again as ESM, from its own path  | the import succeeds: the same copy again          |
 * | D1 | in vitest: a server booted from `dist/`, `vi.resetModules()`, and    | the re-import succeeds: the same copy again       |
 * |    | `dist/server` and `dist/logger` imported again                       |                                                   |
 * | D1 | no server: an error formatter's `Error.prepareStackTrace` requires   | the require loads: no `TypeError` from a stack    |
 * |    | `dist/logger` as CommonJS, and `new Error('x').stack` is read        | that is a string, not call sites                  |
 *
 * Each row but the vitest one runs in a child process under tsx, as `spfn dev` runs
 * a server, so every evaluation is a real one rather than an entry written into
 * the registry by hand. Runs against `dist/`: build first
 * (`pnpm --filter @spfn/core build`).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const packageRoot = join(__dirname, '../../..');
const serverFile = join(packageRoot, 'dist/server/index.js');
const serverEntry = pathToFileURL(serverFile).href;
const loggerFile = join(packageRoot, 'dist/logger/index.js');
const loggerEntry = pathToFileURL(loggerFile).href;
const errorsFile = join(packageRoot, 'dist/errors/index.js');
const tsxLoader = pathToFileURL(createRequire(join(packageRoot, 'package.json')).resolve('tsx')).href;
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version as string;
const OTHER_VERSION = '0.0.0-other';

let cwd: string;

/** A second install of `dist/logger`, as `contents` makes it: its own file in another package directory. */
function secondInstall(directory: string, contents: string): string
{
    const file = join(cwd, directory, 'dist/logger/index.js');

    mkdirSync(join(cwd, directory, 'dist/logger'), { recursive: true });
    writeFileSync(join(cwd, directory, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(file, contents);

    return file;
}

/**
 * An application file of the child, at `path` under its directory (no
 * `package.json`: tsx runs it as CommonJS). A directory named `node_modules`
 * or with parentheses in its name is still the application's.
 */
function appFile(path: string, source: string): string
{
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), source);

    return join(cwd, path);
}

const TYPESCRIPT_APP = 'node_modules/(group)/app.ts';

/** A dependency of the child that requires `dist/errors`: between the application file and core. */
function dependencyRequiringCore(): string
{
    appFile('node_modules/dep/package.json', '{ "name": "dep", "main": "index.js" }');
    appFile('node_modules/dep/index.js', `module.exports = require(${JSON.stringify(errorsFile)});\n`);

    return 'dep';
}

/** Each scenario's second evaluation of `dist/logger`, as a statement; `attempt` makes each ESM URL new. */
const SECOND_EVALUATION = {
    typeScript: () => `await import(${JSON.stringify(pathToFileURL(appFile(TYPESCRIPT_APP,
        `import * as errors from ${JSON.stringify(errorsFile)};\nexport const loaded = Object.keys(errors).length;\n`)).href)});`,
    commonJs: () => `Error.prepareStackTrace = (error, sites) => sites;\nawait import(${JSON.stringify(pathToFileURL(appFile('app.cjs',
        `module.exports = require(${JSON.stringify(dependencyRequiringCore())});\n`)).href)} + '?' + attempt);`,
    sameLocation: () => `await import(${JSON.stringify(loggerEntry)} + '?again' + attempt);`,
    otherVersion: () => `await import(${JSON.stringify(pathToFileURL(secondInstall('other-version',
        readFileSync(loggerFile, 'utf8').replace(JSON.stringify(version), JSON.stringify(OTHER_VERSION)))).href)} + '?' + attempt);`,
    sameVersion: () => `await import(${JSON.stringify(pathToFileURL(secondInstall('same-version',
        readFileSync(loggerFile, 'utf8'))).href)} + '?' + attempt);`,
};

type Scenario = keyof typeof SECOND_EVALUATION;

function freePort(): Promise<number>
{
    return new Promise((resolve, reject) =>
    {
        const probe = createServer();

        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () =>
        {
            const { port } = probe.address() as { port: number };

            probe.close(() => resolve(port));
        });
    });
}

/**
 * The child's script: load the server entry as ESM, then start a server with
 * the second evaluation before the boot, or start it and run the second
 * evaluation twice after.
 */
function script(scenario: Scenario, when: 'beforeBoot' | 'afterBoot'): string
{
    const second = SECOND_EVALUATION[scenario]();

    return `const { startServer } = await import(${JSON.stringify(serverEntry)});
let attempt = 0;
${when === 'beforeBoot' ? second : ''}
let instance;
try
{
    instance = await startServer({ infrastructure: { database: false, redis: false } });
    console.log('BOOTED');
}
catch (error)
{
    console.log('REFUSED ' + error.message);
    process.exit(0);
}
for (attempt = 1; attempt <= ${when === 'afterBoot' ? 2 : 0}; attempt++)
{
    try
    {
        ${second}
        console.log('LOADED');
    }
    catch (error)
    {
        console.log('THREW ' + error.message);
    }
}
const health = await fetch('http://127.0.0.1:' + process.env.SPFN_PORT + '/_core/health');
console.log('SERVING ' + health.status);
await instance.close();
process.exit(0);`;
}

/** Run a scenario in a child process: its result lines, and everything it printed. */
async function run(scenario: Scenario, when: 'beforeBoot' | 'afterBoot'): Promise<{ lines: string[]; output: string }>
{
    const child = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script(scenario, when)], {
        cwd,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            SPFN_HOST: '127.0.0.1',
            SPFN_PORT: String(await freePort()),
            SPFN_API_URL: 'http://127.0.0.1:9',
        },
    });

    expect(child.status, child.stderr).toBe(0);

    return {
        lines: child.stdout.split('\n').filter(line => /^(BOOTED|REFUSED|LOADED|THREW|SERVING)/.test(line)),
        output: child.stdout + child.stderr,
    };
}

/**
 * Run an error formatter of the child, without a server: its
 * `Error.prepareStackTrace` requires `dist/logger` as CommonJS — V8 does not
 * call the hook re-entrantly, so core's own stack capture gets a string.
 */
function requireInsidePrepareStackTrace(): string[]
{
    const formatter = appFile('formatter.cjs', `Error.prepareStackTrace = (error) =>
{
    try
    {
        require(${JSON.stringify(loggerFile)});
        console.log('LOADED');
    }
    catch (caught)
    {
        console.log('THREW ' + caught.message);
    }
    return String(error);
};
void new Error('x').stack;
`);
    const child = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e',
        `await import(${JSON.stringify(pathToFileURL(formatter).href)});`], { cwd, encoding: 'utf8' });

    expect(child.status, child.stderr).toBe(0);

    return child.stdout.split('\n').filter(line => /^(LOADED|THREW)/.test(line));
}

describe('one @spfn/core per process', () =>
{
    beforeAll(() =>
    {
        expect(existsSync(join(packageRoot, 'dist/server/index.js')), 'dist/server/index.js — build @spfn/core first').toBe(true);
        cwd = mkdtempSync(join(tmpdir(), 'spfn-one-core-'));
    });

    afterAll(() =>
    {
        rmSync(cwd, { recursive: true, force: true });
    });

    it('D1 refuses a boot after an application .ts reached core as CommonJS, naming that file', async () =>
    {
        const [answer] = (await run('typeScript', 'beforeBoot')).lines;
        const app = join(cwd, TYPESCRIPT_APP);

        expect(answer).toContain('REFUSED Refusing a second copy of @spfn/core in this process');
        expect(answer).toContain(`@spfn/core/logger (\`${loggerFile}\`, ${version}) was evaluated twice: natively as ESM `
            + `and as CommonJS, required by ${app};`);
        expect(answer).not.toContain(`required by ${join(packageRoot, 'dist')}`);
        expect(answer).toContain(`${app} is TypeScript run as CommonJS`);
    });

    it('D1 refuses a CommonJS copy an application .cjs requires after boot, naming that file, and logs it once', async () =>
    {
        const { lines, output } = await run('commonJs', 'afterBoot');
        const app = join(cwd, 'app.cjs');

        expect(lines[0]).toBe('BOOTED');
        expect(lines[1]).toContain(`THREW Refusing a second copy of @spfn/core in this process: @spfn/core/logger `
            + `(\`${loggerFile}\`, ${version}) was evaluated twice: natively as ESM and as CommonJS, required by ${app}.`);
        expect(lines[1]).toContain(`${app} is CommonJS, and under \`spfn dev\``);
        expect(lines[2]).toBe(lines[1]);
        expect(lines[3]).toBe('SERVING 200');
        expect(output.split('Refusing a second copy').length - 1, output).toBe(3);
    });

    it('D1 refuses a second version of an entry after boot, naming both', async () =>
    {
        const { lines } = await run('otherVersion', 'afterBoot');

        expect(lines[0]).toBe('BOOTED');
        expect(lines[1]).toContain(`@spfn/core/logger was loaded from two installs: \`${loggerFile}\` (${version}) and `
            + `\`${join(cwd, 'other-version/dist/logger/index.js')}\` (${OTHER_VERSION})`);
        expect(lines[1]).toContain('Two installs of @spfn/core: dedupe');
    });

    it('D1 refuses a second install of the same version after boot, naming both locations', async () =>
    {
        const { lines } = await run('sameVersion', 'afterBoot');

        expect(lines[0]).toBe('BOOTED');
        expect(lines[1]).toContain(`THREW Refusing a second copy of @spfn/core in this process: @spfn/core/logger was `
            + `loaded from two installs: \`${loggerFile}\` (${version}) and `
            + `\`${join(cwd, 'same-version/dist/logger/index.js')}\` (${version}).`);
        expect(lines[1]).toContain('Two installs of @spfn/core: dedupe');
        expect(lines[2]).toBe(lines[1]);
        expect(lines[3]).toBe('SERVING 200');
    });

    it('D1 loads an entry again from its own path by the same evaluator after boot', async () =>
    {
        expect((await run('sameLocation', 'afterBoot')).lines).toEqual(['BOOTED', 'LOADED', 'LOADED', 'SERVING 200']);
    });

    it('D1 loads core as CommonJS from inside another library\'s Error.prepareStackTrace', () =>
    {
        expect(requireInsidePrepareStackTrace()).toEqual(['LOADED']);
    });

    it('D1 in vitest: a booted server\'s entries imported again after vi.resetModules() are the same copy', async () =>
    {
        vi.stubEnv('SPFN_HOST', '127.0.0.1');
        vi.stubEnv('SPFN_PORT', String(await freePort()));
        vi.stubEnv('SPFN_API_URL', 'http://127.0.0.1:9');

        const { startServer } = await import(serverFile);
        const instance = await startServer({ infrastructure: { database: false, redis: false } });

        try
        {
            vi.resetModules();
            await expect(import(serverFile)).resolves.toHaveProperty('startServer');
            await expect(import(loggerFile)).resolves.toHaveProperty('logger');
            expect((await fetch(`http://127.0.0.1:${process.env.SPFN_PORT}/_core/health`)).status).toBe(200);
        }
        finally
        {
            await instance.close();
            vi.unstubAllEnvs();
        }
    });
});
