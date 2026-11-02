/**
 * Environment probe — rows S1–S7 of the #102 design case table
 *
 * Which frame an environment read is attributed to. The generator-level rows
 * (E1–E17) live in route-map.test.ts; these pin the rule on synthetic stacks,
 * so a frame layout no fixture produces is still decided the documented way.
 */

import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import { readerOf, type StackFrame } from '../generators/environment-probe';

const ROOT = '/work/app';
const ROOTS = [ROOT];

const frame = (file: string | undefined, line = 1): StackFrame => ({ file, line });

const APP = frame(`${ROOT}/src/server/routes/admin.ts`, 6);

describe('environment probe - which frame a read belongs to', () =>
{
    it('S1 a read made by a project file is the project\'s, whether the file is a path or a file: URL', () =>
    {
        expect(readerOf(ROOTS, [APP])).toBe(APP);

        const asUrl = frame(pathToFileURL(`${ROOT}/src/server/router.ts`).href, 3);

        expect(readerOf(ROOTS, [asUrl])).toBe(asUrl);
    });

    it('S2 a read made by a package outside the project, called from a project file, is the project file\'s', () =>
    {
        expect(readerOf(ROOTS, [frame('/work/spfn/packages/core/dist/env/index.js'), APP])).toBe(APP);
    });

    it('S3 a read made while jiti loads a module is not the project\'s, even with a project file above it', () =>
    {
        expect(readerOf(ROOTS, [frame(`${ROOT}/node_modules/jiti/dist/babel.cjs`), APP])).toBeUndefined();
        expect(readerOf(ROOTS, [frame('/work/node_modules/.pnpm/jiti@2.6.1/node_modules/jiti/dist/jiti.cjs'), APP]))
            .toBeUndefined();
    });

    it('S4 a read made while node loads a module is not the project\'s', () =>
    {
        expect(readerOf(ROOTS, [frame('/work/node_modules/pg/lib/defaults.js'), frame('node:internal/modules/cjs/loader'), APP]))
            .toBeUndefined();
    });

    it('S5 a package installed inside the project is passed over like any other package', () =>
    {
        expect(readerOf(ROOTS, [frame(`${ROOT}/node_modules/some-sdk/index.js`), APP])).toBe(APP);
    });

    it('S6 a project file reported by its real path counts when the root was given through a symlink', () =>
    {
        const real = frame('/private/var/folders/x/app/src/server/router.ts', 4);

        expect(readerOf(['/var/folders/x/app', '/private/var/folders/x/app'], [real])).toBe(real);
        expect(readerOf(['/var/folders/x/app'], [real])).toBeUndefined();
    });

    it('S7 a stack that reaches no project file, or a frame with no file, is nobody\'s', () =>
    {
        expect(readerOf(ROOTS, [frame('/work/spfn/packages/core/dist/logger/index.js')])).toBeUndefined();
        expect(readerOf(ROOTS, [frame(undefined), APP])).toBeUndefined();
        expect(readerOf(ROOTS, [frame('/work/app-other/src/a.ts')])).toBeUndefined();
    });
});
