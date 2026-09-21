/**
 * The compiler is loaded when a router is read, and not before
 *
 * `generators/index.ts` is re-exported from `@spfn/core/codegen`, so anything
 * that module's graph imports at the top level is loaded by `spfn dev` startup,
 * by the watcher child, by every `.spfnrc.ts` evaluation and by `spfn codegen
 * list` — runs that resolve no alias and parse no router. TypeScript is ~0.3s
 * and ~70MB of that.
 *
 * A value import is what makes it eager; `import type` is erased. This asserts
 * the shape rather than the timing, because the timing is only observable in a
 * fresh process and the shape is what a later edit would break.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { typescript } from '../generators/typescript';

const CODEGEN_DIR = join(__dirname, '..');

/** Every source file the `@spfn/core/codegen` entry can reach, tests excluded. */
function sourceFiles(directory: string): string[]
{
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const path = join(directory, entry.name);

        if (entry.isDirectory())
        {
            return entry.name === '__tests__' ? [] : sourceFiles(path);
        }

        return entry.name.endsWith('.ts') ? [path] : [];
    });
}

describe('typescript is imported lazily', () =>
{
    it('is not a value import anywhere under src/codegen', () =>
    {
        const offenders = sourceFiles(CODEGEN_DIR).filter((path) =>
        {
            const source = readFileSync(path, 'utf-8');

            return /^\s*import\s+(?!type\b)[^;]*from\s*'typescript'/m.test(source);
        });

        expect(offenders).toEqual([]);
    });

    it('hands back the compiler, and the same one every time', () =>
    {
        expect(typescript()).toBe(typescript());
        expect(typeof typescript().createSourceFile).toBe('function');
    });
});
