'use client';

/**
 * useMfaConfirm — the headless second-factor confirm page
 *
 * The page at `SPFN_AUTH_MFA_CONFIRM_PATH` (`/auth/mfa` by default) is the same
 * flow in every app: read `?challenge=` and `?returnUrl=`, prove the second
 * factor with a code, a recovery code or a passkey, and leave for the return
 * path once the proxy has sealed the session. This hook owns that flow; the app
 * owns every input, button and word on the page.
 *
 * The decisions live in `mfa-confirm-flow.ts`. What is here is the part only a
 * browser can do: read the URL, check WebAuthn support, and navigate.
 *
 * @example
 * ```tsx
 * 'use client';
 * import { useMfaConfirm } from '@spfn/auth/nextjs/client';
 *
 * export function MfaForm()
 * {
 *     const mfa = useMfaConfirm();
 *     const [code, setCode] = useState('');
 *
 *     return (
 *         <form onSubmit={(event) => { event.preventDefault(); mfa.submitCode(code); }}>
 *             <input value={code} onChange={(event) => setCode(event.target.value)} />
 *             {mfa.state === 'wrong' && <p>That code did not verify.</p>}
 *             {mfa.state === 'expired' && <a href="/auth/login">Sign in again</a>}
 *             <button disabled={mfa.state === 'submitting'}>Continue</button>
 *             {mfa.isPasskeySupported && <button type="button" onClick={mfa.tryPasskey}>Use a passkey</button>}
 *         </form>
 *     );
 * }
 * ```
 */

import { useEffect, useState } from 'react';

import { authApi } from '@spfn/auth';
import {
    completeMfaWithCode,
    completeMfaWithPasskey,
    completeMfaWithRecoveryCode,
    isPasskeySupported,
    type AuthApi,
} from '@spfn/auth/client';

import {
    createMfaConfirmController,
    DEFAULT_SIGN_IN_PATH,
    INITIAL_SNAPSHOT,
    readConfirmInput,
    type MfaConfirmController,
    type MfaConfirmSnapshot,
    type MfaVerifier,
} from './mfa-confirm-flow';

export interface UseMfaConfirmOptions
{
    /**
     * Where a confirm page opened without `?challenge=` sends the person.
     * @default '/auth/login'
     */
    signInPath?: string;

    /**
     * The typed auth client. Keep it stable across renders.
     * @default authApi
     */
    api?: AuthApi;
}

export interface MfaConfirm extends MfaConfirmSnapshot
{
    submitCode(code: string): Promise<void>;
    submitRecoveryCode(recoveryCode: string): Promise<void>;
    tryPasskey(): Promise<void>;
}

function verifierFor(api: AuthApi, challenge: string): MfaVerifier
{
    return {
        code: code => completeMfaWithCode(api, challenge, code),
        recoveryCode: recoveryCode => completeMfaWithRecoveryCode(api, challenge, recoveryCode),
        passkey: () => completeMfaWithPasskey(api, challenge),
        passkeySupported: isPasskeySupported,
    };
}

/**
 * The confirm page's state and its three actions.
 *
 * The URL is read after mount rather than during render, so the server render
 * and the first client render agree. Until then — and on a page without a
 * challenge, which is on its way to `signInPath` — the actions do nothing.
 */
export function useMfaConfirm({ signInPath = DEFAULT_SIGN_IN_PATH, api = authApi }: UseMfaConfirmOptions = {}): MfaConfirm
{
    const [snapshot, setSnapshot] = useState<MfaConfirmSnapshot>(INITIAL_SNAPSHOT);
    const [controller, setController] = useState<MfaConfirmController | null>(null);

    useEffect(() =>
    {
        const input = readConfirmInput(window.location.search);

        if (!input.challenge)
        {
            window.location.replace(signInPath);

            return;
        }

        const next = createMfaConfirmController({
            verifier: verifierFor(api, input.challenge),
            returnPath: input.returnPath,
            navigate: path => window.location.assign(path),
            onChange: setSnapshot,
        });

        next.detectPasskey();
        setController(next);
    }, [api, signInPath]);

    return {
        ...snapshot,
        submitCode: async code => await controller?.submitCode(code),
        submitRecoveryCode: async recoveryCode => await controller?.submitRecoveryCode(recoveryCode),
        tryPasskey: async () => await controller?.tryPasskey(),
    };
}
