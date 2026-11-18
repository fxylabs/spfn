/**
 * Environment probe — rows S1–S7 of the #102 design case table, and Q1
 *
 * Which frame an environment read is attributed to. The generator-level rows
 * (E1–E17) live in route-map.test.ts; these pin the rule on synthetic stacks,
 * so a frame layout no fixture produces is still decided the documented way.
 *
 * Q1: two observed loads started together, the second settling first, run one
 * after the other and leave the real `process.env` behind (#351 review).
 * Two generations of real apps side by side are loader.test.ts R12.
 */

import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import { observeEnvironmentReads, readerOf, type StackFrame } from '../generators/environment-probe';

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

    it('S3 a read made by the codegen loader, as it resolves or transforms a project file, is not the project\'s', () =>
    {
        // The loader's hooks run in this thread, under Node's module loading: the
        // stack above a read TypeScript or the hook makes reaches Node's internals
        // before any project file.
        const hook = frame('/work/spfn/packages/core/dist/codegen/index.js');
        const typescript = frame('/work/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js');

        expect(readerOf(ROOTS, [typescript, hook, frame('node:internal/modules/esm/hooks'), APP])).toBeUndefined();
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

describe('environment probe - one environment per process', () =>
{
    it('Q1 two observed loads, the second quicker, run one at a time and leave the real process.env', async () =>
    {
        const original = process.env;
        const events: string[] = [];
        let releaseFirst = (): void => undefined;

        const first = observeEnvironmentReads(ROOT, () => new Promise<void>((settle) =>
        {
            events.push(`first starts, proxied: ${process.env !== original}`);
            releaseFirst = settle;
        }));
        const second = observeEnvironmentReads(ROOT, async () =>
        {
            events.push(`second starts, proxied: ${process.env !== original}`);
        });

        await new Promise(resolve => setImmediate(resolve));
        events.push('first released');
        releaseFirst();
        await Promise.all([first, second]);

        expect(events).toEqual(['first starts, proxied: true', 'first released', 'second starts, proxied: true']);
        expect(process.env).toBe(original);
    });
});
