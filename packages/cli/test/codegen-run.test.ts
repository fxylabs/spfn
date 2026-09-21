/**
 * `spfn codegen run` and its exit code
 *
 * The command is what a developer runs after adding a route, and what a script
 * runs before building by other means. A generator that refused while the
 * command still printed a green check and exited 0 left the previous map on
 * disk — missing the route that was just added — and said it had been
 * generated. The exit code is the only part of that a script can see, so it is
 * what this asserts.
 *
 * The project fixture lives inside the package rather than in a temporary
 * directory, because `.spfnrc.ts` imports `@spfn/core/codegen` and that has to
 * resolve through the workspace's node_modules.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(packageDir, 'bin', 'spfn.js');
const projectDir = join(packageDir, '.test-tmp-codegen-run');
const OUTPUT_PATH = join(projectDir, 'src/generated/route-map.ts');

function writeFile(relativePath: string, content: string): void
{
    const absolutePath = join(projectDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

/** The exit code, and everything the command printed. */
function runCodegen(): { status: number; output: string }
{
    try
    {
        const output = execFileSync(process.execPath, [CLI, 'codegen', 'run'], {
            cwd: projectDir,
            encoding: 'utf-8',
            stdio: 'pipe',
        });

        return { status: 0, output };
    }
    catch (error)
    {
        const failure = error as { status?: number; stdout?: string; stderr?: string };

        return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
}

beforeEach(() =>
{
    rmSync(projectDir, { recursive: true, force: true });
    mkdirSync(projectDir, { recursive: true });

    writeFile(
        '.spfnrc.ts',
        'import { defineConfig, defineGenerator } from \'@spfn/core/codegen\';\n\n'
        + 'export default defineConfig({\n'
        + '    generators: [\n'
        + '        defineGenerator({\n'
        + '            name: \'@spfn/core:route-map\',\n'
        + '            routerPath: \'./src/server/router.ts\',\n'
        + '            outputPath: \'./src/generated/route-map.ts\',\n'
        + '        }),\n'
        + '    ],\n'
        + '});\n',
    );
});

afterEach(() =>
{
    rmSync(projectDir, { recursive: true, force: true });
});

describe('spfn codegen run', () =>
{
    it('writes the map and exits 0', () =>
    {
        writeFile(
            'src/server/router.ts',
            'import { defineRouter, route } from \'@spfn/core/route\';\n\n'
            + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n\n'
            + 'export const appRouter = defineRouter({ getRoot });\n',
        );

        const { status, output } = runCodegen();

        expect(status).toBe(0);
        expect(output).toContain('Code generation completed');
        expect(existsSync(OUTPUT_PATH)).toBe(true);
    });

    it('exits non-zero when a generator refuses', () =>
    {
        writeFile(
            'src/server/router.ts',
            'import { defineRouter, route } from \'@spfn/core/route\';\n\n'
            + 'const listUsers = route.get(\'/users\').handler(async () => ({}));\n'
            + 'const listAdmins = route.get(\'/admins\').handler(async () => ({}));\n\n'
            + 'const users = defineRouter({ list: listUsers });\n'
            + 'const admin = defineRouter({ list: listAdmins });\n\n'
            + 'export const appRouter = defineRouter({ users, admin });\n',
        );

        const { status, output } = runCodegen();

        expect(status).toBe(1);
        expect(output).toContain('Code generation failed');

        // The refusal under test, not any refusal: "Code generation failed" is
        // also what a fixture that stopped resolving @spfn/core/route prints,
        // and that run would pass an assertion on the exit code alone.
        expect(output).toContain('Two routes are both named "list"');
        expect(output).not.toContain('Code generation completed');
    });

    it('writes the map for an app route sharing a name with an ops command', () =>
    {
        // `createOpsRouter` publishes no route map for the app to merge, and
        // `spfn ops` invokes a command over its URL, so nothing overwrites the
        // app's `listExamples`. Refusing here bricked a scaffolded app.
        writeFile(
            'src/server/router.ts',
            'import { defineRouter, route } from \'@spfn/core/route\';\n'
            + 'import { createOpsRouter, opsRoute } from \'@spfn/core/ops\';\n'
            + 'import { defineMiddleware } from \'@spfn/core/route\';\n\n'
            + 'const opsAuth = defineMiddleware(\'opsAuth\', async (_c, next) => { await next(); });\n\n'
            + 'const listExamples = route.get(\'/examples\').handler(async () => ({}));\n\n'
            + 'const opsRouter = createOpsRouter({\n'
            + '    listExamples: opsRoute.get(\'/examples\').handler(async () => ({})),\n'
            + '}, { auth: opsAuth });\n\n'
            + 'export const appRouter = defineRouter({ listExamples }).packages([opsRouter]);\n',
        );

        const { status, output } = runCodegen();

        expect(status).toBe(0);
        expect(output).toContain('Code generation completed');
        expect(readFileSync(OUTPUT_PATH, 'utf-8')).toContain('listExamples: { method: \'GET\', path: \'/examples\' }');
    });

    it('writes the map when the aliases live only in src/server/tsconfig.json', () =>
    {
        // What `spfn init` scaffolds, and what `spfn build` compiles with. An app
        // with no Next.js root config has `@/*` nowhere else.
        writeFile(
            'src/server/tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@/*': ['./src/*'] } } }),
        );
        writeFile(
            'src/server/routes/users.ts',
            'import { route } from \'@spfn/core/route\';\n\n'
            + 'export const listUsers = route.get(\'/users\').handler(async () => ({}));\n',
        );
        writeFile(
            'src/server/router.ts',
            'import { defineRouter } from \'@spfn/core/route\';\n'
            + 'import { listUsers } from \'@/server/routes/users\';\n\n'
            + 'export const appRouter = defineRouter({ listUsers });\n',
        );

        const { status, output } = runCodegen();

        expect(status).toBe(0);
        expect(output).toContain('Code generation completed');
        expect(readFileSync(OUTPUT_PATH, 'utf-8')).toContain('listUsers: { method: \'GET\', path: \'/users\' }');
    });
});
