import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_COOKIE_NAME, localeCookie, negotiateLocale, type CookieWriter } from '../next';

const locales = ['en', 'ko'] as const;

function cookies(value?: string)
{
    return { get: (name: string) => (name === LOCALE_COOKIE_NAME && value !== undefined ? { value } : undefined) };
}

function headers(acceptLanguage?: string)
{
    return { get: (name: string) => (name === 'accept-language' ? acceptLanguage ?? null : null) };
}

function negotiate(input: { chosen?: string | null; cookie?: string; acceptLanguage?: string; supported?: readonly string[] })
{
    return negotiateLocale({
        locales: input.supported ?? locales,
        fallback: 'en',
        chosen: input.chosen,
        cookies: cookies(input.cookie),
        headers: headers(input.acceptLanguage),
    });
}

describe('negotiateLocale', () =>
{
    it('1: a saved choice wins over the cookie and the header', () =>
    {
        expect(negotiate({ chosen: 'ko', cookie: 'en', acceptLanguage: 'en' })).toBe('ko');
    });

    it('2: an unsupported saved choice falls through to the cookie', () =>
    {
        expect(negotiate({ chosen: 'fr', cookie: 'ko' })).toBe('ko');
    });

    it('3: the cookie wins over the header when nothing was saved', () =>
    {
        expect(negotiate({ chosen: null, cookie: 'ko', acceptLanguage: 'en' })).toBe('ko');
    });

    it('4: an unsupported cookie falls through to the header', () =>
    {
        expect(negotiate({ chosen: null, cookie: 'fr', acceptLanguage: 'ko' })).toBe('ko');
    });

    it('5: a regional tag matches its primary language', () =>
    {
        expect(negotiate({ acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8' })).toBe('ko');
    });

    it('6: the header is ordered by q-value, not by position', () =>
    {
        expect(negotiate({ acceptLanguage: 'en;q=0.5,ko;q=0.9' })).toBe('ko');
    });

    it('7: q=0 excludes a language', () =>
    {
        expect(negotiate({ acceptLanguage: 'ko;q=0,en' })).toBe('en');
    });

    it('8: a wildcard alone resolves to the fallback', () =>
    {
        expect(negotiate({ acceptLanguage: '*', supported: ['ko', 'en'] })).toBe('en');
    });

    it('9: matching ignores case and returns the declared spelling', () =>
    {
        expect(negotiate({ acceptLanguage: 'EN-us' })).toBe('en');
    });

    it('10: a script subtag matches before the bare language', () =>
    {
        expect(negotiate({ acceptLanguage: 'zh-Hant-TW', supported: ['en', 'zh', 'zh-Hant'] })).toBe('zh-Hant');
        expect(negotiate({ acceptLanguage: 'zh-Hans-CN', supported: ['en', 'zh', 'zh-Hant'] })).toBe('zh');
    });

    it('11: a malformed header resolves to the fallback without throwing', () =>
    {
        expect(negotiate({ acceptLanguage: ';;q=abc,,ko;q=2,ko;q=' })).toBe('en');
    });

    it('12: no inputs at all resolve to the fallback', () =>
    {
        expect(negotiateLocale({ locales, fallback: 'en' })).toBe('en');
    });

    it('13: only the first 32 entries of a long header are read', () =>
    {
        const filler = Array.from({ length: 32 }, () => 'fr').join(',');

        expect(negotiate({ acceptLanguage: `${filler},ko` })).toBe('en');
        expect(negotiate({ acceptLanguage: `ko,${'x'.repeat(10_000)}` })).toBe('ko');
    });

    it('rejects a fallback that is not a supported locale', () =>
    {
        expect(() => negotiateLocale({ locales: ['ko'] as string[], fallback: 'en' })).toThrow(/fallback "en"/);
    });
});

describe('localeCookie', () =>
{
    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    function store()
    {
        return { set: vi.fn<CookieWriter['set']>() };
    }

    it('14: set writes the choice for a year, server-readable only', () =>
    {
        vi.stubEnv('NODE_ENV', 'production');
        const cookieStore = store();

        localeCookie.set(cookieStore, 'ko');

        expect(cookieStore.set).toHaveBeenCalledWith(LOCALE_COOKIE_NAME, 'ko', {
            path: '/',
            sameSite: 'lax',
            httpOnly: true,
            secure: true,
            maxAge: 60 * 60 * 24 * 365,
        });
    });

    it('15: clear expires the cookie', () =>
    {
        vi.stubEnv('NODE_ENV', 'development');
        const cookieStore = store();

        localeCookie.clear(cookieStore);

        expect(cookieStore.set).toHaveBeenCalledWith(LOCALE_COOKIE_NAME, '', expect.objectContaining({ maxAge: 0, secure: false }));
    });

    it('is read back by negotiateLocale under the same name', () =>
    {
        expect(localeCookie.name).toBe(LOCALE_COOKIE_NAME);
    });
});
