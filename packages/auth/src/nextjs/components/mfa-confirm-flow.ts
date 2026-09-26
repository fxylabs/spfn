/**
 * What the second-factor confirm page does, without React.
 *
 * `useMfaConfirm` is the glue; the decisions are here, where node can run them:
 * which URL inputs the page has, which state an error means, which state a
 * passkey result means, and when a submit is let through at all.
 *
 * The states are the ones a person can act on:
 *
 * - `wrong` — the server declined the proof (`MfaVerificationFailedError`, 401).
 *   Recoverable: try again. Five wrong ones end the challenge at the server and
 *   every later proof is the same 401; the page keeps no count of its own.
 * - `expired` — the proxy could not seal a session (`SESSION_PENDING_EXPIRED`,
 *   `SESSION_PENDING_MISMATCH`): the window closed, or this is not the browser
 *   that started the sign-in. The remedy is to sign in again.
 * - `failed` — anything else, a network failure included. Nothing the person
 *   typed is lost; the page owns its inputs and this flow never touches them.
 */

import type { CompleteMfaValue, PasskeyResult } from '@spfn/auth/client';

import { toSafeReturnPath } from '../../lib/return-path';

export type MfaConfirmState = 'idle' | 'submitting' | 'wrong' | 'expired' | 'failed';

/** Where a confirm page without a challenge sends the person — `RequireAuth`'s default too. */
export const DEFAULT_SIGN_IN_PATH = '/auth/login';

export interface MfaConfirmSnapshot
{
    state: MfaConfirmState;

    /** The error behind `wrong`, `expired` or `failed`; undefined otherwise. */
    error: unknown;

    /** False until checked in the browser, and false after a ceremony reports `unsupported`. */
    isPasskeySupported: boolean;
}

export const INITIAL_SNAPSHOT: MfaConfirmSnapshot = { state: 'idle', error: undefined, isPasskeySupported: false };

/** The three proofs, bound to one challenge. */
export interface MfaVerifier
{
    code(code: string): Promise<unknown>;
    recoveryCode(recoveryCode: string): Promise<unknown>;
    passkey(): Promise<PasskeyResult<CompleteMfaValue>>;
    passkeySupported(): boolean;
}

export interface MfaConfirmInput
{
    /** Null when the URL has none — the page has nothing to verify. */
    challenge: string | null;

    /** `?returnUrl=` when it is a path within the app, otherwise `/`. */
    returnPath: string;
}

/** The names the error classes carry, as a deserialized class or as a raw envelope. */
const WRONG = ['MfaVerificationFailedError'];
const EXPIRED = [
    'SessionPendingExpiredError',
    'SessionPendingMismatchError',
    'SESSION_PENDING_EXPIRED',
    'SESSION_PENDING_MISMATCH',
];

/** Read `?challenge=` and `?returnUrl=`, the names the callback seams write. */
export function readConfirmInput(search: string): MfaConfirmInput
{
    const params = new URLSearchParams(search);

    return {
        challenge: params.get('challenge') || null,
        returnPath: toSafeReturnPath(params.get('returnUrl')),
    };
}

/**
 * The state a rejected proof means.
 *
 * Read by name rather than `instanceof`: `authApi` restores the registered class,
 * but a client built without `authErrorRegistry` throws an `ApiError` whose
 * `response` is the envelope, and the answer has to be the same either way.
 */
export function stateForError(error: unknown): 'wrong' | 'expired' | 'failed'
{
    const names = errorNames(error);

    if (names.some(name => WRONG.includes(name)))
    {
        return 'wrong';
    }

    return names.some(name => EXPIRED.includes(name)) ? 'expired' : 'failed';
}

function errorNames(error: unknown): string[]
{
    const candidate = error as { name?: unknown; code?: unknown; response?: { __type?: unknown } } | null;

    return [candidate?.name, candidate?.code, candidate?.response?.__type]
        .filter((name): name is string => typeof name === 'string');
}

/** Marks a proof that succeeded: the only thing left is to leave the page. */
const VERIFIED = 'verified';

type Settled = typeof VERIFIED | Partial<MfaConfirmSnapshot>;

/**
 * What a passkey ceremony's answer means for the page.
 *
 * A dismissed sheet and an authenticator with nothing to offer are not errors —
 * the person changed their mind, and the code input is still there. Neither is a
 * browser without WebAuthn, which only takes the passkey button away.
 */
export function settlePasskey(result: PasskeyResult<CompleteMfaValue>): Settled
{
    if (result.ok)
    {
        return VERIFIED;
    }

    if (result.reason === 'error')
    {
        return { state: 'failed', error: result.error };
    }

    return result.reason === 'unsupported'
        ? { state: 'idle', error: undefined, isPasskeySupported: false }
        : { state: 'idle', error: undefined };
}

/** A code proof has no result to read: resolving is the success. */
async function proved(proof: Promise<unknown>): Promise<Settled>
{
    await proof;

    return VERIFIED;
}

export interface MfaConfirmController
{
    submitCode(code: string): Promise<void>;
    submitRecoveryCode(recoveryCode: string): Promise<void>;
    tryPasskey(): Promise<void>;

    /** Check WebAuthn support; called once mounted, since the server cannot answer it. */
    detectPasskey(): void;
}

export interface MfaConfirmControllerOptions
{
    verifier: MfaVerifier;
    returnPath: string;

    /** A full navigation, so the server reads the session cookie just sealed. */
    navigate(path: string): void;

    onChange(snapshot: MfaConfirmSnapshot): void;
}

/**
 * The confirm page's flow over one challenge.
 *
 * One proof at a time: a submit while another is in flight is dropped, not
 * queued. After a success the flow stays `submitting` and takes nothing more —
 * the page is navigating away.
 */
export function createMfaConfirmController(options: MfaConfirmControllerOptions): MfaConfirmController
{
    let snapshot = INITIAL_SNAPSHOT;
    let busy = false;

    function update(next: Partial<MfaConfirmSnapshot>): void
    {
        snapshot = { ...snapshot, ...next };
        options.onChange(snapshot);
    }

    async function attempt(prove: () => Promise<Settled>): Promise<void>
    {
        if (busy)
        {
            return;
        }

        busy = true;
        update({ state: 'submitting', error: undefined });

        const settled = await prove().catch((error: unknown): Settled => ({ state: stateForError(error), error }));

        if (settled === VERIFIED)
        {
            options.navigate(options.returnPath);

            return;
        }

        busy = false;
        update(settled);
    }

    return {
        submitCode: code => attempt(async () => await proved(options.verifier.code(code))),
        submitRecoveryCode: code => attempt(async () => await proved(options.verifier.recoveryCode(code))),
        tryPasskey: () => attempt(async () => settlePasskey(await options.verifier.passkey())),
        detectPasskey: () => update({ isPasskeySupported: options.verifier.passkeySupported() }),
    };
}
