/**
 * @spfn/auth - Return-path rule unit tests
 *
 * One rule decides where a login may send the browser back to (GitHub
 * fxylabs/spfn#89). It is the only thing standing between a caller-supplied
 * `returnUrl`/`returnPath` and an open redirect out of a genuine login, so the
 * shapes it refuses are pinned here rather than left to each seam to re-derive.
 *
 * The second block pins the reach of the rule: a seam that reads a destination
 * and does not call this function is the defect the issue describes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { isSafeReturnPath } from '../../lib/return-path';

/** The origin every accepted value has to stay on. */
const APP = 'https://app.example';

describe('isSafeReturnPath', () =>
{
    it.each([
        ['https://evil.com', 'absolute URL'],
        ['//evil.com', 'protocol-relative host'],
        ['/\\evil.com', 'backslash a browser may normalize to a slash'],
        ['/a/../b', 'traversal'],
        ['/x:y', 'protocol-prefix-like first segment'],
        ['', 'empty string'],
        ['javascript:alert(1)', 'not rooted, and a javascript URL'],
        ['not-a-path', 'not rooted'],
        ['/a\r\n/b', 'raw CR/LF, which splits a redirect header'],
        ['/\t/evil.com', 'tab a URL parser strips, leaving //evil.com'],
        ['/\tevil.com', 'tab anywhere in the value'],
        ['\\\\evil.com', 'backslash pair a browser reads as //'],
        ['/..//evil.com', 'traversal ahead of a host'],
        ['/./../evil', 'traversal spelled with a dot segment'],
        ['/javascript:x', 'rooted, but with a protocol prefix in the first segment'],
        ['http:/evil.com', 'single-slash absolute URL'],
        [' //evil.com', 'leading space ahead of a protocol-relative host'],
        ['/evil.com:443', 'host:port read as an authority'],
    ])('refuses %j (%s)', (path) =>
    {
        expect(isSafeReturnPath(path)).toBe(false);
    });

    it.each([
        ['/', 'the app root'],
        ['/dashboard', 'a plain path'],
        ['/dashboard?x=1', 'a path with a query'],
        ['/a/b?c=d#e', 'query and fragment'],
        ['/path%20with%20space', 'percent-encoded space'],
        ['/%2F%2Fevil.com', 'percent-encoded slashes, which stay one path segment'],
        ['/@evil.com', 'an at-sign, which is a path character here'],
    ])('accepts %j (%s)', (path) =>
    {
        expect(isSafeReturnPath(path)).toBe(true);
    });

    /**
     * The rule reads the value as written; the browser does not. A URL parser
     * deletes every ASCII tab/LF/CR from its input first, so `/<tab>/evil.com` is
     * `//evil.com` by the time it is resolved — which is why those characters are
     * refused outright rather than judged as ordinary path characters.
     */
    it('refuses values a URL parser would resolve off the app origin', () =>
    {
        expect(new URL('/\t/evil.com', APP).origin).toBe('https://evil.com');
        expect(isSafeReturnPath('/\t/evil.com')).toBe(false);
    });

    it.each([
        '/',
        '/dashboard?x=1',
        '/%2F%2Fevil.com',
        '/@evil.com',
        '/path%20with%20space',
    ])('an accepted value resolves on the app origin: %j', (path) =>
    {
        expect(isSafeReturnPath(path)).toBe(true);
        expect(new URL(path, APP).origin).toBe(APP);
    });

    it('judges the value as written — %0d%0a is six characters, not a line break', () =>
    {
        // Pinned behaviour, not an oversight: nothing here percent-decodes, and
        // nothing downstream decodes the value back into header bytes either. A
        // rule that decoded would have to decode exactly as many times as every
        // consumer does, and would refuse paths that are legitimately encoded.
        expect(isSafeReturnPath('/a%0d%0a')).toBe(true);
        expect(isSafeReturnPath('/a\r\n')).toBe(false);
    });
});

describe('the seams that hand a destination back to the browser', () =>
{
    const SRC = join(__dirname, '..', '..');

    it.each([
        ['nextjs/interceptors/oauth.ts', 'seals returnUrl into the OAuth state'],
        ['server/routes/oauth/index.ts', 'echoes returnUrl from /_auth/oauth/finalize'],
        ['nextjs/components/oauth-callback.tsx', 'navigates with window.location.href'],
        ['nextjs/oauth-handlers.ts', 'redirects from the Next.js callback route'],
        ['server/services/oauth.service.ts', 'puts the unsealed returnUrl in a redirect URL'],
    ])('%s calls isSafeReturnPath (%s)', (file) =>
    {
        expect(readFileSync(join(SRC, file), 'utf8')).toContain('isSafeReturnPath');
    });

    // The component is a browser component and vitest here runs node-only specs,
    // so the navigation itself is pinned at the source: every assignment to
    // window.location.href in the OAuth callback goes through the check.
    it('oauth-callback.tsx navigates only through the checked value', () =>
    {
        const source = readFileSync(join(SRC, 'nextjs', 'components', 'oauth-callback.tsx'), 'utf8');
        const navigations = source.match(/window\.location\.href = .+/g) ?? [];

        expect(navigations).toContain('window.location.href = toSafePath(data.returnUrl || returnUrl);');
        expect(navigations.filter(line => line.includes('returnUrl') && !line.includes('toSafePath'))).toEqual([]);
    });
});
