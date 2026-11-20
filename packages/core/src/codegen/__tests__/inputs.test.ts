/**
 * Input stamps — row I1 of the #353 design
 *
 * | #  | sequence                                                         | what goes unnoticed without it                     |
 * |----|------------------------------------------------------------------|----------------------------------------------------|
 * | I1 | a file read and stamped, rewritten in place with the same size,  | a stat shortcut in the check (inode, size and      |
 * |    | on the same inode, its modification time put back                | mtime equal → fresh): the edit is never seen       |
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkStamp, readStamped } from '../core/inputs';

const dirs: string[] = [];

afterEach(() =>
{
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

describe('input stamps', () =>
{
    it('I1 a same-size in-place write with the modification time put back is not fresh', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'spfn-inputs-'));
        const file = join(dir, 'seg.ts');

        // A whole second, which utimes sets exactly.
        const then = Math.floor(Date.now() / 1000) - 60;

        dirs.push(dir);
        writeFileSync(file, 'export const seg = \'aaa\';\n');
        utimesSync(file, then, then);

        const before = statSync(file, { bigint: true });
        const { stamp } = readStamped(file);

        writeFileSync(file, 'export const seg = \'bbb\';\n');
        utimesSync(file, then, then);

        const after = statSync(file, { bigint: true });

        expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
        expect(checkStamp(file, stamp).fresh).toBe(false);
    });
});
