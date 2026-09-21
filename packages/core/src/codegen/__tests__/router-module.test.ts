/**
 * tsconfig path aliases
 *
 * jiti resolves an import through its `alias` option or not at all, so what
 * this function returns is exactly what a router may import while a generator
 * loads it. Each case is a real tsconfig.json in a temporary directory, read by
 * TypeScript's own parser — the point being that `extends`, comments and
 * trailing commas are its problem and not this code's.
 *
 * A wildcard alias is keyed with its trailing slash (`@/*` → `@/`), which is
 * what leaves the exact form of the same prefix free for the `paths` entry that
 * maps it. jiti resolves `@/x` through either spelling; `route-map.test.ts`
 * covers that end of it by loading a router through the alias.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Logger } from '@spfn/core/logger';
import { tsconfigAliases } from '../generators/router-module';

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

afterEach(() =>
{
    rmSync(projectDir, { recursive: true, force: true });
});

describe('tsconfigAliases', () =>
{
    it('is empty when the project has no tsconfig.json', () =>
    {
        expect(tsconfigAliases(projectDir)).toEqual({});
    });

    it('is empty when the tsconfig declares no paths', () =>
    {
        writeFile('tsconfig.json', '{ "compilerOptions": { "strict": true } }');

        expect(tsconfigAliases(projectDir)).toEqual({});
    });

    it('does not walk up: a tsconfig in a parent directory is not this project\'s', () =>
    {
        writeFile('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');

        expect(tsconfigAliases(join(projectDir, 'packages/app'))).toEqual({});
    });

    it('is empty, and does not throw, when the tsconfig cannot be parsed', () =>
    {
        writeFile('tsconfig.json', 'not json at all {');

        expect(tsconfigAliases(projectDir)).toEqual({});
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

        expect(tsconfigAliases(projectDir)).toEqual({ '@/': join(projectDir, 'src') });
    });

    it('resolves a target against baseUrl', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: './app', paths: { '@/*': ['./src/*'] } } }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ '@/': join(projectDir, 'app/src') });
    });

    it('resolves a target of an extended config against that config, not this one', () =>
    {
        writeFile(
            'config/base.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
        );
        writeFile('tsconfig.json', JSON.stringify({ extends: './config/base.json' }));

        expect(tsconfigAliases(projectDir)).toEqual({ '@/': join(projectDir, 'config/src') });
    });

    it('follows a chain of extends, the nearest config winning', () =>
    {
        writeFile('a.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./a/*'] } } }));
        writeFile('b.json', JSON.stringify({ extends: './a.json' }));
        writeFile(
            'tsconfig.json',
            JSON.stringify({ extends: './b.json', compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ '@/': join(projectDir, 'src') });
    });

    it('maps a specifier that carries no wildcard to its file', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { 'env-config': ['./src/config/env.ts'] } } }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ 'env-config': join(projectDir, 'src/config/env.ts') });
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

        expect(tsconfigAliases(projectDir)).toEqual({
            '@spfn/auth': join(projectDir, 'src/index.ts'),
            '@spfn/auth/': join(projectDir, 'lib'),
        });
    });

    it('refuses a wildcard that is not a directory prefix, and keeps the rest', () =>
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

        expect(tsconfigAliases(projectDir)).toEqual({ '@/': join(projectDir, 'src') });
    });
});

describe('tsconfigAliases - which tsconfig holds the paths', () =>
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

        expect(tsconfigAliases(projectDir, join(projectDir, 'src/server'))).toEqual({
            '@/': join(projectDir, 'src'),
        });
    });

    it('honours that config\'s baseUrl, which points back at the project root', () =>
    {
        writeFile(
            'src/server/tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@/*': ['./generated/*'] } } }),
        );

        expect(tsconfigAliases(projectDir, join(projectDir, 'src/server'))).toEqual({
            '@/': join(projectDir, 'generated'),
        });
    });

    it('takes the nearest config that declares paths, the server\'s over the root\'s', () =>
    {
        writeServerConfig();
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./root/*'] } } }));

        expect(tsconfigAliases(projectDir, join(projectDir, 'src/server'))).toEqual({
            '@/': join(projectDir, 'src'),
        });
    });

    it('passes over a nearer config that declares none, as a Next.js app\'s server config does', () =>
    {
        writeFile('src/server/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(tsconfigAliases(projectDir, join(projectDir, 'src/server'))).toEqual({
            '@/': join(projectDir, 'src'),
        });
    });

    it('stops at the project root, never reading the config above it', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        const app = join(projectDir, 'app');
        writeFile('app/src/server/.keep', '');

        expect(tsconfigAliases(app, join(app, 'src/server'))).toEqual({});
    });

    it('reads the root config when the router is outside the project root', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(tsconfigAliases(projectDir, tmpdir())).toEqual({ '@/': join(projectDir, 'src') });
    });
});

describe('tsconfigAliases - what it warns about', () =>
{
    it('warns when TypeScript could not read an extends target, instead of dropping its paths silently', () =>
    {
        // The shape a Docker stage produces: the base config holding the aliases
        // was never copied in. Every `paths` entry then vanishes, and the
        // developer used to be told to look at a config that is correct.
        writeFile('tsconfig.json', JSON.stringify({ extends: './missing/base.json' }));

        let aliases: Record<string, string> = {};
        const warnings = warningsOf(() => (aliases = tsconfigAliases(projectDir)));

        expect(warnings).toMatch(/missing[/\\]base\.json/);
        expect(warnings).toMatch(/aliases/);
        expect(aliases).toEqual({});
    });

    it('warns and keeps the paths the unreadable config\'s extender declared itself', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({
            extends: './missing/base.json',
            compilerOptions: { paths: { '@/*': ['./src/*'] } },
        }));

        let aliases: Record<string, string> = {};
        const warnings = warningsOf(() => (aliases = tsconfigAliases(projectDir)));

        expect(warnings).toMatch(/missing[/\\]base\.json/);
        expect(aliases).toEqual({ '@/': join(projectDir, 'src') });
    });

    it('says nothing about the inputs the stubbed readDirectory never finds', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(warningsOf(() => tsconfigAliases(projectDir))).toBe('');
    });

    it('warns about a pattern jiti cannot express', () =>
    {
        writeFile('tsconfig.json', JSON.stringify({
            compilerOptions: { paths: { 'legacy/*/entry': ['./src/legacy/*/entry.ts'] } },
        }));

        expect(warningsOf(() => tsconfigAliases(projectDir))).toMatch(/not a directory prefix mapping/);
    });
});

describe('tsconfigAliases - several targets for one pattern', () =>
{
    it('falls back to the target that exists, as tsc and tsup do', () =>
    {
        writeFile('src/routes.ts', 'export const x = 1;\n');
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./dist/*', './src/*'] } } }),
        );

        let aliases: Record<string, string> = {};
        const warnings = warningsOf(() => (aliases = tsconfigAliases(projectDir)));

        expect(aliases).toEqual({ '@/': join(projectDir, 'src') });
        expect(warnings).toBe('');
    });

    it('takes the first of the targets that exist, and says so', () =>
    {
        writeFile('dist/routes.js', 'exports.x = 1;\n');
        writeFile('src/routes.ts', 'export const x = 1;\n');
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./dist/*', './src/*'] } } }),
        );

        let aliases: Record<string, string> = {};
        const warnings = warningsOf(() => (aliases = tsconfigAliases(projectDir)));

        expect(aliases).toEqual({ '@/': join(projectDir, 'dist') });
        expect(warnings).toMatch(/only the first/);
    });

    it('takes the first when no target exists, and warns that an import will name itself', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./dist/*', './src/*'] } } }),
        );

        let aliases: Record<string, string> = {};
        const warnings = warningsOf(() => (aliases = tsconfigAliases(projectDir)));

        expect(aliases).toEqual({ '@/': join(projectDir, 'dist') });
        expect(warnings).toMatch(/none of them exist/);
    });

    it('says nothing when a pattern has one target', () =>
    {
        writeFile('src/routes.ts', 'export const x = 1;\n');
        writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));

        expect(warningsOf(() => tsconfigAliases(projectDir))).toBe('');
    });
});
