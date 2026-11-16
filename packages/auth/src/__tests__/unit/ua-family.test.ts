/**
 * @spfn/auth - the user-agent family classifier (design #97 v2, case table 6e)
 *
 * The classifier's own table: one `it` per user-agent the design enumerates,
 * including the two that are only distinguishable by matching order (`Edg/`
 * before `Chrome/`) and the iOS badges, which are the only thing that tells one
 * iOS browser from another.
 *
 * The policy rows that drove the Next.js proxy's comparison are gone with it
 * (bundle 8 part 2): admission compares a bound key's recorded family with the
 * request's, by this classifier, and the bound-session proxy rows in
 * `integration/session-binding-renewal-proxy.test.ts` (T5a–T5e, E1–E2) drive
 * that through the real chain.
 */

import { describe, it, expect } from 'vitest';

import { uaFamily, UA_FAMILIES } from '../../server/lib/ua-family';

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
