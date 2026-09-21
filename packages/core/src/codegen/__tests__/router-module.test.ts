/**
 * tsconfig path aliases
 *
 * jiti resolves an import through its `alias` option or not at all, so what
 * this function returns is exactly what a router may import while a generator
 * loads it. Each case is a real tsconfig.json in a temporary directory, read by
 * TypeScript's own parser — the point being that `extends`, comments and
 * trailing commas are its problem and not this code's.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { tsconfigAliases } from '../generators/router-module';

let projectDir: string;

function writeFile(relativePath: string, content: string): void
{
    const absolutePath = join(projectDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
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

        expect(tsconfigAliases(projectDir)).toEqual({ '@': join(projectDir, 'src') });
    });

    it('resolves a target against baseUrl', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { baseUrl: './app', paths: { '@/*': ['./src/*'] } } }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ '@': join(projectDir, 'app/src') });
    });

    it('resolves a target of an extended config against that config, not this one', () =>
    {
        writeFile(
            'config/base.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
        );
        writeFile('tsconfig.json', JSON.stringify({ extends: './config/base.json' }));

        expect(tsconfigAliases(projectDir)).toEqual({ '@': join(projectDir, 'config/src') });
    });

    it('follows a chain of extends, the nearest config winning', () =>
    {
        writeFile('a.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./a/*'] } } }));
        writeFile('b.json', JSON.stringify({ extends: './a.json' }));
        writeFile(
            'tsconfig.json',
            JSON.stringify({ extends: './b.json', compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ '@': join(projectDir, 'src') });
    });

    it('maps a specifier that carries no wildcard to its file', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { 'env-config': ['./src/config/env.ts'] } } }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ 'env-config': join(projectDir, 'src/config/env.ts') });
    });

    it('takes the first of several targets, because jiti resolves one', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*', './generated/*'] } } }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ '@': join(projectDir, 'src') });
    });

    it('keeps the wildcard mapping when an exact one reduces to the same prefix', () =>
    {
        writeFile(
            'tsconfig.json',
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        '@spfn/auth': ['./src/index.ts'],
                        '@spfn/auth/*': ['./src/*'],
                    },
                },
            }),
        );

        expect(tsconfigAliases(projectDir)).toEqual({ '@spfn/auth': join(projectDir, 'src') });
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

        expect(tsconfigAliases(projectDir)).toEqual({ '@': join(projectDir, 'src') });
    });
});
