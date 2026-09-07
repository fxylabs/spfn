/**
 * @spfn/auth - Passkey Service
 *
 * WebAuthn passkeys as an optional account credential, alongside a password and
 * a linked social account rather than in place of either.
 *
 *   enroll  -> options on an identified session, then verify the attestation
 *   sign in -> options with no identifier at all, then verify the assertion
 *   manage  -> list, rename, revoke
 *
 * A passkey is not a device key. The assertion proves *who* is asking; the
 * device key registered right after it is what every later request is signed
 * with, exactly as after a password login (D2). Nothing in clientProofV1 or in
 * the JWT path changes because a session started this way.
 *
 * Challenges are rows, spent by one conditional UPDATE (D7). Two verifies
 * arriving with the same challenge therefore produce one winner and one refusal,
 * across instances, rather than both reading it as live.
 *
 * There is no password reset in this package. That is why revoking the last
 * thing an account can sign in with is refused (D6) rather than warned about:
 * nobody, support included, could undo it.
 */

import crypto from 'crypto';

import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import { ValidationError } from '@spfn/core/errors';
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    LastRecoveryCredentialError,
    PasskeyAlreadyRegisteredError,
    PasskeyChallengeError,
    PasskeyNotFoundError,
    PasskeyVerificationError,
    RecentAuthenticationRequiredError,
} from '@spfn/auth/errors';
import { authLogger } from '../logger';
import { getPasskeyConfig } from '../lib/config';
import {
    buildAuthenticationOptions,
    buildRegistrationOptions,
    verifyAuthentication,
    verifyRegistration,
} from '../lib/webauthn';
import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
    RegistrationResponseJSON,
} from '../lib/webauthn';
import {
    keysRepository,
    passkeysRepository,
    socialAccountsRepository,
    usersRepository,
    webauthnChallengesRepository,
} from '../repositories';
import type { Passkey, PasskeyDeviceType } from '../entities/passkeys';
import type { WebAuthnChallengeKind } from '../entities/webauthn-challenges';
import type { User } from '../entities/users';
import { getDummyPasswordHash, verifyPassword } from '../helpers';
import type { KeyAlgorithmType, KeyPlatformType } from '../types';
import { registerPublicKeyService, revokeKeyService } from './key.service';
import { updateLastLoginService } from './user.service';
import { getPendingDeletionInfo } from './account-deletion.service';
import { authLoginEvent, passkeyEnrolledEvent, passkeyRevokedEvent } from '../events';
import type { LoginResult } from './auth.service';

/**
 * Bytes of entropy in a challenge.
 *
 * The WebAuthn spec asks for at least 16; 32 matches every other nonce this
 * package mints and leaves no reason to think about the number again.
 */
const CHALLENGE_BYTES = 32;

/**
 * What is compared when the request carried no password at all.
 *
 * `verifyPassword` refuses an empty string, and skipping the compare would make
 * "you sent nothing" the fastest of the three refusals — which is the timing
 * signal the dummy hash exists to remove. A fixed value nobody can have chosen
 * costs a full bcrypt verify and can never match.
 */
const NO_PASSWORD_PRESENTED = 'spfn-passkey-no-password-presented';

/** One enrolled credential as the management surface shows it. */
export interface PasskeySummary
{
    passkeyId: string;
    label: string | null;
    deviceType: PasskeyDeviceType;
    backedUp: boolean;
    transports: string[];
    createdAt: string;
    lastUsedAt: string | null;
}

/**
 * Neither `credentialId` nor `publicKey` is in the summary.
 *
 * They are what an authenticator is addressed by, and the list exists to let
 * someone recognise a credential and point at it — which the label, the device
 * type and the last-used moment do.
 */
function toSummary(row: Passkey): PasskeySummary
{
    return {
        passkeyId: String(row.id),
        label: row.label,
        deviceType: row.deviceType,
        backedUp: row.backedUp,
        transports: row.transports ?? [],
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    };
}

/**
 * Mint a challenge and park it, returning the value that goes on the wire.
 *
 * Only the SHA-256 reaches the row, so the stored form cannot be presented.
 */
