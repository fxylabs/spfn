/**
 * tsconfig path aliases, as the codegen loader reads them
 *
 * `projectPaths` finds the tsconfig whose `paths` apply to a file, and
 * `matchPaths` substitutes a specifier into each target of the entry tsc would
 * take for it, in order; the loader's hook then takes the first candidate that
 * names a file (`loader.test.ts` and `route-map.test.ts` load routers through
 * it). Each case is a real tsconfig.json in a temporary directory, read by
 * TypeScript's own parser — the point being that `extends`, comments and
 * trailing commas are its problem and not this code's.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Logger } from '@spfn/core/logger';
import { matchPaths, projectPaths } from '../loader/aliases';

let projectDir: string;

function writeFile(relativePath: string, content: string): void
{
    const absolutePath = join(projectDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

/**
 * Every warning the call emitted, joined, so a case can assert what it said.
 *
 * `Logger` comes from the package entry rather than from `../../logger`: that is
 * the module the code under test logs through, and the two are different class
 * objects.
 */
function warningsOf(call: () => unknown): string
{
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() =>
    {
    });

    try
    {
        call();

        return warn.mock.calls.map(([message]) => String(message)).join('\n');
    }
    finally
    {
        warn.mockRestore();
    }
}

beforeEach(() =>
{
    projectDir = mkdtempSync(join(tmpdir(), 'spfn-tsconfig-'));
});

/**
 * What `specifier`, imported from a file in `startDir`, is substituted to: one
 * path per target, in order. Undefined when no `paths` entry applies.
 */
function candidatesFor(specifier: string, root: string = projectDir, startDir: string = root): string[] | undefined
{
    const paths = projectPaths(root, startDir);

    return paths === undefined ? undefined : matchPaths(specifier, paths)?.candidates;
}

afterEach(() =>
{
    rmSync(projectDir, { recursive: true, force: true });
});

