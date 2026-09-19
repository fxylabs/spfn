/**
 * @spfn/auth - the user-agent family check (design #97 v2, case table 6e)
 *
 * Two halves, both here because they are the same table read at two levels.
 *
 * The first half is the policy: `generalAuthInterceptor` comparing the family a
 * bound session was sealed from against the one the request arrived with. Each
 * row is a real-world transition somebody will make — a version bump, an Android
 * "Request desktop site", an in-app browser — and the row says whether it signs
 * them out. Driven through the interceptor rather than through `uaFamily`,
 * because the rows are about the refusal and not about the classifier.
 *
 * The second half is the classifier's own table: one `it` per user-agent the
 * design enumerates, including the two that are only distinguishable by matching
 * order (`Edg/` before `Chrome/`) and the iOS badges, which are the only thing
 * that tells one iOS browser from another.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RequestInterceptorContext } from '@spfn/core/nextjs/server';

import { generalAuthInterceptor } from '../../nextjs/interceptors/general-auth';
import { generateKeyPair } from '../../server/lib/crypto';
import { sealSession, type SessionData } from '../../server/lib/session';
import { COOKIE_NAMES } from '../../server/lib/config';
import { uaFamily, UA_FAMILIES } from '../../server/lib/ua-family';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';

/** Real strings, as the browsers that send them send them. */
const AGENTS = {
    chromeDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    chromeNewer: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    chromeAndroidDesktopSite: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
    edgeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    edgeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
    edgeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.0.0 Mobile/15E148 Safari/604.1',
    firefoxDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15',
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    // An in-app SFSafariViewController: a real Safari instance embedded in
    // another app, sharing Safari's cookie jar and carrying no badge of its own.
    // Differs from the tab above only in the build token.
    safariInApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/22A3354 Safari/604.1',
    bot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
} as const;

describe('uaFamily — the classifier (case table 6e, unit rows)', () =>
{
    it.each([
        ['Chrome desktop', AGENTS.chromeDesktop, 'chrome'],
        ['Chrome Android', AGENTS.chromeAndroid, 'chrome'],
        ['Edge desktop', AGENTS.edgeDesktop, 'edge'],
        ['Edge Android (EdgA)', AGENTS.edgeAndroid, 'edge'],
        ['Safari macOS', AGENTS.safariMac, 'safari'],
        ['Safari iOS', AGENTS.safariIos, 'safari'],
        ['Firefox desktop', AGENTS.firefoxDesktop, 'firefox'],
        ['Firefox iOS (FxiOS)', AGENTS.firefoxIos, 'firefox'],
        ['Chrome iOS (CriOS)', AGENTS.chromeIos, 'chrome'],
        ['Edge iOS (EdgiOS)', AGENTS.edgeIos, 'edge'],
        ['an empty string', '', 'other'],
        ['a bot', AGENTS.bot, 'other'],
    ])('%s reads as %s', (_label, agent, family) =>
    {
        expect(uaFamily(agent)).toBe(family);
    });

    it('answers one of the five and never null, for anything at all', () =>
    {
        for (const agent of [undefined, null, '', 'nonsense', ...Object.values(AGENTS)])
        {
            expect(UA_FAMILIES).toContain(uaFamily(agent));
        }
    });

    it('sees Edg/ before Chrome/, or every Edge user would read as chrome', () =>
    {
        // The Edge string contains `Chrome/141.0.0.0` verbatim. Order is the table.
        expect(AGENTS.edgeDesktop).toContain('Chrome/');
        expect(uaFamily(AGENTS.edgeDesktop)).toBe('edge');
    });

    it('sees Chrome/ before Safari/, or every Chrome user would risk reading as safari', () =>
    {
        expect(AGENTS.chromeDesktop).toContain('Safari/');
        expect(uaFamily(AGENTS.chromeDesktop)).toBe('chrome');
    });

    it('has no desktop/mobile axis, so the two Chromes are one family', () =>
    {
        expect(uaFamily(AGENTS.chromeDesktop)).toBe(uaFamily(AGENTS.chromeAndroid));
    });
});

