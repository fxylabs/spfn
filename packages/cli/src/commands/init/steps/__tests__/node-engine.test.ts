/**
 * Whether an app's existing `engines.node` admits only Node releases carrying the
 * CVE-2026-111497 fix — `spfn init` keeps such a range and replaces any other.
 *
 * | # | existing range | kept? | why |
 * | --- | --- | --- | --- |
 * | 1 | the SPFN range itself | yes | identical |
 * | 2 | `^22.23.4` | yes | one patched line |
 * | 3 | `^24.22.1 \|\| >=26.12.1` | yes | every alternative patched |
 * | 4 | `>=24.22.1 <25.0.0` | yes | bounded inside the 24 line |
 * | 5 | `~22.23.4` | yes | inside the 22 line |
 * | 6 | `>=27.0.0` | yes | newer than every floor |
 * | 7 | `>=20.0.0` | no | admits Node 20, which has no fix |
 * | 8 | `>=18.18.0` | no | admits Node 18 and 20 |
 * | 9 | `^22.0.0` | no | 22.0.0–22.23.3 are unpatched |
 * | 10 | `>=22.23.4` | no | unbounded, so it admits the odd lines 23 and 25 |
 * | 11 | `^23.11.0` | no | the odd line 23 is out of support |
 * | 12 | `>=22.23.4 <23.0.0 \|\| ^24.0.0` | no | one alternative is unpatched |
 * | 13 | `>=22.0.0 <23 \|\| ^24.0.0` | no | partial versions are not read |
 * | 14 | `22.23.4` | no | a bare version is not read |
 * | 15 | `>=22.23.4-rc.1 <23.0.0` | no | a prerelease bound is not read |
 * | 16 | `*`, `lts/*`, empty | no | not a range this reads |
 */

import { describe, expect, it } from 'vitest';
import { NODE_ENGINE_RANGE, admitsOnlyPatchedNode } from '../node-engine.js';

describe('admitsOnlyPatchedNode', () =>
{
    it.each([
        [1, NODE_ENGINE_RANGE],
        [2, '^22.23.4'],
        [3, '^24.22.1 || >=26.12.1'],
        [4, '>=24.22.1 <25.0.0'],
        [5, '~22.23.4'],
        [6, '>=27.0.0'],
    ])('row %i keeps %s', (_row, range) =>
    {
        expect(admitsOnlyPatchedNode(range)).toBe(true);
    });

    it.each([
        [7, '>=20.0.0'],
        [8, '>=18.18.0'],
        [9, '^22.0.0'],
        [10, '>=22.23.4'],
        [11, '^23.11.0'],
        [12, '>=22.23.4 <23.0.0 || ^24.0.0'],
        [13, '>=22.0.0 <23 || ^24.0.0'],
        [14, '22.23.4'],
        [15, '>=22.23.4-rc.1 <23.0.0'],
        [16, '*'],
        [16, 'lts/*'],
        [16, ''],
    ])('row %i replaces %s', (_row, range) =>
    {
        expect(admitsOnlyPatchedNode(range)).toBe(false);
    });
});
