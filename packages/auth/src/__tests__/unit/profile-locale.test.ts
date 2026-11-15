/**
 * @spfn/auth - Profile locale helpers (fxylabs/spfn#110)
 *
 * Every principal the package builds reads the stored choice through
 * `profileLocale`, so `locale` and `chosenLocale` cannot disagree between
 * schemes. The source scan below is what holds the renewal and one-time-token
 * paths to that (case table row 11); the Bearer path is driven end to end in
 * the authenticate tests.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeChosenLocale, profileLocale } from '@/server/lib/profile-locale';

describe('profileLocale', () =>
{
    it('falls back to en when nothing was chosen', () =>
    {
        expect(profileLocale(null)).toEqual({ locale: 'en', chosenLocale: null });
    });

    it('carries a choice as both values', () =>
    {
        expect(profileLocale('ko')).toEqual({ locale: 'ko', chosenLocale: 'ko' });
    });
});

describe('normalizeChosenLocale', () =>
{
    it.each([
        [null, null],
        ['', null],
        ['   ', null],
        [' ja ', 'ja'],
        ['ko', 'ko'],
    ])('%j → %j', (input, expected) =>
    {
        expect(normalizeChosenLocale(input)).toBe(expected);
    });
});

describe('source scan: every locale read goes through profileLocale', () =>
{
    const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
    const candidates = [
        ...readdirSync(join(serverDir, 'middleware')).filter(name => name.endsWith('.ts')).map(name => join('middleware', name)),
        join('services', 'admission.service.ts'),
    ];
    const readers = candidates
        .map(name => ({ name, source: readFileSync(join(serverDir, name), 'utf8') }))
        .filter(file => file.source.includes('findLocaleByUserId('));

    // Every principal is built by the admission (`admitPrincipal`), so it is the
    // one place a principal's locale is read; no middleware reads it itself.
    it('finds the one module that resolves a principal', () =>
    {
        expect(readers.map(file => file.name)).toEqual([join('services', 'admission.service.ts')]);
    });

    it('the admission builds its locale fields with profileLocale', () =>
    {
        expect(readers[0].source).toContain('profileLocale(chosenLocale)');
    });
});