async function mintChallenge(kind: WebAuthnChallengeKind, userId: number | null): Promise<string>
{
    const challenge = crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');

    await webauthnChallengesRepository.create({
        challengeHash: hashChallenge(challenge),
        kind,
        userId,
        expiresAt: new Date(Date.now() + getPasskeyConfig().challengeTtlMs),
    });

    return challenge;
}

/** Hash a presented challenge the way it was stored. */
function hashChallenge(challenge: string): string
{
    return crypto.createHash('sha256').update(challenge).digest('base64url');
}

/**
 * Spend the challenge this ceremony was started with.
 *
 * Unknown, expired, already spent, the other ceremony's kind, or another
 * account's — all one refusal, because the remedy is the same in every case and
 * naming which applies describes a challenge the caller did not mint.
 *
 * @throws PasskeyChallengeError
 */
async function consumeChallenge(
    challenge: string,
    kind: WebAuthnChallengeKind,
    userId: number | null,
): Promise<void>
{
    const spent = await webauthnChallengesRepository.consume(hashChallenge(challenge), kind);

    if (!spent || spent.userId !== userId)
    {
        authLogger.service.warn('Passkey challenge refused', { kind, matched: Boolean(spent) });

        throw new PasskeyChallengeError();
    }
}

/**
 * The challenge the browser echoed back, read out of `clientDataJSON`.
 *
 * Read here rather than trusted from elsewhere in the body: this is the value
 * the authenticator actually signed over, and the library compares it against
 * what we say we expect. Taking it from anywhere else would let a caller point
 * us at a challenge row that has nothing to do with the assertion.
 */
function presentedChallenge(clientDataJSON: string): string
{
    const decoded = parseJson(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };

    return typeof decoded?.challenge === 'string' ? decoded.challenge : '';
}

/**
 * `JSON.parse` that answers null instead of throwing.
 *
 * The body is whatever a caller sent, and a malformed `clientDataJSON` has to
 * come out as the ordinary refusal rather than as a 500: the empty challenge it
 * yields matches no row, which is exactly the answer an unusable ceremony
 * deserves.
 */
function parseJson(text: string): Record<string, unknown> | null
{
    try
    {
        return JSON.parse(text) as Record<string, unknown>;
    }
    catch
    {
        return null;
    }
}

export interface RecentAuthenticationParams
{
    userId: number;
    /** The device key this request is signed with — its age is the signal. */
    keyId: string;
    currentPassword?: string;
}

/**
 * Refuse a passkey change unless the caller has recently proved themselves (D4).
 *
 * Two ways to satisfy it. The device key this request is signed with was
 * registered within the window — that is when this device last presented a
 * credential, and it needs no new state. Or the body carries the account
 * password.
 *
 * An account with no password stored cannot satisfy it with a password, however
 * plausible the value (E5): the comparison still runs, against a dummy hash, so
 * "no password on file" costs exactly what "wrong password" costs. Skipping it
 * would turn response time into an oracle for which accounts are OAuth-only.
 *
 * @throws RecentAuthenticationRequiredError
 */
export async function assertRecentAuthentication(params: RecentAuthenticationParams): Promise<void>
{
    const key = await keysRepository.findByKeyIdAndUserId(params.keyId, params.userId);

    if (key && Date.now() - key.createdAt.getTime() <= getPasskeyConfig().recentAuthMs)
    {
        return;
    }

    const user = await usersRepository.findById(params.userId);
    const storedHash = user?.passwordHash;
    const matched = await verifyPassword(
        params.currentPassword || NO_PASSWORD_PRESENTED,
        storedHash ?? await getDummyPasswordHash(),
    );

    if (storedHash && matched)
    {
        return;
    }

    throw new RecentAuthenticationRequiredError();
}

/**
 * Refuse to remove the only thing an account can sign in with (D6).
 *
 * The recovery paths that exist today are: another live passkey, a password, a
 * linked social account. No password reset exists in this package, so an account
 * left with none of the three is locked out for good — the refusal is not
 * paternalism, it is the absence of an undo.
 *
 * @throws LastRecoveryCredentialError
 */
