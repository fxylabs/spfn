/**
 * @spfn/auth - Session Renewal Service
 *
 * What a bound session does when its key runs out: prove, with a fresh WebAuthn
 * assertion, that the person who enrolled the passkey is still at the machine,
 * and get a new short-lived key sealed into the cookie.
 *
 * Both steps are public, because the session they repair is the one that stopped
 * working — there is no live credential left to authenticate with. That shapes
 * everything below.
 *
 * The expiring key is named by `expiredKeyId`, which the Next.js proxy injects
 * from the HttpOnly key-id cookie. It is treated as unauthenticated input all the
 * same: a caller reaching the route directly can send any value, so nothing is
 * decided by it beyond finding a row, and the assertion has to be signed by a
 * passkey that row's owner enrolled.
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

import { SessionRenewalRefusedError } from '@spfn/auth/errors';

import { getBoundKeyRenewGraceMs } from '../lib/config';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import { keysRepository, usersRepository } from '../repositories';
import type { UserPublicKey } from '../entities/user-public-keys';
import type { User } from '../entities/users';
import type { KeyAlgorithmType } from '../types';
import { registerPublicKeyService, revokeKeyService } from './key.service';
import { startRenewalCeremonyService, verifyRenewalAssertionService } from './passkey.service';
import { loginBindingFields, type LoginResult } from './auth.service';

/** What the old key is revoked with, in the voice `revoked_reason` is written in. */
const RENEWAL_REVOCATION_REASON = 'Replaced by bound-session renewal';

export interface StartSessionRenewParams
{
    /** The key that ran out, injected by the proxy from the key-id cookie. */
    expiredKeyId: string;
}

export interface FinishSessionRenewParams extends StartSessionRenewParams
{
    /** The assertion, from `navigator.credentials.get()`. */
    response: AuthenticationResponseJSON;
    /**
     * The new key pair, in the vocabulary the Next.js login interceptor already
     * writes: `renew/verify` is on that interceptor's path list, so these arrive
     * exactly as they do on a login and the expiring key gets its own name.
     */
    keyId: string;
    publicKey: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
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
    const { key } = await admitForRenewal(params.expiredKeyId);

    return await startRenewalCeremonyService(key.userId);
}

/**
 * Step 2 — verify the assertion, put a new bound key in place of the old one.
 *
 * The revocation runs first and its answer is the race winner: two verifies that
 * both got past their own challenges meet at the same conditional UPDATE, and
 * only the one that actually revoked the key goes on to register a replacement.
 *
 * The new key inherits the old row's provenance, so the device list keeps saying
 * where this device first appeared rather than re-stamping itself every day. Its
 * expiry is a fresh window from now — renewal is a renewal, not an extension of
 * what the old key had.
 *
 * @throws SessionRenewalRefusedError 갱신할 수 없을 때 (증명 실패 포함, 모든 사유 동일)
 */
export async function finishSessionRenewService(
    params: FinishSessionRenewParams,
): Promise<LoginResult>
{
    const { key, user } = await admitForRenewal(params.expiredKeyId);

    if (!await verifyRenewalAssertionService(key.userId, params.response))
    {
        throw new SessionRenewalRefusedError();
    }

    const revoked = await revokeKeyService({
        userId: key.userId,
        keyId: key.keyId,
        reason: RENEWAL_REVOCATION_REASON,
    });

    if (!revoked)
    {
        throw new SessionRenewalRefusedError();
    }

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
        binding: 'passkey',
        replacesKeyId: key.keyId,
    });

    return {
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
        ...loginBindingFields(registered),
    };
}

/**
 * The key a renewal may act on and the account behind it, or the one refusal.
 *
 * Four conditions, and the caller learns which of them failed only by not being
 * told: the row exists, it is still active, it is bound, and it is inside its
 * renewal grace. The account has to be one that may hold a session at all —
 * suspended and pending-deletion accounts do not get a new key by this door any
 * more than they get one by the sign-in door.
 *
 * @throws SessionRenewalRefusedError
 */
async function admitForRenewal(expiredKeyId: string): Promise<{ key: UserPublicKey; user: User }>
{
    const key = expiredKeyId ? await keysRepository.findByKeyId(expiredKeyId) : null;

    if (!key || !key.isActive || key.binding !== 'passkey' || !key.expiresAt)
    {
        throw new SessionRenewalRefusedError();
    }

    // Early renewal is allowed — a browser that asks a minute before its key runs
    // out should not have to wait for the failure first. Late renewal is allowed
    // for the grace window, so a laptop closed over a long weekend comes back to
    // one prompt instead of a sign-in; past it there is nothing to continue.
    if (Date.now() > key.expiresAt.getTime() + getBoundKeyRenewGraceMs())
    {
        throw new SessionRenewalRefusedError();
    }

    const user = await usersRepository.findById(key.userId);

    if (!user || user.status !== 'active')
    {
        throw new SessionRenewalRefusedError();
    }

    return { key, user };
}
