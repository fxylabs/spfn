/**
 * @spfn/auth - Session Renewal Service
 *
 * What a bound session does when its key runs out: prove, with a fresh WebAuthn
 * assertion, that the person who enrolled the passkey is still at the machine,
 * and get a new short-lived key sealed into the cookie.
 *
 * Neither step is public. The expiring key is named by `expiredKeyId`, and that
 * value reaches the service from `authenticateForRenewal` — the `keyId` of a
 * bearer JWT this very key signed — rather than from the request body, so a
 * caller who does not hold the private half cannot name a key at all. The
 * assertion still has to be signed by a passkey that key's owner enrolled: the
 * signature proves the cookie, and the cookie is the thing that may have been
 * copied.
 *
 * The admission below is run again here all the same. The middleware and the
 * service ask the same four questions of the row, and a service that trusted its
 * caller to have asked them would be one refactor away from not being asked at
 * all.
 *
 * Every refusal is the same refusal. A key that never existed, a stranger's key,
 * an unbound key, a revoked one, one past its grace, an inactive account, a spent
 * challenge, an assertion that did not verify — all `SessionRenewalRefusedError`,
 * with the same body, because anything finer would answer "is this key id live"
 * to whoever asked.
 *
 * Renewal announces nothing. No `auth.login`, no `auth.device.registered`, and
 * `lastLoginAt` does not move: this is the same person on the same device
 * continuing the session they already had, and a subscriber mailing "new sign-in"
 * once a day per device would train its reader to ignore the notice that matters.
 * A `lastLoginAt` that moved every day would make dormant-account detection
 * meaningless for exactly the accounts that turned this protection on.
 */

import { runInTransaction } from '@spfn/core/db';
import { SessionRenewalRefusedError } from '@spfn/auth/errors';

