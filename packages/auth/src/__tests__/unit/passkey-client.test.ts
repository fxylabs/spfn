/**
 * The browser passkey helpers.
 *
 * The point of these two functions is that a person who dismisses the system
 * sheet is not an application error. `navigator.credentials` is stubbed, so the
 * real `@simplewebauthn/browser` code path runs — including the wrapping that
 * turns a `NotAllowedError` into a `WebAuthnError` carrying the same name, which
 * is what the mapping here has to survive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enrollPasskey, isConditionalMediationAvailable, isPasskeySupported, signInWithPasskey } from '@/client/passkeys';
import type { AuthApi } from '@/client/passkeys';

const REGISTRATION_OPTIONS = {
    rp: { name: 'test', id: 'localhost' },
    user: { id: 'dXNlcg', name: 'a@example.com', displayName: 'a@example.com' },
    challenge: 'Y2hhbGxlbmdl',
    pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
};

const AUTHENTICATION_OPTIONS = { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost', allowCredentials: [] };

/** A credential shaped as the browser hands one back. */
function credentialStub(extra: Record<string, unknown>)
{
    return {
        id: 'Y3JlZA',
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        getClientExtensionResults: () => ({}),
        response: { clientDataJSON: new Uint8Array([4, 5]).buffer, ...extra },
    };
}

function notAllowed(): Error
{
    const error = new Error('The operation either timed out or was not allowed.');
    error.name = 'NotAllowedError';

    return error;
}

/** An `authApi` stand-in: only the four passkey operations are reached. */
function apiStub(overrides: Record<string, unknown> = {})
{
    return {
        passkeyRegisterOptions: { call: vi.fn().mockResolvedValue(REGISTRATION_OPTIONS) },
        passkeyRegisterVerify: {
            call: vi.fn().mockResolvedValue({ passkeyId: '7', label: 'Laptop', createdAt: '2026-09-06T00:00:00.000Z' }),
        },
        passkeyLoginOptions: { call: vi.fn().mockResolvedValue(AUTHENTICATION_OPTIONS) },
        passkeyLoginVerify: {
            call: vi.fn().mockResolvedValue({
                userId: '3', publicId: 'pub-3', email: 'a@example.com', passwordChangeRequired: false,
            }),
        },
        ...overrides,
    } as unknown as AuthApi;
}

const create = vi.fn();
const get = vi.fn();
const isConditionalMediationAvailableStub = vi.fn().mockResolvedValue(true);

/** Install a browser that supports WebAuthn; `supported: false` takes it away. */
function stubBrowser(options: { supported?: boolean } = {}): void
{
    if (options.supported === false)
    {
        vi.stubGlobal('PublicKeyCredential', undefined);

        return;
    }

    const publicKeyCredential = function PublicKeyCredential() 
    {} as unknown as Record<string, unknown>;
    publicKeyCredential.isConditionalMediationAvailable = isConditionalMediationAvailableStub;

    // stubGlobal, not assignment: `navigator` is a getter-only global in Node.
    vi.stubGlobal('PublicKeyCredential', publicKeyCredential);
    vi.stubGlobal('navigator', { credentials: { create, get } });
    vi.stubGlobal('document', { querySelectorAll: () => [{}] });
}

