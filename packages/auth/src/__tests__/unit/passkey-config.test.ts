/**
 * Passkey relying-party configuration (case table C).
 *
 * Every row here is a value that would otherwise boot clean and then make every
 * ceremony fail in the browser, with an error naming the browser rather than the
 * env value. `assertPasskeyConfig` is what turns that into a refusal at the
 * deploy that introduced it.
 */

import { describe, expect, it } from 'vitest';

import { assertPasskeyConfig, getPasskeyConfig } from '@/server/lib/config';

/** Only what the resolution reads, so a row states its whole world. */
function envOf(overrides: Record<string, string> = {}): Record<string, string | undefined>
{
    return { SPFN_APP_URL: 'https://app.example.com', ...overrides };
}

describe('passkey configuration (case table C)', () =>
{
    it('row C1: nothing set — rpId and the single origin come from the app URL', () =>
    {
        const config = getPasskeyConfig({ SPFN_APP_URL: 'https://app.example.com' });

        expect(config.rpId).toBe('app.example.com');
        expect(config.origins).toEqual(['https://app.example.com']);
    });

    it('row C1: rpName defaults to the rpId, and the TTLs to their documented values', () =>
    {
        const config = getPasskeyConfig({ SPFN_APP_URL: 'https://app.example.com' });

        expect(config.rpName).toBe('app.example.com');
        expect(config.userVerification).toBe('preferred');
        expect(config.challengeTtlMs).toBe(300_000);
        expect(config.recentAuthMs).toBe(600_000);
    });

    it('row C2: an explicit rpId with two origins under it is valid', () =>
    {
        const config = getPasskeyConfig(envOf({
            SPFN_AUTH_PASSKEY_RP_ID: 'example.com',
            SPFN_AUTH_PASSKEY_ORIGINS: 'https://app.example.com,https://admin.example.com',
        }));

        expect(config.rpId).toBe('example.com');
        expect(config.origins).toEqual(['https://app.example.com', 'https://admin.example.com']);
    });

    it('row C3: an origin whose host is not under the rpId refuses boot', () =>
    {
        const env = envOf({
            SPFN_AUTH_PASSKEY_RP_ID: 'example.com',
            SPFN_AUTH_PASSKEY_ORIGINS: 'https://app.other.com',
        });

        expect(() => assertPasskeyConfig(env)).toThrow('is not on relying party ID');
        expect(() => assertPasskeyConfig(env)).toThrow('https://app.other.com');
    });

    it('row C3: a host that merely ends with the rpId text is not under it', () =>
    {
        // 'notexample.com' ends with 'example.com' as a string but is another
        // registrable domain; only a dot-separated suffix counts.
        expect(() => assertPasskeyConfig(envOf({
            SPFN_AUTH_PASSKEY_RP_ID: 'example.com',
            SPFN_AUTH_PASSKEY_ORIGINS: 'https://notexample.com',
        }))).toThrow('is not on relying party ID');
    });

    it('row C4: a plain-http origin outside localhost refuses boot', () =>
    {
        expect(() => assertPasskeyConfig(envOf({
            SPFN_AUTH_PASSKEY_RP_ID: 'app.example.com',
            SPFN_AUTH_PASSKEY_ORIGINS: 'http://app.example.com',
        }))).toThrow('is not https');
    });

    it('row C5: http://localhost:3000 is valid — the one secure-context exception', () =>
    {
        const config = getPasskeyConfig({ SPFN_APP_URL: 'http://localhost:3000' });

        expect(config.rpId).toBe('localhost');
        expect(config.origins).toEqual(['http://localhost:3000']);
        expect(() => assertPasskeyConfig({ SPFN_APP_URL: 'http://localhost:3000' })).not.toThrow();
    });

    it('row C6: user verification "discouraged" refuses boot', () =>
    {
        expect(() => assertPasskeyConfig(envOf({
            SPFN_AUTH_PASSKEY_USER_VERIFICATION: 'discouraged',
        }))).toThrow('expected preferred or required');
    });

    it('row C6: "required" is accepted', () =>
    {
        expect(getPasskeyConfig(envOf({ SPFN_AUTH_PASSKEY_USER_VERIFICATION: 'required' })).userVerification)
            .toBe('required');
    });

    it('prefers NEXT_PUBLIC_SPFN_APP_URL over SPFN_APP_URL, as the OAuth callbacks do', () =>
    {
        const config = getPasskeyConfig({
            SPFN_APP_URL: 'http://localhost:3000',
            NEXT_PUBLIC_SPFN_APP_URL: 'https://app.example.com',
        });

        expect(config.rpId).toBe('app.example.com');
    });

    it('an explicit rpName and TTLs override the defaults', () =>
    {
        const config = getPasskeyConfig(envOf({
            SPFN_AUTH_PASSKEY_RP_NAME: 'Acme',
            SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS: '120',
            SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES: '5',
        }));

        expect(config.rpName).toBe('Acme');
        expect(config.challengeTtlMs).toBe(120_000);
        expect(config.recentAuthMs).toBe(300_000);
    });

    it('refuses a TTL that is not a positive number', () =>
    {
        expect(() => assertPasskeyConfig(envOf({ SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS: '0' })))
            .toThrow('expected a positive number');
    });

    it('refuses an app URL that does not parse, naming both variables', () =>
    {
        expect(() => getPasskeyConfig({ SPFN_APP_URL: 'not a url' })).toThrow('is not a URL');
    });

    describe('what refuses boot, and what only refuses a ceremony', () =>
    {
        // The app URL a laptop serves to a phone on the same network: neither
        // https nor localhost, so passkeys cannot run on it — but an app that
        // never asked for passkeys must still start.
        const LAN_DEV = { SPFN_APP_URL: 'http://192.168.1.5:3000' };

        it('boots when nothing passkey-related is set, even on a URL passkeys cannot use', () =>
        {
            expect(() => assertPasskeyConfig(LAN_DEV)).not.toThrow();
            expect(() => getPasskeyConfig(LAN_DEV)).toThrow('is not https');
        });

        it('refuses boot on the same URL once a passkey variable says the feature is wanted', () =>
        {
            expect(() => assertPasskeyConfig({ ...LAN_DEV, SPFN_AUTH_PASSKEY_RP_NAME: 'Acme' }))
                .toThrow('is not https');
        });
    });
});
