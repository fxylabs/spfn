/**
 * The headless second-factor confirm page (GitHub fxylabs/spfn#107).
 *
 * `useMfaConfirm` is glue over `mfa-confirm-flow.ts`: the URL read, the error →
 * state mapping, the passkey result → state mapping and the one-at-a-time rule
 * all live there and run here in node. The proofs are a stubbed `MfaVerifier` —
 * the real helpers are `completeMfaWith*`, pinned in their own spec.
 *
 * The errors are the ones a browser actually receives: each is serialized the
 * way the backend or the proxy serializes it and restored by an `ErrorRegistry`
 * holding `authErrorRegistry`, which is what `authApi` does with a refusal.
 *
 * Each `it` is named for its row in the #107 case table.
 */

import { describe, expect, it, vi } from 'vitest';

import { ErrorRegistry } from '@spfn/core/errors';

import {
    authErrorRegistry,
    MfaVerificationFailedError,
    SessionPendingExpiredError,
    SessionPendingMismatchError,
} from '../../errors';
import { refusalBody } from '../../nextjs/interceptors/error-envelope';
import {
    createMfaConfirmController,
    DEFAULT_SIGN_IN_PATH,
    readConfirmInput,
    settlePasskey,
    stateForError,
    type MfaConfirmSnapshot,
    type MfaVerifier,
} from '../../nextjs/components/mfa-confirm-flow';

const CHALLENGE = 'q3Jd0a7Vx2mKc9LbT1wZr8YpNe5Hs4Gf6Uo0Ai3Bk2E';

const registry = new ErrorRegistry([authErrorRegistry]);

/** A backend refusal as the client restores it. */
function fromBackend(error: MfaVerificationFailedError): Error
{
    return registry.deserialize(error.toJSON() as { __type: string });
}

/** A proxy-minted refusal (`mfaVerifyInterceptor`) as the client restores it. */
function fromProxy(error: SessionPendingExpiredError | SessionPendingMismatchError): Error
{
    return registry.deserialize(refusalBody(error) as { __type: string });
}

const VERIFIED = { userId: '7', keyId: 'key-1' };

function verifierStub(overrides: Partial<MfaVerifier> = {}): MfaVerifier
{
    return {
        code: vi.fn().mockResolvedValue(VERIFIED),
        recoveryCode: vi.fn().mockResolvedValue(VERIFIED),
        passkey: vi.fn().mockResolvedValue({ ok: true, ...VERIFIED }),
        passkeySupported: vi.fn().mockReturnValue(true),
        ...overrides,
    };
}

/** A controller over the stub, recording every state it passed through. */
function confirmPage(verifier: MfaVerifier, returnPath = '/settings')
{
    const states: MfaConfirmSnapshot[] = [];
    const navigate = vi.fn();
    const controller = createMfaConfirmController({
        verifier,
        returnPath,
        navigate,
        onChange: snapshot => states.push(snapshot),
    });

    return { controller, navigate, states, last: () => states[states.length - 1] };
}

describe('readConfirmInput', () =>
{
    it('row 8: a confirm URL without challenge has nothing to verify — the hook goes to /auth/login', () =>
    {
        expect(readConfirmInput('?returnUrl=%2Fsettings').challenge).toBeNull();
        expect(readConfirmInput('?challenge=&returnUrl=%2F').challenge).toBeNull();
        expect(DEFAULT_SIGN_IN_PATH).toBe('/auth/login');
    });

    it.each([
        ['//evil.test'],
        ['https://evil.test'],
        ['/\t/evil.test'],
    ])('row 9: returnUrl=%s is read as the return path /', (returnUrl) =>
    {
        const input = readConfirmInput(`?challenge=${CHALLENGE}&returnUrl=${encodeURIComponent(returnUrl)}`);

        expect(input).toEqual({ challenge: CHALLENGE, returnPath: '/' });
    });

    it('reads the names the callback seams write', () =>
    {
        expect(readConfirmInput(`?challenge=${CHALLENGE}&returnUrl=%2Fa%3Fb%3D1`))
            .toEqual({ challenge: CHALLENGE, returnPath: '/a?b=1' });
    });
});

