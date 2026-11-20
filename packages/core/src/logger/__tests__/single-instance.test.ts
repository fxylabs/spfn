/**
 * Logger single-instance guard (issue #136)
 *
 * `logger` is a module-level singleton, so "one logger" only holds if every
 * entrypoint resolves to the SAME module. Until #398 tsup built each
 * entrypoint in `tsup.config.ts` separately with `splitting: false` and marked
 * `@spfn/*` external — so a module reached through the package specifier
 * stayed shared, while a module reached through a relative path was inlined
 * into whichever bundle imported it. Code splitting now shares such a module
 * as a chunk, which `scripts/check-bundle-identity.mjs` checks for every module.
 *
 * That is how issue #136 happened: `middleware/rate-limit.ts` and
 * `errors/serializable-error.ts` imported `'../logger'`, so the logger, errors,
 * authz and middleware bundles each carried their own singleton — four loggers,
 * three of them loaded at boot, each announcing itself. Issue #72 was the same
 * mechanism applied to the WS types.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const srcRoot = join(packageRoot, 'src');
const distRoot = join(packageRoot, 'dist');

/**
 * Every file under `root` whose name ends with one of `extensions`.
 */
function walk(root: string, extensions: string[]): string[]
{
    const found: string[] = [];

    for (const entry of readdirSync(root))
    {
        const full = join(root, entry);

        if (statSync(full).isDirectory())
        {
            found.push(...walk(full, extensions));
            continue;
        }

        if (extensions.some(ext => entry.endsWith(ext)))
        {
            found.push(full);
        }
    }

    return found;
}

describe('logger single instance', () =>
{
    it('no source file reaches the logger module by relative path', () =>
    {
        // A relative import is what gets the module inlined. Tests are exempt:
        // vitest resolves source, not dist, so they cannot duplicate a bundle.
        const offenders = walk(srcRoot, ['.ts'])
            .filter(file => !relative(srcRoot, file).startsWith('logger/'))
            .filter(file => !file.includes('__tests__'))
            .filter(file => /from\s+'(\.\.\/)+logger'/.test(readFileSync(file, 'utf-8')))
            .map(file => relative(packageRoot, file));

        expect(offenders, 'import from "@spfn/core/logger" instead').toEqual([]);
    });

    it('exactly one built bundle constructs the logger singleton', (ctx) =>
    {
        if (!existsSync(distRoot))
        {
            // A source checkout that has not been built yet — the source guard
            // above already covers the cause.
            ctx.skip();

            return;
        }

        const bundlesConstructingLogger = walk(distRoot, ['.js'])
            .filter(file => readFileSync(file, 'utf-8').includes('function initializeLogger('))
            .map(file => relative(distRoot, file));

        expect(bundlesConstructingLogger).toEqual(['logger/index.js']);
    });
});
