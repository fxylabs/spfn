import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * N1 (#147): `dist/next.js` loads under Node's own ESM loader.
 *
 * `next` has no `exports` map, so Node only resolves its subpaths by file
 * name — a bare `next/server` in the built entry fails with
 * `ERR_MODULE_NOT_FOUND` outside Next's bundler. A child process is the
 * loader nothing in vitest's pipeline can stand in for.
 */
const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));

const nextEntry = fileURLToPath(new URL('../../dist/next.js', import.meta.url));

describe('dist/next.js under Node', () =>
{
    // This assertion describes dist, so it stands down before a build.
    it('imports and exposes createLocaleProxy', () =>
    {
        if (!existsSync(nextEntry))
        {
            return;
        }

        const child = spawnSync(process.execPath, [
            '--input-type=module',
            '-e',
            `import(${JSON.stringify(nextEntry)}).then(m => console.log(typeof m.createLocaleProxy))`,
        ], { cwd: packageDirectory, encoding: 'utf8' });

        expect(child.stderr).toBe('');
        expect(child.status).toBe(0);
        expect(child.stdout.trim()).toBe('function');
    });
});