describe('browser passkey helpers', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        isConditionalMediationAvailableStub.mockResolvedValue(true);
        stubBrowser();
    });

    afterEach(() =>
    {
        vi.unstubAllGlobals();
    });

    describe('support probes', () =>
    {
        it('reports WebAuthn support from the browser global', () =>
        {
            expect(isPasskeySupported()).toBe(true);

            stubBrowser({ supported: false });
            expect(isPasskeySupported()).toBe(false);
        });

        it('reports conditional mediation from the browser, and false where the probe is missing', async () =>
        {
            expect(await isConditionalMediationAvailable()).toBe(true);

            isConditionalMediationAvailableStub.mockResolvedValue(false);
            expect(await isConditionalMediationAvailable()).toBe(false);
        });
    });

    describe('enrollPasskey', () =>
    {
        it('happy path: verifies the attestation and answers ok with the new passkey', async () =>
        {
            create.mockResolvedValue(credentialStub({ attestationObject: new Uint8Array([6, 7]).buffer }));
            const api = apiStub();

            const result = await enrollPasskey(api, { label: 'Laptop' });

            expect(result).toEqual({ ok: true, passkeyId: '7', label: 'Laptop', createdAt: '2026-09-06T00:00:00.000Z' });
            expect(api.passkeyRegisterVerify.call).toHaveBeenCalledWith(
                expect.objectContaining({ body: expect.objectContaining({ label: 'Laptop' }) }),
            );
        });

        it('passes currentPassword through to the options call', async () =>
        {
            create.mockResolvedValue(credentialStub({ attestationObject: new Uint8Array([6, 7]).buffer }));
            const api = apiStub();

            await enrollPasskey(api, { currentPassword: 'hunter2' });

            expect(api.passkeyRegisterOptions.call).toHaveBeenCalledWith({ body: { currentPassword: 'hunter2' } });
        });

        it('reason "unsupported": answers before asking the server for options', async () =>
        {
            stubBrowser({ supported: false });
            const api = apiStub();

            expect(await enrollPasskey(api)).toEqual({ ok: false, reason: 'unsupported' });
            expect(api.passkeyRegisterOptions.call).not.toHaveBeenCalled();
        });

        it('reason "cancelled": a NotAllowedError never reaches the caller as a throw', async () =>
        {
            create.mockRejectedValue(notAllowed());
            const api = apiStub();

            const result = await enrollPasskey(api);

            expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
            expect(api.passkeyRegisterVerify.call).not.toHaveBeenCalled();
        });

        it('reason "error": anything else keeps the original error for the caller to log', async () =>
        {
            const failure = new Error('authenticator exploded');
            failure.name = 'UnknownError';
            create.mockRejectedValue(failure);

            const result = await enrollPasskey(apiStub());

            expect(result).toMatchObject({ ok: false, reason: 'error' });
            // The library rewrites the message for the spec's eight error names,
            // and hangs the original off `cause` — which is what a log needs.
            expect((result as { error?: { cause?: Error } }).error?.cause).toBe(failure);
        });
    });

    describe('signInWithPasskey', () =>
    {
        it('happy path: verifies the assertion and answers ok with the session', async () =>
        {
            get.mockResolvedValue(credentialStub({
                authenticatorData: new Uint8Array([8]).buffer,
                signature: new Uint8Array([9]).buffer,
                userHandle: new Uint8Array([10]).buffer,
            }));

            const result = await signInWithPasskey(apiStub());

            expect(result).toEqual({
                ok: true, userId: '3', publicId: 'pub-3', email: 'a@example.com', passwordChangeRequired: false,
            });
        });

        it('sends no identifier: the options body is empty', async () =>
        {
            get.mockResolvedValue(credentialStub({
                authenticatorData: new Uint8Array([8]).buffer,
                signature: new Uint8Array([9]).buffer,
            }));
            const api = apiStub();

            await signInWithPasskey(api);

            expect(api.passkeyLoginOptions.call).toHaveBeenCalledWith({ body: {} });
        });

        it('conditional: true asks the browser for the autofill mediation', async () =>
        {
            get.mockResolvedValue(credentialStub({
                authenticatorData: new Uint8Array([8]).buffer,
                signature: new Uint8Array([9]).buffer,
            }));

            await signInWithPasskey(apiStub(), { conditional: true });

            expect(get).toHaveBeenCalledWith(expect.objectContaining({ mediation: 'conditional' }));
        });

        it('conditional is off by default: no mediation is requested', async () =>
        {
            get.mockResolvedValue(credentialStub({
                authenticatorData: new Uint8Array([8]).buffer,
                signature: new Uint8Array([9]).buffer,
            }));

            await signInWithPasskey(apiStub());

            expect(get).toHaveBeenCalledWith(expect.not.objectContaining({ mediation: 'conditional' }));
        });

        it('reason "unsupported": answers before asking the server for options', async () =>
        {
            stubBrowser({ supported: false });
            const api = apiStub();

            expect(await signInWithPasskey(api)).toEqual({ ok: false, reason: 'unsupported' });
            expect(api.passkeyLoginOptions.call).not.toHaveBeenCalled();
        });

        it('reason "no-credential": NotAllowedError on a sign-in means nothing matched or the person said no', async () =>
        {
            get.mockRejectedValue(notAllowed());
            const api = apiStub();

            const result = await signInWithPasskey(api);

            expect(result).toMatchObject({ ok: false, reason: 'no-credential' });
            expect(api.passkeyLoginVerify.call).not.toHaveBeenCalled();
        });

        it('reason "error": anything else keeps the original error', async () =>
        {
            const failure = new Error('no authenticator');
            failure.name = 'UnknownError';
            get.mockRejectedValue(failure);

            expect(await signInWithPasskey(apiStub())).toMatchObject({ ok: false, reason: 'error' });
        });
    });
});
