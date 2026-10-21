/**
 * @spfn/auth - Sign in with Apple on Android: the boot checks
 * (GitHub fxylabs/spfn#149, design w-1t19t — case table B)
 *
 * `assertAppleRelayUrls` and `assertAndroidAssetLinks` read the env they are
 * given, the way `assertOAuthRedirectUris` does, so every row passes its own.
 *
 * | # | configuration | outcome |
 * | --- | --- | --- |
 * | B1 | `SPFN_AUTH_APPLE_RELAY_URLS=com.example.app://relay` | boot refuses, message names the variable |
 * | B2 | relay URL `http://app.example.com/r` | boot refuses |
 * | B3 | relay URL with `?x=1` or `#f` or `user@` | boot refuses |
 * | B4 | relay URLs set, Apple web flow vars unset | boot refuses |
 * | B5 | relay URLs set, Apple web flow configured | boot passes |
 * | B6 | package name set, fingerprints unset (and the reverse) | boot refuses |
 * | B7 | fingerprint with 31 pairs, or a non-hex pair | boot refuses |
 * | B8 | none of the new vars set | boot passes; nothing new is served |
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { ErrorHandler } from '@spfn/core/middleware';
import { registerRoutes } from '@spfn/core/route';

import { assertAndroidAssetLinks, assertAppleRelayUrls } from '../../server/lib/oauth/android-config-check';
import { registerOAuthProvider } from '../../server/lib/oauth';
import { appleProvider } from '../../server/lib/oauth/apple-provider';
import { mainAuthRouter } from '../../server/routes';

type EnvSource = Record<string, string | undefined>;

const APPLE_WEB: EnvSource = {
    SPFN_AUTH_APPLE_SERVICES_ID: 'com.example.app.web',
    SPFN_AUTH_APPLE_TEAM_ID: 'TEAM123456',
    SPFN_AUTH_APPLE_KEY_ID: 'KEY9876543',
    SPFN_AUTH_APPLE_PRIVATE_KEY: 'a PEM, imported by assertAppleWebConfig and not by this check',
};

const RELAY_URL = 'https://app.example.com/_auth/apple-relay';
const FINGERPRINT = '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';

function relayEnv(relayUrls: string): EnvSource
{
    return { ...APPLE_WEB, SPFN_AUTH_APPLE_RELAY_URLS: relayUrls };
}

function refusalOf(check: () => void): string
{
    try
    {
        check();
    }
    catch (error)
    {
        return (error as Error).message;
    }

    return '';
}

describe('assertAppleRelayUrls', () =>
{
    it('B1: a non-https app link (com.example.app://relay) is refused, naming the variable', () =>
    {
        const refusal = refusalOf(() => assertAppleRelayUrls(relayEnv('com.example.app://relay')));

        expect(refusal).toContain('SPFN_AUTH_APPLE_RELAY_URLS');
        expect(refusal).toContain('"com.example.app://relay" is a non-https URL');
    });

    it('B2: an http URL is refused', () =>
    {
        const refusal = refusalOf(() => assertAppleRelayUrls(relayEnv('http://app.example.com/r')));

        expect(refusal).toContain('SPFN_AUTH_APPLE_RELAY_URLS: "http://app.example.com/r" is a non-https URL');
    });

    it.each([
        ['a query', `${RELAY_URL}?x=1`, 'carries a query string or fragment'],
        ['a fragment', `${RELAY_URL}#f`, 'carries a query string or fragment'],
        ['userinfo', 'https://user@app.example.com/r', 'carries userinfo'],
        ['userinfo with a password', 'https://user:pw@app.example.com/r', 'carries userinfo'],
        ['no absolute URL at all', '/_auth/apple-relay', 'is not an absolute URL'],
    ])('B3: a relay URL with %s is refused', (_case, value, problem) =>
    {
        const refusal = refusalOf(() => assertAppleRelayUrls(relayEnv(value)));

        expect(refusal).toContain(`SPFN_AUTH_APPLE_RELAY_URLS: "${value}" ${problem}`);
    });

    it('B1–B3: one refusal names every offending entry, and a conforming entry beside them is not named', () =>
    {
        const refusal = refusalOf(() => assertAppleRelayUrls(
            relayEnv(`http://a.example/r, ${RELAY_URL}, https://b.example/r?x=1`),
        ));

        expect(refusal.split('\n')).toHaveLength(2);
        expect(refusal).toContain('"http://a.example/r"');
        expect(refusal).toContain('"https://b.example/r?x=1"');
        expect(refusal).not.toContain(RELAY_URL);
    });

    it.each([
        ['every Apple web variable unset', {}],
        ['no key variable', { ...APPLE_WEB, SPFN_AUTH_APPLE_PRIVATE_KEY: undefined }],
        ['both key variables', { ...APPLE_WEB, SPFN_AUTH_APPLE_PRIVATE_KEY_FILE: '/run/apple.p8' }],
        ['the Team ID unset', { ...APPLE_WEB, SPFN_AUTH_APPLE_TEAM_ID: undefined }],
    ])('B4: relay URLs with %s are refused', (_case, apple) =>
    {
        const refusal = refusalOf(() => assertAppleRelayUrls({ ...apple, SPFN_AUTH_APPLE_RELAY_URLS: RELAY_URL }));

        expect(refusal).toContain('SPFN_AUTH_APPLE_RELAY_URLS is set but the Apple web flow it relays from is not configured');
    });

    it('B5: https relay URLs with the Apple web flow configured pass', () =>
    {
        expect(() => assertAppleRelayUrls(relayEnv(`${RELAY_URL}, https://links.example.com/apple`))).not.toThrow();
    });
});

describe('assertAndroidAssetLinks', () =>
{
    it.each([
        ['the package name without fingerprints', { SPFN_AUTH_ANDROID_PACKAGE_NAME: 'com.example.app' }],
        ['fingerprints without the package name', { SPFN_AUTH_ANDROID_CERT_SHA256: FINGERPRINT }],
    ])('B6: %s is refused, naming both variables', (_case, env) =>
    {
        const refusal = refusalOf(() => assertAndroidAssetLinks(env));

        expect(refusal).toContain('Set both SPFN_AUTH_ANDROID_PACKAGE_NAME and SPFN_AUTH_ANDROID_CERT_SHA256, or neither');
    });

    it.each([
        ['31 pairs', FINGERPRINT.slice(0, -3)],
        ['33 pairs', `${FINGERPRINT}:AA`],
        ['a non-hex pair', `GG${FINGERPRINT.slice(2)}`],
        ['no colons', FINGERPRINT.replaceAll(':', '')],
    ])('B7: a fingerprint with %s is refused, naming the variable', (_case, fingerprint) =>
    {
        const refusal = refusalOf(() => assertAndroidAssetLinks({
            SPFN_AUTH_ANDROID_PACKAGE_NAME: 'com.example.app',
            SPFN_AUTH_ANDROID_CERT_SHA256: `${FINGERPRINT},${fingerprint}`,
        }));

        expect(refusal).toBe(
            `SPFN_AUTH_ANDROID_CERT_SHA256: "${fingerprint}" is not a SHA-256 fingerprint (32 colon-separated hex pairs, AA:BB:…).`,
        );
    });

    it.each([
        ['one segment', 'app'],
        ['a segment starting with a digit', 'com.1example.app'],
        ['a dash', 'com.example-app.android'],
    ])('P10 (beside B6–B7): a package name with %s is refused, naming the variable', (_case, packageName) =>
    {
        const refusal = refusalOf(() => assertAndroidAssetLinks({
            SPFN_AUTH_ANDROID_PACKAGE_NAME: packageName,
            SPFN_AUTH_ANDROID_CERT_SHA256: FINGERPRINT,
        }));

        expect(refusal).toContain('SPFN_AUTH_ANDROID_PACKAGE_NAME is not an Android package name');
    });

    it('a well-formed pair with a lowercase fingerprint passes', () =>
    {
        expect(() => assertAndroidAssetLinks({
            SPFN_AUTH_ANDROID_PACKAGE_NAME: 'com.example.app_android',
            SPFN_AUTH_ANDROID_CERT_SHA256: `${FINGERPRINT.toLowerCase()}, ${FINGERPRINT}`,
        })).not.toThrow();
    });
});

describe('B8: none of the new variables set', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        registerOAuthProvider(appleProvider);
        app = new Hono();
        app.onError(ErrorHandler());
        registerRoutes(app, mainAuthRouter);
    });

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        vi.stubEnv('SPFN_AUTH_APPLE_RELAY_URLS', '');
        vi.stubEnv('SPFN_AUTH_ANDROID_PACKAGE_NAME', '');
        vi.stubEnv('SPFN_AUTH_ANDROID_CERT_SHA256', '');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('B8: both checks pass, with or without the Apple web flow', () =>
    {
        expect(() => assertAppleRelayUrls({})).not.toThrow();
        expect(() => assertAppleRelayUrls(APPLE_WEB)).not.toThrow();
        expect(() => assertAndroidAssetLinks({})).not.toThrow();
        expect(() => assertAndroidAssetLinks(APPLE_WEB)).not.toThrow();
    });

    it('B8: nothing new is served — assetlinks.json is a body-less 404 and the native start is refused', async () =>
    {
        const assetLinks = await app.request('/.well-known/assetlinks.json');
        expect(assetLinks.status).toBe(404);
        expect(await assetLinks.text()).toBe('');

        for (const [name, value] of Object.entries(APPLE_WEB))
        {
            vi.stubEnv(name, value);
        }

        const start = await app.request('/_auth/oauth/apple/native/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '2001:db8:149:b8::1' },
            body: JSON.stringify({ requestNonce: 'f'.repeat(64), state: 'a'.repeat(32), relayUrl: RELAY_URL }),
        });
        expect(start.status).toBe(400);
        expect(await start.text()).not.toContain('authUrl');
    });
});
