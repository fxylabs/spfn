/**
 * State client entry — `@spfn/core/state/client` ships to the browser, so it
 * may know the server module only by type. Imported by plain Node (no bundler,
 * no tree-shaking to hide a mistake) from the built package, its module graph
 * holds no server code.
 *
 * | #  | situation                                    | expected                                                   |
 * |----|----------------------------------------------|------------------------------------------------------------|
 * | E1 | `import('@spfn/core/state/client')` in Node  | exports `createStateClient` only; no server symbol         |
 * | E2 | the modules that import resolved             | neither `dist/state/index.js` nor `hono`                   |
 *
 * Runs against `dist/`: build first (`pnpm --filter @spfn/core build`).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = join(__dirname, '../../..');

/** A resolve hook printing every URL the import resolves, registered before the script runs. */
const hooks = 'export async function resolve(specifier, context, next) '
    + '{ const result = await next(specifier, context); process.stderr.write(`RESOLVED ${result.url}\\n`); return result; }';
const register = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;

let exported: string[] = [];
let resolved: string[] = [];

describe('state client entry', () =>
{
    beforeAll(() =>
    {
        expect(existsSync(join(packageRoot, 'dist/state/client.js')), 'dist/state/client.js — build @spfn/core first').toBe(true);

        const run = spawnSync(process.execPath, [
            '--import', `data:text/javascript,${encodeURIComponent(register)}`,
            '--input-type=module',
            '-e', 'const m = await import(\'@spfn/core/state/client\'); console.log(JSON.stringify(Object.keys(m)));',
        ], { cwd: packageRoot, encoding: 'utf8' });

        expect(run.status, run.stderr).toBe(0);
        exported = JSON.parse(run.stdout.trim().split('\n').pop()!);
        resolved = run.stderr.split('\n')
            .filter(line => line.startsWith('RESOLVED '))
            .map(line => line.slice('RESOLVED '.length));
    });

    it('E1 exports createStateClient only — no defineState, no defineStateRouter', () =>
    {
        expect(exported).toEqual(['createStateClient']);
    });

    it('E2 loads neither the server state module nor hono', () =>
    {
        expect(resolved.some(url => url.endsWith('/dist/state/client.js'))).toBe(true);
        expect(resolved.filter(url => url.endsWith('/dist/state/index.js') || url.includes('/hono/'))).toEqual([]);
    });
});