export async function assertNotLastRecoveryCredential(userId: number): Promise<void>
{
    const live = await passkeysRepository.listLiveByUserId(userId);

    if (live.length > 1)
    {
        return;
    }

    const user = await usersRepository.findById(userId);

    if (user?.passwordHash)
    {
        return;
    }

    const socialAccounts = await socialAccountsRepository.findByUserId(userId);

    if (socialAccounts.length > 0)
    {
        return;
    }

    throw new LastRecoveryCredentialError();
}

/**
 * The WebAuthn user handle: the bytes of `users.publicId` (D8).
 *
 * The public id and never the row id — the handle is stored by the
 * authenticator and can come back from any device, so it must be an identifier
 * we are willing to see off the server. A uuid is 16 bytes, well inside the
 * spec's 64-byte ceiling.
 */
function userHandleOf(user: User): Uint8Array
{
    return new Uint8Array(Buffer.from(user.publicId.replace(/-/g, ''), 'hex'));
}

/** What the authenticator's prompt shows so the owner knows which account this is. */
function displayNameOf(user: User): string
{
    return user.email || user.username || user.phone || user.publicId;
}

export interface StartPasskeyEnrollmentParams
{
    userId: number;
    keyId: string;
    currentPassword?: string;
}

/**
 * Step 1 of enrollment — options for `navigator.credentials.create()`.
 *
 * `excludeCredentials` lists the caller's **live** passkeys only, so the
 * authenticator quietly refuses one already enrolled here. Revoked ones are left
 * out on purpose: they must not be re-enrolled either, and the check that
 * refuses them is the global uniqueness check at verify (E11/M10) — listing them
 * here would hand out credential ids the account no longer uses.
 */
export async function startPasskeyEnrollmentService(
    params: StartPasskeyEnrollmentParams,
): Promise<PublicKeyCredentialCreationOptionsJSON>
{
    await assertRecentAuthentication(params);

    const user = await usersRepository.findById(params.userId);

    if (!user)
    {
        throw new PasskeyNotFoundError();
    }

    const live = await passkeysRepository.listLiveByUserId(params.userId);

    return await buildRegistrationOptions({
        config: getPasskeyConfig(),
        challenge: await mintChallenge('registration', params.userId),
        userHandle: userHandleOf(user),
        userName: displayNameOf(user),
        userDisplayName: displayNameOf(user),
        excludeCredentials: live.map(row => ({
            credentialId: row.credentialId,
            transports: row.transports,
        })),
    });
}

export interface FinishPasskeyEnrollmentParams
{
    userId: number;
    response: RegistrationResponseJSON;
    label?: string;
}

export interface FinishPasskeyEnrollmentResult
{
    passkeyId: string;
    label: string | null;
    createdAt: string;
}

/**
 * Step 2 of enrollment — verify the attestation and keep the credential.
 *
 * Runs under `Transactional()`: the challenge is spent and the row written
 * together, so a failure after the spend leaves the challenge live and the
 * ceremony retryable, while a success can never be replayed.
 */
export async function finishPasskeyEnrollmentService(
    params: FinishPasskeyEnrollmentParams,
): Promise<FinishPasskeyEnrollmentResult>
{
    const challenge = presentedChallenge(params.response.response.clientDataJSON);

    await consumeChallenge(challenge, 'registration', params.userId);

    const verified = await verifyRegistration({
        config: getPasskeyConfig(),
        response: params.response,
        expectedChallenge: challenge,
    });

    if (!verified)
    {
        throw new PasskeyVerificationError();
    }

    // Global, and over revoked rows too: a credential id is reserved for good
    // once used, so this is also what refuses re-enrolling one's own revoked
    // passkey (D5). The unique constraint would catch a race here; this makes
    // the ordinary case a 409 rather than a database error.
    if (await passkeysRepository.existsByCredentialId(verified.credentialId))
    {
        throw new PasskeyAlreadyRegisteredError();
    }

    const row = await passkeysRepository.create({
        userId: params.userId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: verified.transports,
        deviceType: verified.deviceType,
        backedUp: verified.backedUp,
        aaguid: verified.aaguid,
        label: params.label ?? null,
    });

    onAfterCommit(() => passkeyEnrolledEvent.emit({
        userId: String(params.userId),
        passkeyId: String(row.id),
        label: row.label ?? undefined,
    }));

    return { passkeyId: String(row.id), label: row.label, createdAt: row.createdAt.toISOString() };
}