import type { PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import { keysRepository } from '../repositories';
import type { UserPublicKey } from '../entities/user-public-keys';
import type { User } from '../entities/users';
import type { KeyAlgorithmType } from '../types';
import { registerPublicKeyService, registeredBinding } from './key.service';
import { secondFactorEnrolmentFields } from './second-factor-policy.service';
import { checkRenewalAssertionService, startRenewalCeremonyService } from './passkey.service';
import { stampFor } from '../lib/deferred-stamp';
import { loginBindingFields, type LoginResult } from './auth.service';
import { admitPrincipal } from './admission.service';

/** What the old key is revoked with, in the voice `revoked_reason` is written in. */
const RENEWAL_REVOCATION_REASON = 'Replaced by bound-session renewal';

export interface StartSessionRenewParams
{
    /** The key that ran out, read off the JWT the request was signed with. */
    expiredKeyId: string;
}

export interface FinishSessionRenewParams extends StartSessionRenewParams
{
    /** The assertion, from `navigator.credentials.get()`. */
    response: unknown;
    /**
     * The new key pair, in the vocabulary the Next.js login interceptor already
     * writes: `renew/verify` is on that interceptor's path list, so these arrive
     * exactly as they do on a login.
     */
    keyId: string;
    publicKey: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
}

/**
 * What a completed renewal answers: a sign-in result, plus the new key's id.
 *
 * The id is the one thing a renewal has that a sign-in does not need to say —
 * `renewSession()` promises it to the app, which has no other way to learn it
 * (the key pair is minted in the proxy and the private half never leaves the
 * cookie). It is not a contract operation, so nothing generated reads it.
 */
export interface SessionRenewResult extends LoginResult
{
    /** The key this renewal registered, the one the session now signs with. */
    keyId: string;
}

/**
 * Step 1 — the challenge the authenticator signs.
 *
 * `allowCredentials` is empty and the account lives only on the challenge row.
 * See `startRenewalCeremonyService`.
 *
 * @throws SessionRenewalRefusedError 갱신할 수 없는 키·계정일 때 (모든 사유 동일)
 */
export async function startSessionRenewService(
    params: StartSessionRenewParams,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    const { key, user } = await admitForRenewal(params.expiredKeyId);

    return await startRenewalCeremonyService('renewal', stampFor(user, { kind: 'deviceKey', keyId: key.keyId }));
}

/**
 * Step 2 — verify the assertion, put a new bound key in place of the old one.
 *
 * The assertion is checked outside any transaction: one that does not verify
 * spends its challenge in a transaction of its own before the refusal, so it
 * cannot be tried again (au9-N7). The success path opens one transaction, in
 * which the challenge — only if it was minted for this very key — is spent,
 * the old key revoked and the new one registered together, so a failure
 * part-way leaves a session that can still be renewed rather than one with no
 * key at all.
 *
 * The old key is revoked by the registration itself, in the statement that
 * checks it is still live: two verifies that both got past their own challenges
 * meet at that conditional UPDATE, and only the one that actually revoked the
 * key goes on to write a replacement.
 *
 * @throws SessionRenewalRefusedError 갱신할 수 없을 때 (증명 실패 포함, 모든 사유 동일)
 */
export async function finishSessionRenewService(
    params: FinishSessionRenewParams,
): Promise<SessionRenewResult>
{
    const { key, user } = await admitForRenewal(params.expiredKeyId);
    const proof = await checkRenewalAssertionService({
        userId: key.userId,
        ceremony: 'renewal',
        credential: { kind: 'renewal', keyId: key.keyId },
        response: params.response,
    });

    if (!proof)
    {
        throw new SessionRenewalRefusedError();
    }

    return await runInTransaction(async () =>
    {
        if (!await proof.spend())
        {
            throw new SessionRenewalRefusedError();
        }

        return await renewKey(params, key, user);
    }, { context: 'auth:session-renew' });
}

/**
 * Register the bound key that replaces `key`.
 *
 * The new key inherits the old row's provenance, so the device list keeps saying
 * where this device first appeared rather than re-stamping itself every day. Its
 * expiry is a fresh window from now — renewal is a renewal, not an extension of
 * what the old key had.
 */
async function renewKey(params: FinishSessionRenewParams, key: UserPublicKey, user: User): Promise<SessionRenewResult>
{
    const registered = await registerPublicKeyService({
        userId: key.userId,
        keyId: params.keyId,
        publicKey: params.publicKey,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        deviceName: key.deviceName ?? undefined,
        platform: key.platform ?? undefined,
        channel: 'renewal',
        // The old row's provenance, not this request's: renewing is not appearing
        // for the first time. Passing the recorded `user-agent` also re-derives
        // the same family, so `registered_ua_family` carries over unchanged.
        ip: key.registeredIp ?? undefined,
        userAgent: key.registeredUserAgent ?? undefined,
        // No `webProxy`: the replacement is the same device as the bound key it
        // replaces, a web key, so it is bound while the account is.
        // The request is signed by the expiring key, which is the replacement's
        // proof. Its revocation is the race winner: two verifies that both got
        // past their own challenges meet at the same conditional UPDATE, and the
        // one that revoked nothing is refused before it writes a key.
        replaces: {
            signedBy: key.keyId,
            reason: RENEWAL_REVOCATION_REASON,
            refusal: new SessionRenewalRefusedError(),
        },
    });

    return {
        // A renewal replaces the key of a device that is already signed in, so
        // it is a rotation rather than an arrival and never steps up (#95).
        mfaRequired: false,
        keyId: params.keyId,
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
        ...loginBindingFields(registeredBinding(registered)),
        ...await secondFactorEnrolmentFields(user.id),
    };
}

/**
 * The key a renewal may act on and the account behind it, or the one refusal.
 *
 * Whether the person may renew is `admitPrincipal`'s, with a `renewal`
 * credential — the account active on the primary, the key of the account's
 * current generation, bound, and inside its renewal grace — and the caller
 * learns which of them failed only by not being told. Suspended and
 * pending-deletion accounts do not get a new key by this door any more than
 * they get one by the sign-in door.
 *
 * @throws SessionRenewalRefusedError
 */
async function admitForRenewal(expiredKeyId: string): Promise<{ key: UserPublicKey; user: User }>
{
    const key = expiredKeyId ? await keysRepository.findByKeyIdOnPrimary(expiredKeyId) : null;

    if (!key)
    {
        throw new SessionRenewalRefusedError();
    }

    const admission = await admitPrincipal({
        userId: key.userId,
        credential: { kind: 'renewal', keyId: key.keyId },
        route: null,
    });

    if ('refused' in admission)
    {
        throw new SessionRenewalRefusedError();
    }

    return { key, user: admission.admitted.user };
}