describe('stateForError', () =>
{
    it('reads a class restored by authErrorRegistry and a raw envelope the same way', () =>
    {
        expect(stateForError(fromBackend(new MfaVerificationFailedError()))).toBe('wrong');
        expect(stateForError({ name: 'ApiError', status: 401, response: { __type: 'MfaVerificationFailedError' } })).toBe('wrong');
        expect(stateForError({ name: 'ApiError', status: 401, response: refusalBody(new SessionPendingExpiredError()) })).toBe('expired');
        expect(stateForError(undefined)).toBe('failed');
    });
});

describe('settlePasskey', () =>
{
    it('an unexpected ceremony error is failed, with the error kept', () =>
    {
        const error = new Error('SecurityError');

        expect(settlePasskey({ ok: false, reason: 'error', error })).toEqual({ state: 'failed', error });
    });
});

describe('useMfaConfirm flow (#107)', () =>
{
    it('row 10: submitCode resolving goes submitting, then assigns the return path', async () =>
    {
        const page = confirmPage(verifierStub());

        await page.controller.submitCode('123456');

        expect(page.states.map(snapshot => snapshot.state)).toEqual(['submitting']);
        expect(page.navigate).toHaveBeenCalledExactlyOnceWith('/settings');
    });

    it('row 11: submitCode rejecting MfaVerificationFailedError (401) is wrong, no navigation', async () =>
    {
        const error = fromBackend(new MfaVerificationFailedError());
        const page = confirmPage(verifierStub({ code: vi.fn().mockRejectedValue(error) }));

        await page.controller.submitCode('000000');

        expect(page.last()).toMatchObject({ state: 'wrong', error });
        expect(page.navigate).not.toHaveBeenCalled();
    });

    it('row 12: wrong is recoverable — the next submit that succeeds navigates', async () =>
    {
        const code = vi.fn()
            .mockRejectedValueOnce(fromBackend(new MfaVerificationFailedError()))
            .mockResolvedValueOnce(VERIFIED);
        const page = confirmPage(verifierStub({ code }));

        await page.controller.submitCode('000000');
        await page.controller.submitCode('123456');

        expect(page.states.map(snapshot => snapshot.state)).toEqual(['submitting', 'wrong', 'submitting']);
        expect(page.navigate).toHaveBeenCalledExactlyOnceWith('/settings');
    });

    it('row 13: SESSION_PENDING_EXPIRED from the proxy is expired', async () =>
    {
        const page = confirmPage(verifierStub({ code: vi.fn().mockRejectedValue(fromProxy(new SessionPendingExpiredError())) }));

        await page.controller.submitCode('123456');

        expect(page.last().state).toBe('expired');
        expect(page.navigate).not.toHaveBeenCalled();
    });

    it('row 14: SESSION_PENDING_MISMATCH (another browser, no pending cookie of its own) is expired', async () =>
    {
        const page = confirmPage(verifierStub({ code: vi.fn().mockRejectedValue(fromProxy(new SessionPendingMismatchError())) }));

        await page.controller.submitCode('123456');

        expect(page.last().state).toBe('expired');
        expect(page.navigate).not.toHaveBeenCalled();
    });

    it('row 15: a network failure is failed, and the flow holds no input to clear', async () =>
    {
        const error = Object.assign(new Error('Failed to fetch'), { name: 'ApiError', status: 0, errorType: 'network' });
        const page = confirmPage(verifierStub({ code: vi.fn().mockRejectedValue(error) }));

        await page.controller.submitCode('123456');

        expect(page.last()).toEqual({ state: 'failed', error, isPasskeySupported: false });
        expect(page.navigate).not.toHaveBeenCalled();
    });

    it('row 16: submitRecoveryCode resolving navigates, rejecting wrong is wrong', async () =>
    {
        const recoveryCode = vi.fn()
            .mockRejectedValueOnce(fromBackend(new MfaVerificationFailedError()))
            .mockResolvedValueOnce(VERIFIED);
        const verifier = verifierStub({ recoveryCode });
        const page = confirmPage(verifier);

        await page.controller.submitRecoveryCode('ABCD-EFGH');

        expect(page.last().state).toBe('wrong');
        expect(page.navigate).not.toHaveBeenCalled();

        await page.controller.submitRecoveryCode('JKLM-NPQR');

        expect(page.last().state).toBe('submitting');
        expect(page.navigate).toHaveBeenCalledExactlyOnceWith('/settings');
        expect(verifier.code).not.toHaveBeenCalled();
    });

    it.each([
        ['cancelled', 17],
        ['no-credential', 18],
    ] as const)('row %2$i: tryPasskey answering %1$s is idle with no error', async (reason) =>
    {
        const page = confirmPage(verifierStub({ passkey: vi.fn().mockResolvedValue({ ok: false, reason }) }));

        page.controller.detectPasskey();
        await page.controller.tryPasskey();

        expect(page.last()).toEqual({ state: 'idle', error: undefined, isPasskeySupported: true });
        expect(page.navigate).not.toHaveBeenCalled();
    });

    it('row 19: tryPasskey answering unsupported is idle, and isPasskeySupported is false', async () =>
    {
        const page = confirmPage(verifierStub({ passkey: vi.fn().mockResolvedValue({ ok: false, reason: 'unsupported' }) }));

        page.controller.detectPasskey();
        expect(page.last().isPasskeySupported).toBe(true);

        await page.controller.tryPasskey();

        expect(page.last()).toEqual({ state: 'idle', error: undefined, isPasskeySupported: false });
    });

    it('row 19: a browser without WebAuthn reports isPasskeySupported false once checked', () =>
    {
        const page = confirmPage(verifierStub({ passkeySupported: vi.fn().mockReturnValue(false) }));

        page.controller.detectPasskey();

        expect(page.last().isPasskeySupported).toBe(false);
    });

    it('row 20: tryPasskey ok navigates', async () =>
    {
        const page = confirmPage(verifierStub());

        await page.controller.tryPasskey();

        expect(page.navigate).toHaveBeenCalledExactlyOnceWith('/settings');
    });

    it('row 21: tryPasskey whose verify rejects wrong is wrong', async () =>
    {
        const page = confirmPage(verifierStub({ passkey: vi.fn().mockRejectedValue(fromBackend(new MfaVerificationFailedError())) }));

        await page.controller.tryPasskey();

        expect(page.last().state).toBe('wrong');
        expect(page.navigate).not.toHaveBeenCalled();
    });

    it('row 22: a second submit while one is in flight is ignored — no second request', async () =>
    {
        let finish: (value: unknown) => void = () => undefined;
        const code = vi.fn().mockReturnValue(new Promise((resolve) =>
        {
            finish = resolve;
        }));
        const verifier = verifierStub({ code });
        const page = confirmPage(verifier);

        const first = page.controller.submitCode('123456');

        await page.controller.submitCode('123456');
        await page.controller.submitRecoveryCode('ABCD-EFGH');
        await page.controller.tryPasskey();

        finish(VERIFIED);
        await first;

        expect(code).toHaveBeenCalledTimes(1);
        expect(verifier.recoveryCode).not.toHaveBeenCalled();
        expect(verifier.passkey).not.toHaveBeenCalled();
        expect(page.navigate).toHaveBeenCalledOnce();
    });

    it('row 22: after a success the flow takes nothing more — the page is navigating away', async () =>
    {
        const verifier = verifierStub();
        const page = confirmPage(verifier);

        await page.controller.submitCode('123456');
        await page.controller.submitCode('123456');

        expect(verifier.code).toHaveBeenCalledTimes(1);
        expect(page.navigate).toHaveBeenCalledOnce();
    });

    it('row 23: the 6th submit on a spent challenge is still wrong (server 401); no client counter', async () =>
    {
        const code = vi.fn().mockImplementation(async () =>
        {
            throw fromBackend(new MfaVerificationFailedError());
        });
        const page = confirmPage(verifierStub({ code }));

        for (let attempt = 1; attempt <= 6; attempt++)
        {
            await page.controller.submitCode('000000');
        }

        expect(code).toHaveBeenCalledTimes(6);
        expect(page.last().state).toBe('wrong');
        expect(page.navigate).not.toHaveBeenCalled();
    });
});