/**
 * Step 1 of sign-in — options for `navigator.credentials.get()`.
 *
 * Takes nothing and returns the same shape to everyone: `allowCredentials` is
 * always empty and the challenge row names no account (D3). There is no input
 * that could make this answer differ by whether an account exists, which is the
 * point — the discoverable credential on the device is what names the owner.
 */
export async function startPasskeyLoginService(): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    return await buildAuthenticationOptions({
        config: getPasskeyConfig(),
        challenge: await mintChallenge('authentication', null),
    });
}

export interface FinishPasskeyLoginParams
{
    response: AuthenticationResponseJSON;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    oldKeyId?: string;
    deviceName?: string;
    platform?: KeyPlatformType;
}

/**
 * Step 2 of sign-in — verify the assertion, then sign in exactly as a password
 * login does.
 *
 * The tail from the active-status check onward is the one every identified
 * sign-in runs (`loginService`, the OAuth flows): revoke the key being replaced,
 * register the new device key, stamp the last login, announce it after commit.
 * Passkeys add a way to prove identity, not a second way to hold a session.
 */
export async function finishPasskeyLoginService(params: FinishPasskeyLoginParams): Promise<LoginResult>
{
    assertDeviceKeyPresent(params);

    return runInTransaction(async () =>
    {
        const challenge = presentedChallenge(params.response.response.clientDataJSON);

        await consumeChallenge(challenge, 'authentication', null);

        const passkey = await passkeysRepository.findLiveByCredentialId(params.response.id);

        // A revoked credential and one that was never here answer identically
        // (L4/L5): anything else says whether this account once had it.
        if (!passkey)
        {
            throw new PasskeyVerificationError();
        }

        const user = await assertActiveForPasskeyLogin(passkey.userId);

        await verifyAssertion(passkey, params.response, challenge);

        return await startSession(user, params);
    }, { context: 'auth:passkey-login' });
}

/**
 * The tail every identified sign-in runs, once identity is settled.
 *
 * Lifted verbatim from `loginService` and the OAuth flows: retire the key being
 * replaced, register the new device key, stamp the last login, announce it after
 * the commit. Passkeys add a way to prove identity, not a second way to hold a
 * session, so this must stay the same four steps in the same order.
 */
async function startSession(user: User, params: FinishPasskeyLoginParams): Promise<LoginResult>
{
    if (params.oldKeyId)
    {
        await revokeKeyService({
            userId: user.id,
            keyId: params.oldKeyId,
            reason: 'Replaced by new key on passkey login',
        });
    }

    await registerPublicKeyService({
        userId: user.id,
        keyId: params.keyId,
        publicKey: params.publicKey,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
    });

    await updateLastLoginService(user.id);

    const result: LoginResult = {
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
    };

    onAfterCommit(() => authLoginEvent.emit({
        userId: result.userId,
        provider: 'passkey',
        email: result.email,
        phone: result.phone,
    }));

    return result;
}

/**
 * Refuse a sign-in whose device-key fields never arrived.
 *
 * They come from the Next.js proxy interceptor, and the route DSL leaves
 * interceptor-declared fields unvalidated on purpose — the middleware owns them.
 * Without this check a caller that bypassed the proxy reaches key registration
 * with nothing to register and is answered 500 for what is plainly a bad
 * request. Checked before the transaction opens, so the challenge is not spent
 * and the ceremony stays retryable.
 *
 * @throws ValidationError
 */
function assertDeviceKeyPresent(params: FinishPasskeyLoginParams): void
{
    const missing = (['publicKey', 'keyId', 'fingerprint'] as const).filter(field => !params[field]);

    if (missing.length === 0)
    {
        return;
    }

    throw new ValidationError({
        message: `Passkey sign-in is missing device key fields: ${missing.join(', ')}. `
            + 'The Next.js proxy interceptor injects them; a caller reaching this route directly must send them.',
    });
}