describe('projectPaths and matchPaths', () =>
{
    it('is empty when the project has no tsconfig.json', () =>
    {
        expect(candidatesFor('@/x')).toBeUndefined();
    });

    it('is empty when the tsconfig declares no paths', () =>
    {
        writeFile('tsconfig.json', '{ "compilerOptions": { "strict": true } }');

        expect(candidatesFor('@/x')).toBeUndefined();
    });

    it('does not walk up: a tsconfig in a parent directory is not this project\'s', () =>
    {
        writeFile('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');

        expect(candidatesFor('@/x', join(projectDir, 'packages/app'))).toBeUndefined();
    });

    it('is empty, and does not throw, when the tsconfig cannot be parsed', () =>
    {
        writeFile('tsconfig.json', 'not json at all {');

        expect(candidatesFor('@/x')).toBeUndefined();
    });

    it('reads a prefix mapping, comments and trailing commas included', () =>
    {
        writeFile(
            'tsconfig.json',
            '{\n'
            + '    // the alias every spfn app has\n'
            + '    "compilerOptions": { "paths": { "@/*": ["./src/*"], } },\n'
            + '}\n',
        );

        expect(candidatesFor('@/server/routes')).toEqual([join(projectDir, 'src/server/routes')]);
    });

    it('resolves a target against baseUrl', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: './app', paths: { '@/*': ['./src/*'] } } }),
        );

        expect(candidatesFor('@/x')).toEqual([join(projectDir, 'app/src/x')]);
    });

    it('resolves a target of an extended config against that config, not this one', () =>
    {
        writeFile(
            'config/base.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
        );
        writeFile('tsconfig.json', JSON.stringify({ extends: './config/base.json' }));

        expect(candidatesFor('@/x')).toEqual([join(projectDir, 'config/src/x')]);
    });

    it('follows a chain of extends, the nearest config winning', () =>
    {
        writeFile('a.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./a/*'] } } }));
        writeFile('b.json', JSON.stringify({ extends: './a.json' }));
        writeFile(
            'tsconfig.json',
            JSON.stringify({ extends: './b.json', compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
        );

        expect(candidatesFor('@/x')).toEqual([join(projectDir, 'src/x')]);
    });

    it('maps a specifier that carries no wildcard to its file', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { 'env-config': ['./src/config/env.ts'] } } }),
        );

        expect(candidatesFor('env-config')).toEqual([join(projectDir, 'src/config/env.ts')]);
        expect(candidatesFor('env-config/other')).toBeUndefined();
    });

    it('keeps an exact mapping beside the wildcard that reduces to the same prefix', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        '@spfn/auth': ['./src/index.ts'],
                        '@spfn/auth/*': ['./lib/*'],
                    },
                },
            }),
        );

        expect(candidatesFor('@spfn/auth')).toEqual([join(projectDir, 'src/index.ts')]);
        expect(candidatesFor('@spfn/auth/server')).toEqual([join(projectDir, 'lib/server')]);
    });

    it('substitutes a wildcard in the middle of a pattern, as tsc does', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        'legacy/*/entry': ['./src/legacy/*/entry.ts'],
                        '@/*': ['./src/*'],
                    },
                },
            }),
        );

        expect(candidatesFor('legacy/billing/entry')).toEqual([join(projectDir, 'src/legacy/billing/entry.ts')]);
        expect(candidatesFor('@/x')).toEqual([join(projectDir, 'src/x')]);
    });

    it('takes the pattern with the longest prefix, as tsc does', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'], '@/server/*': ['./server/*'] } } }),
        );

        expect(candidatesFor('@/server/routes')).toEqual([join(projectDir, 'server/routes')]);
        expect(candidatesFor('@/lib/x')).toEqual([join(projectDir, 'src/lib/x')]);
    });

    it('substitutes every target of the entry, in order, whether or not it exists', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./dist/*', './src/*'] } } }));

        expect(candidatesFor('@/x')).toEqual([join(projectDir, 'dist/x'), join(projectDir, 'src/x')]);
    });
});

describe('projectPaths - which tsconfig holds the paths', () =>
{
    /** What `spfn init` scaffolds: the aliases live with the server, not at the root. */
    function writeServerConfig(): void
    {
        writeFile(
            'src/server/tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@/*': ['./src/*'] } } }),
        );
    }

    it('reads the aliases from the router\'s own directory', () =>
    {
        writeServerConfig();

        expect(candidatesFor('@/x', projectDir, join(projectDir, 'src/server'))).toEqual([join(projectDir, 'src/x')]);
    });

    it('honours that config\'s baseUrl, which points back at the project root', () =>
    {
        writeFile(
            'src/server/tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@/*': ['./generated/*'] } } }),
        );

        expect(candidatesFor('@/x', projectDir, join(projectDir, 'src/server'))).toEqual([join(projectDir, 'generated/x')]);
    });

    it('takes the nearest config that declares paths, the server\'s over the root\'s', () =>
    {
        writeServerConfig();
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./root/*'] } } }));

        expect(candidatesFor('@/x', projectDir, join(projectDir, 'src/server'))).toEqual([join(projectDir, 'src/x')]);
    });

    it('passes over a nearer config that declares none, as a Next.js app\'s server config does', () =>
    {
        writeFile('src/server/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(candidatesFor('@/x', projectDir, join(projectDir, 'src/server'))).toEqual([join(projectDir, 'src/x')]);
    });

    it('stops at the project root, never reading the config above it', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        const app = join(projectDir, 'app');
        writeFile('app/src/server/.keep', '');

        expect(candidatesFor('@/x', app, join(app, 'src/server'))).toBeUndefined();
    });

    it('reads the root config when the router is outside the project root', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(candidatesFor('@/x', projectDir, tmpdir())).toEqual([join(projectDir, 'src/x')]);
    });
});

describe('projectPaths - what it warns about', () =>
{
    it('warns when TypeScript could not read an extends target, instead of dropping its paths silently', () =>
    {
        // The shape a Docker stage produces: the base config holding the aliases
        // was never copied in. Every `paths` entry then vanishes, and the
        // developer used to be told to look at a config that is correct.
        writeFile('tsconfig.json', JSON.stringify({ extends: './missing/base.json' }));

        let candidates: string[] | undefined;
        const warnings = warningsOf(() => (candidates = candidatesFor('@/x')));

        expect(warnings).toMatch(/missing[/\\]base\.json/);
        expect(warnings).toMatch(/aliases/);
        expect(candidates).toBeUndefined();
    });

    it('warns and keeps the paths the unreadable config\'s extender declared itself', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({
            extends: './missing/base.json',
            compilerOptions: { paths: { '@/*': ['./src/*'] } },
        }));

        let candidates: string[] | undefined;
        const warnings = warningsOf(() => (candidates = candidatesFor('@/x')));

        expect(warnings).toMatch(/missing[/\\]base\.json/);
        expect(candidates).toEqual([join(projectDir, 'src/x')]);
    });

    it('says nothing about the inputs the stubbed readDirectory never finds', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(warningsOf(() => candidatesFor('@/x'))).toBe('');
    });
});
