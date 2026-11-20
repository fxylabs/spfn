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

import { PasskeyProofRequiredError } from '@spfn/auth/errors';

import {
    enrollPasskey,
    isConditionalMediationAvailable,
    isPasskeySupported,
    renewSession,
    signInWithPasskey,
    stepUpAssertion,
    stepUpWithPasskey,
} from '@/client/passkeys';
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

/** An `authApi` stand-in: the passkey operations, on an account without session binding. */
function apiStub(overrides: Record<string, unknown> = {})
{
    return {
        getSessionBinding: { call: vi.fn().mockResolvedValue({ mode: 'none' }) },
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

    describe('enrollPasskey on an account with session binding on (#400)', () =>
    {
        /** Every call the helper makes, server and browser alike, in the order made. */
        let order: string[];

        function logged<T>(name: string, answer: () => T)
        {
            return vi.fn().mockImplementation(() =>
            {
                order.push(name);

                return answer();
            });
        }

        function boundApi(verify = logged('register/verify', async () => ENROLLED))
        {
            return apiStub({
                getSessionBinding: { call: logged('session/binding', async () => ({ mode: 'passkey' })) },
                passkeyProofOptions: { call: logged('passkey-proof/options', async () => AUTHENTICATION_OPTIONS) },
                passkeyRegisterOptions: { call: logged('register/options', async () => REGISTRATION_OPTIONS) },
                passkeyRegisterVerify: { call: verify },
            });
        }

        const ENROLLED = { passkeyId: '8', label: null, createdAt: '2026-11-20T00:00:00.000Z' };

        function verifyBodies(api: AuthApi): Array<Record<string, unknown>>
        {
            return (api.passkeyRegisterVerify.call as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input.body);
        }

        beforeEach(() =>
        {
            order = [];
            get.mockImplementation(async () =>
            {
                order.push('get()');

                return credentialStub({ authenticatorData: new Uint8Array([8]).buffer, signature: new Uint8Array([9]).buffer });
            });
            create.mockImplementation(async () =>
            {
                order.push('create()');

                return credentialStub({ attestationObject: new Uint8Array([6, 7]).buffer });
            });
        });

        it('E1: bound — the proof runs before the registration, and the verify carries it as passkeyResponse', async () =>
        {
            const api = boundApi();

            expect(await enrollPasskey(api)).toEqual({ ok: true, ...ENROLLED });
            expect(order).toEqual([
                'session/binding', 'passkey-proof/options', 'get()', 'register/options', 'create()', 'register/verify',
            ]);
            expect(api.passkeyProofOptions.call).toHaveBeenCalledWith({ body: { procedure: 'passkeyAdd' } });
            expect(verifyBodies(api)[0].passkeyResponse).toMatchObject({ id: 'Y3JlZA', response: { signature: expect.any(String) } });
        });

        it('E2: bound, the proof prompt dismissed — no-credential, and no credential is made on the authenticator', async () =>
        {
            get.mockRejectedValue(notAllowed());
            const api = boundApi();

            expect(await enrollPasskey(api)).toMatchObject({ ok: false, reason: 'no-credential' });
            expect(create).not.toHaveBeenCalled();
            expect(api.passkeyRegisterVerify.call).not.toHaveBeenCalled();
        });

        it('E3: unbound — no proof is asked, and no prompt but the registration\'s', async () =>
        {
            const api = apiStub({ passkeyProofOptions: { call: vi.fn() } });

            expect(await enrollPasskey(api)).toMatchObject({ ok: true });
            expect(api.passkeyProofOptions.call).not.toHaveBeenCalled();
            expect(get).not.toHaveBeenCalled();
            expect(verifyBodies(api)[0].passkeyResponse).toBeUndefined();
        });

        it('E4: the verify asks the proof once — one proof, the same attestation sent again; asked again, the refusal is thrown', async () =>
        {
            const refused = new PasskeyProofRequiredError({ details: { procedure: 'passkeyAdd' } });
            const again = new PasskeyProofRequiredError({ details: { procedure: 'passkeyAdd' } });
            const verify = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce(ENROLLED);
            const api = apiStub({
                passkeyProofOptions: { call: vi.fn().mockResolvedValue(AUTHENTICATION_OPTIONS) },
                passkeyRegisterVerify: { call: verify },
            });

            expect(await enrollPasskey(api)).toEqual({ ok: true, ...ENROLLED });
            const [first, second] = verifyBodies(api);
            expect(second.response).toBe(first.response);
            expect(first.passkeyResponse).toBeUndefined();
            expect(second.passkeyResponse).toMatchObject({ id: 'Y3JlZA' });
            expect(create).toHaveBeenCalledTimes(1);

            verify.mockReset().mockRejectedValueOnce(refused).mockRejectedValueOnce(again).mockResolvedValue(ENROLLED);

            await expect(enrollPasskey(api)).rejects.toBe(again);
            expect(verify).toHaveBeenCalledTimes(2);
        });

        it('E5: an app-supplied passkeyResponse is sent as given — the binding is not read and no proof prompt is shown', async () =>
        {
            const passkeyResponse = { id: 'app-proof' } as never;
            const api = boundApi();

            expect(await enrollPasskey(api, { passkeyResponse })).toMatchObject({ ok: true });
            expect(order).toEqual(['register/options', 'create()', 'register/verify']);
            expect(verifyBodies(api)[0].passkeyResponse).toBe(passkeyResponse);
        });

        it('E6: a 503 (AccountBusyError) at the verify is busy, not a thrown refusal', async () =>
        {
            const busy = Object.assign(new Error('Another change to this account is in progress. Try again.'), { statusCode: 503 });

            expect(await enrollPasskey(boundApi(vi.fn().mockRejectedValue(busy)))).toEqual({ ok: false, reason: 'busy', error: busy });
        });

        it('E7: a session that may not read its binding (enrolment-only, #309) still enrols, with no proof prompt', async () =>
        {
            const refused = Object.assign(new Error('enrol a second factor first'), { statusCode: 403 });
            const api = apiStub({
                getSessionBinding: { call: vi.fn().mockRejectedValue(refused) },
                passkeyProofOptions: { call: vi.fn() },
            });

            expect(await enrollPasskey(api)).toMatchObject({ ok: true });
            expect(api.passkeyProofOptions.call).not.toHaveBeenCalled();
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

    describe('renewSession', () =>
    {
        /** The two calls a renewal makes, with the verify answering as the route does. */
        function renewApi(verified: Record<string, unknown>)
        {
            return apiStub({
                sessionRenewOptions: { call: vi.fn().mockResolvedValue(AUTHENTICATION_OPTIONS) },
                sessionRenewVerify: { call: vi.fn().mockResolvedValue(verified) },
            });
        }

        function assertionCredential(): void
        {
            get.mockResolvedValue(credentialStub({
                authenticatorData: new Uint8Array([8]).buffer,
                signature: new Uint8Array([9]).buffer,
                userHandle: new Uint8Array([10]).buffer,
            }));
        }

        it('answers the id of the key the renewal registered, which is the only way an app can learn it', async () =>
        {
            // The pair is minted in the Next.js proxy and the private half never
            // leaves the cookie, so the route's answer is the app's only source
            // for the id. It used to be read off a field the response never had.
            assertionCredential();

            const result = await renewSession(renewApi({ userId: '3', publicId: 'pub-3', keyId: 'new-key-7' }));

            expect(result).toEqual({ ok: true, keyId: 'new-key-7' });
        });

        it('sends the assertion and nothing else: the expiring key is named by the credential the proxy signs with', async () =>
        {
            assertionCredential();
            const api = renewApi({ keyId: 'new-key-7' });

            await renewSession(api);

            expect((api.sessionRenewOptions.call as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ body: {} });
            expect(Object.keys((api.sessionRenewVerify.call as ReturnType<typeof vi.fn>).mock.calls[0][0].body))
                .toEqual(['response']);
        });

        it('a person who dismisses the system sheet is not an application error', async () =>
        {
            get.mockRejectedValue(notAllowed());

            expect(await renewSession(renewApi({ keyId: 'x' }))).toMatchObject({ ok: false, reason: 'no-credential' });
        });

        it('a 503 (AccountBusyError) is a retryable failure, not a refusal that sends the person to sign in', async () =>
        {
            assertionCredential();
            const busy = Object.assign(new Error('Another change to this account is in progress. Try again.'), { statusCode: 503 });
            const api = renewApi({});
            (api.sessionRenewVerify.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce(busy);

            expect(await renewSession(api)).toEqual({ ok: false, reason: 'busy', error: busy });
        });

        it('a refusal stays a rejected promise', async () =>
        {
            assertionCredential();
            const refused = Object.assign(new Error('refused'), { statusCode: 401 });
            const api = renewApi({});
            (api.sessionRenewVerify.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce(refused);

            await expect(renewSession(api)).rejects.toBe(refused);
        });

        it('a browser with no WebAuthn at all: answered before the server is asked', async () =>
        {
            stubBrowser({ supported: false });
            const api = renewApi({ keyId: 'x' });

            expect(await renewSession(api)).toEqual({ ok: false, reason: 'unsupported' });
            expect(api.sessionRenewOptions.call).not.toHaveBeenCalled();
        });
    });

    describe('step-up (#393)', () =>
    {
        /** The two step-up calls, `mfa/step-up` answering 204 unless told otherwise. */
        function stepUpApi(stepUp = vi.fn().mockResolvedValue(undefined))
        {
            return apiStub({
                mfaStepUpOptions: { call: vi.fn().mockResolvedValue(AUTHENTICATION_OPTIONS) },
                mfaStepUp: { call: stepUp },
            });
        }

        function assertionCredential(): void
        {
            get.mockResolvedValue(credentialStub({
                authenticatorData: new Uint8Array([8]).buffer,
                signature: new Uint8Array([9]).buffer,
                userHandle: null,
            }));
        }

        it('S1: stepUpAssertion asks the options with an empty body and hands the assertion back, never posting it', async () =>
        {
            // Posting it would spend the challenge, and the app's own
            // checkSecondFactorProof would answer 401 — in production only.
            assertionCredential();
            const api = stepUpApi();

            const result = await stepUpAssertion(api);

            expect(api.mfaStepUpOptions.call).toHaveBeenCalledWith({ body: {} });
            expect(result).toMatchObject({ ok: true, response: { id: 'Y3JlZA', type: 'public-key' } });
            expect(api.mfaStepUp.call).not.toHaveBeenCalled();
        });

        it('S2: a dismissed prompt is no-credential, not a thrown error', async () =>
        {
            get.mockRejectedValue(notAllowed());

            expect(await stepUpAssertion(stepUpApi())).toMatchObject({ ok: false, reason: 'no-credential' });
        });

        it('S2: a browser with no WebAuthn at all: unsupported, answered before the server is asked', async () =>
        {
            stubBrowser({ supported: false });
            const api = stepUpApi();

            expect(await stepUpAssertion(api)).toEqual({ ok: false, reason: 'unsupported' });
            expect(api.mfaStepUpOptions.call).not.toHaveBeenCalled();
        });

        it('S4: stepUpWithPasskey posts the assertion to mfa/step-up and answers ok', async () =>
        {
            assertionCredential();
            const api = stepUpApi();

            const assertion = await stepUpAssertion(stepUpApi());

            expect(assertion.ok).toBe(true);
            expect(await stepUpWithPasskey(api)).toEqual({ ok: true });
            expect((api.mfaStepUp.call as ReturnType<typeof vi.fn>).mock.calls)
                .toStrictEqual([[{ body: { response: assertion.ok && assertion.response } }]]);
        });

        it('S4: a 503 (AccountBusyError) from mfa/step-up is busy, not a refusal', async () =>
        {
            assertionCredential();
            const busy = Object.assign(new Error('Another change to this account is in progress. Try again.'), { statusCode: 503 });

            expect(await stepUpWithPasskey(stepUpApi(vi.fn().mockRejectedValue(busy))))
                .toEqual({ ok: false, reason: 'busy', error: busy });
        });

        it('S4: any other refusal stays a rejected promise', async () =>
        {
            assertionCredential();
            const refused = Object.assign(new Error('refused'), { statusCode: 401 });

            await expect(stepUpWithPasskey(stepUpApi(vi.fn().mockRejectedValue(refused)))).rejects.toBe(refused);
        });

        it('S4: a dismissed prompt in stepUpWithPasskey posts nothing', async () =>
        {
            get.mockRejectedValue(notAllowed());
            const api = stepUpApi();

            expect(await stepUpWithPasskey(api)).toMatchObject({ ok: false, reason: 'no-credential' });
            expect(api.mfaStepUp.call).not.toHaveBeenCalled();
        });
    });
});