/**
 * The account behind a verified credential, if it may hold a session.
 *
 * Same two errors as `loginService`, so a disabled or pending-deletion account
 * answers a passkey sign-in exactly as it answers a password one.
 *
 * @throws AccountDisabledError | AccountPendingDeletionError
 */
async function assertActiveForPasskeyLogin(userId: number): Promise<User>
{
    const user = await usersRepository.findById(userId);

    if (!user)
    {
        throw new PasskeyVerificationError();
    }

    if (user.status === 'pending_deletion')
    {
        const pending = await getPendingDeletionInfo(user.id);

        throw new AccountPendingDeletionError({ purgeScheduledAt: pending?.purgeScheduledAt.toISOString() });
    }

    if (user.status !== 'active')
    {
        throw new AccountDisabledError({ status: user.status });
    }

    return user;
}

/**
 * Check the assertion and move the counter, or refuse.
 *
 * A regressed counter is logged by passkey id and left alone (D11). It is the
 * signal a cloned authenticator would produce, but a synced passkey reports 0
 * forever and a legitimate device can hit it after a restore — revoking on it
 * automatically would lock people out over a false positive, so the refusal is
 * per request and a human decides what it meant.
 *
 * @throws PasskeyVerificationError
 */
async function verifyAssertion(
    passkey: Passkey,
    response: AuthenticationResponseJSON,
    challenge: string,
): Promise<void>
{
    const outcome = await verifyAuthentication({
        config: getPasskeyConfig(),
        response,
        expectedChallenge: challenge,
        credential: {
            credentialId: passkey.credentialId,
            publicKey: passkey.publicKey,
            counter: passkey.counter,
            transports: passkey.transports,
        },
    });

    if (!outcome.verified)
    {
        if (outcome.counterRegression)
        {
            authLogger.service.warn(
                'Passkey signature counter went backwards; the sign-in was refused and the passkey left alone',
                { passkeyId: passkey.id, storedCounter: passkey.counter },
            );
        }

        throw new PasskeyVerificationError();
    }

    await passkeysRepository.recordUse(passkey.id, outcome.newCounter);
}

/**
 * The caller's live passkeys, newest first.
 */
export async function listPasskeysService(userId: number): Promise<PasskeySummary[]>
{
    const live = await passkeysRepository.listLiveByUserId(userId);

    return live.map(toSummary);
}

export interface RenamePasskeyParams
{
    userId: number;
    passkeyId: string;
    label: string;
}

/**
 * Rename a passkey. Owner-scoped, so someone else's id is a 404 and nothing
 * about it is disclosed.
 *
 * No recent-authentication gate: a label is display only, and nothing is
 * authorized by it.
 */
export async function renamePasskeyService(
    params: RenamePasskeyParams,
): Promise<{ passkeyId: string; label: string }>
{
    const renamed = await passkeysRepository.renameByIdAndUserId(
        Number(params.passkeyId),
        params.userId,
        params.label,
    );

    if (!renamed)
    {
        throw new PasskeyNotFoundError();
    }

    return { passkeyId: String(renamed.id), label: params.label };
}

export interface RevokePasskeyParams
{
    userId: number;
    keyId: string;
    passkeyId: string;
    currentPassword?: string;
}

/**
 * Retire a passkey.
 *
 * Gated on recent authentication, because someone who walked up to an unlocked
 * laptop should not be able to strip the account's credentials; and on the
 * last-recovery-credential guard, because there is no undo for the state that
 * would leave.
 */
export async function revokePasskeyService(params: RevokePasskeyParams): Promise<{ passkeyId: string }>
{
    await assertRecentAuthentication(params);

    const passkey = await passkeysRepository.findLiveByIdAndUserId(Number(params.passkeyId), params.userId);

    if (!passkey)
    {
        throw new PasskeyNotFoundError();
    }

    await assertNotLastRecoveryCredential(params.userId);

    const revoked = await passkeysRepository.revokeByIdAndUserId(passkey.id, params.userId, 'Revoked by user');

    if (!revoked)
    {
        throw new PasskeyNotFoundError();
    }

    onAfterCommit(() => passkeyRevokedEvent.emit({
        userId: String(params.userId),
        passkeyId: String(revoked.id),
        reason: 'user',
    }));

    return { passkeyId: String(revoked.id) };
}