describe('the context check in the proxy (case table 6e, policy rows)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    /** A bound session sealed from `sealedWith`, presented with `presentedAs`. */
    async function runRequest(
        session: Partial<SessionData>,
        presentedAs: string | undefined,
    ): Promise<RequestInterceptorContext>
    {
        const keyPair = generateKeyPair('ES256');
        const sealed = await sealSession({
            userId: '1',
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
            ...session,
        } as SessionData, 3600);

        const ctx = {
            path: '/_auth/users/me',
            method: 'GET',
            headers: {} as Record<string, string>,
            cookies: new Map([[COOKIE_NAMES.SESSION, sealed]]),
            request: { headers: new Headers(presentedAs ? { 'user-agent': presentedAs } : {}) },
            metadata: {} as Record<string, unknown>,
        } as unknown as RequestInterceptorContext;

        await generalAuthInterceptor.request?.(ctx, async () => undefined);

        return ctx;
    }

    /** Whether the refusal (if any) emptied the three session cookies. */
    function clearedCookieNames(ctx: RequestInterceptorContext): string[]
    {
        return (ctx.abort?.setCookies ?? []).filter(cookie => cookie.value === '').map(cookie => cookie.name);
    }

    const bound = { binding: 'passkey' as const, keyExpiresAt: Date.now() + 3_600_000 };

    it('sealed chrome, presented a different Chrome version: passes', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'chrome' }, AGENTS.chromeNewer);

        expect(ctx.abort).toBeUndefined();
        expect(ctx.metadata.sessionValid).toBe(true);
    });

    it('sealed chrome, presented Firefox: 401 and the cookies are cleared', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'chrome' }, AGENTS.firefoxDesktop);

        expect(ctx.abort?.status).toBe(401);
        expect((ctx.abort?.body as { __type: string }).__type).toBe('SessionContextChangedError');
        expect(clearedCookieNames(ctx)).toEqual([
            COOKIE_NAMES.SESSION,
            COOKIE_NAMES.SESSION_KEY_ID,
            COOKIE_NAMES.CSRF,
        ]);
    });

    it('sealed chrome, presented Edge (which carries Chrome/ too): 401 — Edge is judged before Chrome', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'chrome' }, AGENTS.edgeDesktop);

        expect(ctx.abort?.status).toBe(401);
        expect((ctx.abort?.body as { __type: string }).__type).toBe('SessionContextChangedError');
    });

    it('sealed chrome, presented Chrome Android asking for the desktop site: passes — there is no axis', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'chrome' }, AGENTS.chromeAndroidDesktopSite);

        expect(ctx.abort).toBeUndefined();
    });

    it('sealed safari, presented an in-app SFSafariViewController: passes — same cookie jar', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'safari' }, AGENTS.safariInApp);

        expect(ctx.abort).toBeUndefined();
    });

    it('sealed safari, presented Chrome iOS (CriOS): 401 — a different cookie jar, so a copy happened', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'safari' }, AGENTS.chromeIos);

        expect(ctx.abort?.status).toBe(401);
        expect((ctx.abort?.body as { __type: string }).__type).toBe('SessionContextChangedError');
    });

    it('sealed other, presented another unrecognised agent: passes — other is a family like any other', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'other' }, AGENTS.bot);

        expect(ctx.abort).toBeUndefined();
    });

    it('any sealed family, no user-agent at all: passes — absence is no signal, not a different family', async () =>
    {
        const ctx = await runRequest({ ...bound, uaFamily: 'chrome' }, undefined);

        expect(ctx.abort).toBeUndefined();
        expect(ctx.metadata.sessionValid).toBe(true);
    });

    it('an unbound session with a changed family: passes, and nothing is logged', async () =>
    {
        const warn = vi.spyOn(
            (await import('../../server/logger')).authLogger.interceptor.general,
            'warn',
        ).mockImplementation(() => undefined);

        const ctx = await runRequest({ uaFamily: 'chrome' }, AGENTS.firefoxDesktop);

        expect(ctx.abort).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });
});
