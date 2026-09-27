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
    const middlewareDir = fileURLToPath(new URL('../../server/middleware', import.meta.url));
    const readers = readdirSync(middlewareDir)
        .filter(name => name.endsWith('.ts'))
        .map(name => ({ name, source: readFileSync(join(middlewareDir, name), 'utf8') }))
        .filter(file => file.source.includes('findLocaleByUserId('));

    it('finds the middlewares that resolve a principal', () =>
    {
        expect(readers.map(file => file.name).sort()).toEqual([
            'auth-profiles.ts',
            'authenticate-for-renewal.ts',
            'authenticate.ts',
            'one-time-token-auth.ts',
        ]);
    });

    it.each(['auth-profiles.ts', 'authenticate-for-renewal.ts', 'authenticate.ts', 'one-time-token-auth.ts'])(
        '%s builds its locale fields with profileLocale',
        (name) =>
        {
            const file = readers.find(reader => reader.name === name)!;

            expect(file.source).toContain('profileLocale(chosenLocale)');
        },
    );
});
