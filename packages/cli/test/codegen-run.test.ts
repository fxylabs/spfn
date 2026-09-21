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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
        expect(output).not.toContain('Code generation completed');
    });
});
