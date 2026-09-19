/**
 * @spfn/auth - Second Factor Service
 *
 * An optional second step the owner enrols, that the package then asks for at
 * the moments a stolen first credential would be used. Two forms: a TOTP
 * authenticator app, or a passkey the owner already enrolled and has marked as
 * satisfying a step-up. Ten single-use recovery codes come with either.
 *
 * The rule the whole feature hangs on is the one in `assertStepUp`: an account
 * that never enrolled is answered exactly as it is today, on every route. That
 * is why the enrolment check comes first and returns, before any passkey
 * configuration is read and before any second query is made — an app with no
 * passkeys configured must still be able to change a password.
 *
 * The step-up window is per **device key**, not per account: "this device
 * proved the second factor recently" is the claim a sensitive change needs, and
 * a verification made on a phone must not authorize a change from a laptop. A
 * key rotation carries the row across, because rotating is already proof of the
 * same device.
 *
 * A secret and a recovery code appear in exactly three response bodies —
 * `totp/enroll`, `totp/confirm` and `recovery/regenerate` — and nowhere else:
 * not in `status`, not in an event, and not in a log line.
 */

import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import { ValidationError } from '@spfn/core/errors';
import {
    MfaAlreadyEnrolledError,
    MfaNotEnrolledError,
    MfaVerificationFailedError,
    PasskeyNotFoundError,
    StepUpRequiredError,
} from '@spfn/auth/errors';

import { authLogger } from '../logger';
import { getMfaConfig, getPasskeyConfig } from '../lib/config';
import { decryptMfaSecret, encryptMfaSecret } from '../lib/mfa-cipher';
import { generateRecoveryCodes, matchesRecoveryCode } from '../lib/recovery-codes';
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from '../lib/totp';
import { buildAuthenticationOptions, verifyAuthentication } from '../lib/webauthn';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import {
    keysRepository,
    mfaChallengesRepository,
    mfaEnrolmentRepository,
    mfaRecoveryCodesRepository,
    mfaTotpRepository,
    mfaVerificationsRepository,
    passkeysRepository,
    usersRepository,
} from '../repositories';
import { hashCredential, mintCredential } from '../lib/link-credentials';
import { loginBindingFields, type LoginResult, type MfaChallengeHandle } from './login-result';
import { updateLastLoginService } from './user.service';
import { emitDeviceRegistered } from './device-registration.service';
import { authLoginEvent } from '../events';
import { MFA_CONFIRM_ATTEMPT_LIMIT } from '../entities/mfa-totp';
import type { DeferredLoginEvent, MfaChallenge, MfaChallengeChannel } from '../entities/mfa-challenges';
import type { UserPublicKey } from '../entities/user-public-keys';
import type { MfaVerificationMethod } from '../entities/mfa-verifications';
import { mintChallenge, presentedChallenge, spendChallenge } from './webauthn-challenge.service';

/** How long an unconfirmed enrolment is left lying around before the sweep takes it. */
export const MFA_UNCONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Does this account have a second factor at all?
 *
 * One statement (`repositories/mfa-enrolment.repository.ts`), because every
 * sensitive route and every device registration asks it, including the
 * overwhelming majority that will answer false.
 */
export function mfaEnrolledForUser(userId: number): Promise<boolean>
{
    return mfaEnrolmentRepository.isEnrolled(userId);
}

export interface AssertStepUpParams
{
    userId: number;
    /** The device key this request is signed with — the window is its window. */
    keyId: string;
    /** Override the configured window. Callers needing a tighter one pass it. */
    maxAgeMs?: number;
}

/**
 * Refuse a sensitive change unless this device proved the second factor recently.
 *
 * **No-op for an account with no second factor.** That is the contract of the
 * whole feature: `changePassword` and `revokeAllKeys` have no recency gate
 * today, and adding one for people who never opted in would be a new refusal on
 * routes that never had one. Two of the callers do have a gate of their own —
 * the passkey routes' `assertRecentAuthentication` — and they still run it
 * afterwards; this adds a rule for enrolled accounts rather than replacing one.
 *
 * The unenrolled path therefore costs one indexed lookup and touches no passkey
 * configuration, which is what lets an app with no passkeys at all call it.
 *
 * @throws StepUpRequiredError when the account is enrolled and the window has passed
 */
export async function assertStepUp(params: AssertStepUpParams): Promise<void>
{
    if (!await mfaEnrolledForUser(params.userId))
    {
        return;
    }

    const verification = await mfaVerificationsRepository.findByKeyId(params.keyId);
    const window = params.maxAgeMs ?? getMfaConfig().stepUpWindowMs;

    if (verification?.userId === params.userId && Date.now() - verification.verifiedAt.getTime() <= window)
    {
        return;
    }

    throw new StepUpRequiredError();
}

/**
 * Carry a device's verification onto the key that replaces it.
 *
 * Called from the two rotation seams — `rotateKeyService`, and the `oldKeyId`
 * rotation every login path runs through `registerPublicKeyService`. Without
 * it the window would expire silently on every rotation, which the web proxy
 * does at each login: a user who stepped up a minute ago would be asked again
 * with nothing to connect it to.
 */
export function carryStepUpVerification(userId: number, fromKeyId: string, toKeyId: string): Promise<void>
{
    return mfaVerificationsRepository.moveToKeyId(userId, fromKeyId, toKeyId);
}

// ============================================================================
// New-device step-up (#95)
// ============================================================================

export interface OpenStepUpChallengeParams
{
    userId: number;
    /** The inactive key this challenge would activate. */
    keyId: string;
    channel: MfaChallengeChannel;
    /** The account's key generation right now — the challenge dies with it. */
    keyEpoch: number;
    /** The login announcement the 202 is holding back, when the channel has one. */
    loginEvent?: DeferredLoginEvent;
}

/**
 * Mint the challenge a stopped registration hands back.
 *
 * The secret is returned once and never stored: only its hash reaches the row,
 * so a database dump does not yield a spendable challenge, and `verify` finds a
 * row only for a caller who already had the secret. The row id is not in the
 * answer at all — it is a sequence, and a sequence on an unauthenticated route
 * is a thing an attacker walks.
 */
export async function openStepUpChallengeService(
    params: OpenStepUpChallengeParams,
): Promise<MfaChallengeHandle>
{
    const { secret, hash } = mintCredential();
    const expiresAt = new Date(Date.now() + getMfaConfig().challengeTtlMs);

    const row = await mfaChallengesRepository.create({
        userId: params.userId,
        challengeHash: hash,
        keyId: params.keyId,
        channel: params.channel,
        keyEpoch: params.keyEpoch,
        expiresAt,
        loginEvent: params.loginEvent ?? null,
    });

    await mfaChallengesRepository.markKeyPending(params.keyId, row.id);

    return { secret, expiresAtMillis: expiresAt.getTime() };
}

/**
 * The challenge already outstanding for this key, re-secreted, or null.
 *
 * Registering the same keyId twice is an ordinary path, not a collision: a
 * native client reuses its keyId, and an OAuth state replayed from the back
 * button carries the one it was sealed with. Answering 409 there would refuse a
 * caller for holding a key that is their own and is waiting on them.
 *
 * The row is reused rather than replaced, so the retry inherits the attempts
 * already spent and the expiry already ticking — retrying is not a way around
 * either. Only the secret is new, because the first one exists nowhere: the row
 * holds its hash, and that is the property that keeps a database dump from
 * yielding a spendable challenge.
 */
export async function resumeStepUpChallengeService(
    userId: number,
    keyId: string,
): Promise<MfaChallengeHandle | null>
{
    const live = await mfaChallengesRepository.findLiveByKeyId(userId, keyId);

    if (!live)
    {
        return null;
    }

    const { secret, hash } = mintCredential();

    return await mfaChallengesRepository.resecret(live.id, hash)
        ? { secret, expiresAtMillis: live.expiresAt.getTime() }
        : null;
}

export interface VerifyMfaChallengeParams
{
    /** The secret from the 202 body, the callback query, or the pending page. */
    challenge: string;
    code?: string;
    recoveryCode?: string;
    response?: AuthenticationResponseJSON;
}

/**
 * The sign-in the challenge was standing in for, plus what the proxy needs.
 *
 * `keyId` and `challengeHash` are for the Next.js interceptor and nothing else:
 * it seals a session only when both match the pending cookie it baked at the
 * 202, which is what stops a cookie minted for one flow from sealing a session
 * around another flow's key. Neither is a credential — the hash is what the
 * server already stores, and the key is inactive to anyone without the private
 * half the proxy is holding.
 */
export interface VerifyMfaChallengeResult extends LoginResult
{
    keyId: string;
    challengeHash: string;
}

/**
 * The challenge a presented secret names, if it can still be spent.
 *
 * Every refusal here is the same 401 with the same body, and none of them counts
 * an attempt: a secret that reaches no row, an expired one, one already spent
 * and one from a key generation that has since ended are all states the caller
 * is guessing at, and there is no counter belonging to a guess to move.
 *
 * @throws MfaVerificationFailedError
 */
async function spendableChallenge(challengeHash: string): Promise<MfaChallenge>
{
    const row = await mfaChallengesRepository.findByHash(challengeHash);

    if (!row || row.verifiedAt || row.expiresAt.getTime() <= Date.now())
    {
        throw new MfaVerificationFailedError();
    }

    if (row.keyEpoch !== await usersRepository.currentKeyEpoch(row.userId))
    {
        throw new MfaVerificationFailedError();
    }

    return row;
}

/**
 * Count a wrong proof, and take the challenge away once the tries are spent.
 *
 * Five is the limit, and reaching it deletes the pending key — which is safe
 * only because the counter can be reached by nobody but the holder of the
 * secret: the lookup is by hash, so there is no id for a stranger to name and no
 * way to burn somebody else's attempts from outside.
 *
 * @throws MfaVerificationFailedError always — this is the refusal path
 */
async function countChallengeFailure(row: MfaChallenge): Promise<never>
{
    if (await mfaChallengesRepository.countFailure(row.id))
    {
        await mfaChallengesRepository.dropPendingKey(row.keyId, row.id);

        authLogger.service.warn('Second-factor challenge discarded after repeated wrong proofs', {
            userId: row.userId,
        });
    }

    throw new MfaVerificationFailedError();
}

/**
 * Everything the 202 held back, once the second factor is proved.
 *
 * All three at once and only here, so the account's record of a sign-in matches
 * what actually happened: an attacker with a stolen password produced no login
 * event, no device notice and no `lastLoginAt` — the owner's evidence stays the
 * evidence. The channel is the original one, off the challenge row, because it
 * is what the owner will read in the notice.
 */
async function releaseDeferredAnnouncements(row: MfaChallenge, key: UserPublicKey): Promise<void>
{
    await updateLastLoginService(row.userId);
    await emitDeviceRegistered(key, row.channel);

    if (!row.loginEvent)
    {
        return;
    }

    const mfaEnrolled = await mfaEnrolledForUser(row.userId);

    onAfterCommit(() => authLoginEvent.emit({ ...row.loginEvent!, userId: String(row.userId), mfaEnrolled }));
}

/**
 * Spend a new-device challenge, which activates the key and starts the session.
 *
 * Unauthenticated by construction: the key this would activate is the only one
 * the caller has and it cannot sign anything yet. The challenge secret is the
 * whole credential, and it authorizes exactly this — no other route reads it.
 *
 * The verified mark is a conditional UPDATE, so two requests carrying the same
 * secret produce one session and one 401. The key is activated only after that
 * mark is won, which is what makes "a pending challenge never yields a usable
 * key" true even under a race.
 *
 * The binding the answer carries was decided at **registration**, not here, and
 * is read back off the key row. It has to be: the decision reads the owner's
 * `session_binding` setting together with whether the request came through the
 * trusted Next.js proxy, and this route is unauthenticated and may be called
 * from anywhere — deciding it here would let a direct caller ask for a cookie
 * that believes a bound key is an ordinary one. A bound account that steps up
 * therefore gets exactly the binding and the expiry its sign-in registered, and
 * the ten minutes a challenge may sit for come out of that key's short life.
 *
 * @throws ValidationError when the body names none or more than one proof
 * @throws MfaVerificationFailedError for every other refusal, in one body
 */
export async function verifyMfaChallengeService(
    params: VerifyMfaChallengeParams,
): Promise<VerifyMfaChallengeResult>
{
    const challengeHash = hashCredential(params.challenge);
    const row = await spendableChallenge(challengeHash);

    const method = await attemptSecondFactor({
        userId: row.userId,
        keyId: row.keyId,
        code: params.code,
        recoveryCode: params.recoveryCode,
        response: params.response,
    });

    if (!method)
    {
        await countChallengeFailure(row);
    }

    // The transaction starts here and not at the route, for the reason
    // `totp/confirm` has no route-wide one either: the attempt counter above has
    // to survive the refusal that raised it, and a transaction around the whole
    // request would roll it back with the error — leaving every wrong proof
    // free. From here on the mark, the activation and the announcements do have
    // to land together.
    return await runInTransaction(async () =>
    {
        if (!await mfaChallengesRepository.markVerified(row.id, row.keyEpoch))
        {
            throw new MfaVerificationFailedError();
        }

        await mfaChallengesRepository.activateKey(row.keyId, row.id);
        await mfaVerificationsRepository.record(row.keyId, row.userId, method!);

        return { ...await settleStepUpLogin(row), keyId: row.keyId, challengeHash };
    }, { context: 'auth:mfa-verify' });
}

/**
 * The `LoginResult` a verified challenge answers with.
 *
 * Read from the rows rather than carried on the challenge: the account's name
 * and its `passwordChangeRequired` flag are whatever they are now, and up to ten
 * minutes have passed since the sign-in that minted this.
 */
async function settleStepUpLogin(row: MfaChallenge): Promise<LoginResult>
{
    const user = await usersRepository.findByIdOnPrimary(row.userId);
    const key = await keysRepository.findByKeyIdAndUserId(row.keyId, row.userId);

    if (!user || !key)
    {
        throw new MfaVerificationFailedError();
    }

    await releaseDeferredAnnouncements(row, key);

    return {
        mfaRequired: false,
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
        ...loginBindingFields(key),
    };
}

/**
 * Options for finishing a new-device step-up with a passkey.
 *
 * The step-up challenge stands in for the session this caller does not have yet:
 * it is what names the account, so the WebAuthn challenge can be minted for the
 * right owner without the request having to say who that is. `allowCredentials`
 * is empty for the reason it is everywhere else here (D3), and the ceremony kind
 * is `'mfa'`, so what comes back cannot be spent as a sign-in.
 *
 * @throws MfaVerificationFailedError when the challenge cannot be spent
 */
export async function startMfaChallengeAssertionService(
    challenge: string,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    const row = await spendableChallenge(hashCredential(challenge));

    return await buildAuthenticationOptions({
        config: getPasskeyConfig(),
        challenge: await mintChallenge('mfa', row.userId),
    });
}

/**
 * Drop expired and spent challenges, and the keys they were holding.
 *
 * A pending key is unusable by construction, but it is still a key row on an
 * account nobody is watching, and its challenge is what the owner would be shown
 * if anything ever listed it. Both go once the challenge can no longer do
 * anything. A spent one is kept for the same span as an expired one, so a replay
 * inside the window is answered "already verified" from a row rather than
 * "unknown" from an absence — the same 401 either way, but the record survives
 * long enough to be read in a log.
 *
 * @returns number of challenge rows deleted
 */
export async function sweepMfaChallengesService(): Promise<{ deleted: number }>
{
    return { deleted: await mfaChallengesRepository.sweepFinished(new Date()) };
}

export interface TotpEnrolmentResult
{
    /** The base32 secret, shown once. Never logged, never returned again. */
    secret: string;
    /** The same secret as the URI an authenticator app scans. */
    otpauthUri: string;
}

/**
 * Mint a secret and park it unconfirmed.
 *
 * Calling this twice replaces the unconfirmed row and its failure counter — a
 * user who closed the app before scanning starts over, which is also the
 * documented remedy for a row that spent its five confirm attempts. A
 * **confirmed** enrolment is refused instead: replacing a working second factor
 * is `disable` followed by a fresh enrolment, both step-up gated, so nobody
 * holding only a stolen session can swap an authenticator for their own.
 *
 * @throws MfaAlreadyEnrolledError when a confirmed enrolment already exists
 */
export async function startTotpEnrolmentService(userId: number): Promise<TotpEnrolmentResult>
{
    const existing = await mfaTotpRepository.findByUserId(userId);

    if (existing?.confirmedAt)
    {
        throw new MfaAlreadyEnrolledError();
    }

    const secret = generateTotpSecret();

    await mfaTotpRepository.startEnrolment(userId, encryptMfaSecret(secret, userId));

    const user = await usersRepository.findById(userId);

    return {
        secret,
        otpauthUri: buildOtpauthUri({
            issuer: getMfaConfig().issuer,
            accountName: user?.email || user?.username || user?.phone || user?.publicId || String(userId),
            secret,
        }),
    };
}

export interface ConfirmTotpParams
{
    userId: number;
    /** The device this enrolment is being confirmed from — it gets the first verification. */
    keyId: string;
    code: string;
}

export interface ConfirmTotpResult
{
    /** The ten plaintext codes, shown once. */
    recoveryCodes: string[];
}

/**
 * Spend the first code, which is what turns an enrolment into a second factor.
 *
 * Five wrong codes delete the unconfirmed row: at that point the person is
 * reading the wrong entry in their app, and a fresh `enroll` is both the remedy
 * and what resets the counter. A confirmed row is never deleted this way.
 *
 * The route deliberately runs this outside a transaction, so the counter
 * survives the refusal that raised it; the success path opens its own, because
 * the confirmation, the first verification and the recovery codes have to
 * commit together or not at all.
 *
 * @throws MfaNotEnrolledError | MfaVerificationFailedError
 */
export async function confirmTotpEnrolmentService(params: ConfirmTotpParams): Promise<ConfirmTotpResult>
{
    const row = await mfaTotpRepository.findByUserId(params.userId);

    if (!row || row.confirmedAt)
    {
        throw new MfaNotEnrolledError();
    }

    const step = verifyTotp({ secret: readSecret(row.secretEnc, params.userId), code: params.code });

    if (step === null)
    {
        await countConfirmFailure(params.userId);

        throw new MfaVerificationFailedError();
    }

    return await runInTransaction(async () =>
    {
        await mfaTotpRepository.confirm(params.userId, step);
        await mfaVerificationsRepository.record(params.keyId, params.userId, 'totp');

        return { recoveryCodes: await issueRecoveryCodes(params.userId) };
    }, { context: 'auth:mfa-confirm' });
}

/**
 * Count a wrong confirm, and delete the enrolment once the limit is reached.
 *
 * Deleting rather than locking: the row holds nothing worth keeping, and the
 * next `enroll` mints a new secret. The sixth attempt therefore answers
 * `MfaNotEnrolledError`, which is exactly what the account's state now is.
 */
async function countConfirmFailure(userId: number): Promise<void>
{
    if (await mfaTotpRepository.countFailedConfirm(userId) < MFA_CONFIRM_ATTEMPT_LIMIT)
    {
        return;
    }

    await mfaTotpRepository.deleteByUserId(userId);

    authLogger.service.warn('Second-factor enrolment discarded after repeated wrong codes', { userId });
}

/**
 * Decrypt a stored secret, rewriting the row when it was sealed with a grace key.
 *
 * The rewrite is fire-and-forget after the read: a retired key drains as people
 * use their second factor, and a failure to rewrite must not fail the
 * verification the user is waiting on.
 */
function readSecret(secretEnc: string, userId: number): string
{
    const { value, needsRotation } = decryptMfaSecret(secretEnc, userId);

    if (needsRotation)
    {
        onAfterCommit(() => mfaTotpRepository.updateSecret(userId, encryptMfaSecret(value, userId)));
    }

    return value;
}

/** Raise the generation and hand out ten fresh codes. */
async function issueRecoveryCodes(userId: number): Promise<string[]>
{
    const generation = await mfaRecoveryCodesRepository.currentGeneration(userId) + 1;
    const minted = await generateRecoveryCodes();

    await mfaRecoveryCodesRepository.createGeneration(userId, generation, minted.map(entry => entry.hash));

    return minted.map(entry => entry.code);
}

/**
 * Replace the account's recovery codes, retiring every earlier one.
 *
 * The old generation's rows stay, unspent and unreachable: a code written down
 * last year is refused with the same body as one that never existed, and the
 * record of which generation a spent code came from survives.
 *
 * @throws MfaNotEnrolledError on an account with no second factor
 */
export async function regenerateRecoveryCodesService(userId: number): Promise<{ recoveryCodes: string[] }>
{
    if (!await mfaEnrolledForUser(userId))
    {
        throw new MfaNotEnrolledError();
    }

    return { recoveryCodes: await issueRecoveryCodes(userId) };
}

/**
 * Take the second factor off the account entirely.
 *
 * Idempotent: an account with nothing enrolled is a success, because "make sure
 * MFA is off" has already happened. The passkeys themselves are untouched —
 * only their second-factor marks go, since a credential that signs the owner in
 * is not something this route may remove.
 */
export async function disableMfaService(userId: number): Promise<void>
{
    await mfaTotpRepository.deleteByUserId(userId);
    await mfaRecoveryCodesRepository.deleteByUserId(userId);
    await mfaVerificationsRepository.deleteByUserId(userId);
    await passkeysRepository.clearSecondFactorByUserId(userId);
}

export interface MarkPasskeyParams
{
    userId: number;
    passkeyId: string;
    secondFactor: boolean;
}

/**
 * Mark or unmark one of the caller's passkeys as their second factor.
 *
 * Unmarking the last one is allowed, and leaves the account unenrolled. It is
 * deliberately independent of `assertNotLastRecoveryCredential`, which guards
 * `passkeys/revoke`: that rule protects a way *into* the account, and a
 * second-factor mark is not one — the credential still signs the owner in
 * afterwards, unchanged.
 *
 * @throws PasskeyNotFoundError for a credential that is not theirs, or revoked
 */
export async function markPasskeySecondFactorService(params: MarkPasskeyParams): Promise<MfaStatus>
{
    const marked = await passkeysRepository.markSecondFactorByIdAndUserId(
        Number(params.passkeyId),
        params.userId,
        params.secondFactor,
    );

    if (!marked)
    {
        throw new PasskeyNotFoundError();
    }

    return await mfaStatusService(params.userId);
}

/** What the account surface shows about the second factor. No secret is in it. */
export interface MfaStatus
{
    enrolled: boolean;
    /** Which second factors are live: `'totp'`, `'passkey'`, or both. */
    methods: ('totp' | 'passkey')[];
    /** Unspent codes of the current generation, for the "2 left" warning. */
    recoveryCodesRemaining: number;
}

/**
 * The account's second-factor state.
 *
 * Carries no secret, no otpauth URI and no recovery code — only the counts and
 * names an account screen needs. An unconfirmed enrolment is not a method: it
 * gates nothing, so reporting it would tell the owner they are protected when
 * they are not.
 */
export async function mfaStatusService(userId: number): Promise<MfaStatus>
{
    const totp = await mfaTotpRepository.findByUserId(userId);
    const methods: ('totp' | 'passkey')[] = [];

    if (totp?.confirmedAt)
    {
        methods.push('totp');
    }

    if (await mfaEnrolmentRepository.hasSecondFactorPasskey(userId))
    {
        methods.push('passkey');
    }

    const generation = await mfaRecoveryCodesRepository.currentGeneration(userId);

    return {
        enrolled: methods.length > 0,
        methods,
        recoveryCodesRemaining: generation === 0
            ? 0
            : await mfaRecoveryCodesRepository.countUnused(userId, generation),
    };
}

/**
 * Options for a step-up by passkey assertion.
 *
 * `allowCredentials` is empty, as it is for a sign-in and for the same reason
 * (D3): the discoverable credential on the device names itself, and the owner
 * and the second-factor mark are checked when the assertion comes back. The
 * challenge is minted with kind `'mfa'` and this account's id, so it cannot be
 * presented to `passkeys/login/verify` and a sign-in challenge cannot be
 * presented here.
 */
export async function startStepUpService(userId: number): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    return await buildAuthenticationOptions({
        config: getPasskeyConfig(),
        challenge: await mintChallenge('mfa', userId),
    });
}

export interface StepUpParams
{
    userId: number;
    /** The device the verification is recorded against. */
    keyId: string;
    code?: string;
    recoveryCode?: string;
    response?: AuthenticationResponseJSON;
}

/**
 * Re-prove the second factor on this device, refreshing its window.
 *
 * The escape hatch the exempt registration channels need: a device-code
 * approval and a passkey sign-in register a key with no verification against
 * it, by design, so the session they create would otherwise fail every
 * sensitive change with no way forward.
 *
 * @throws ValidationError when the body names none or more than one input
 * @throws MfaNotEnrolledError | MfaVerificationFailedError
 */
export async function stepUpService(params: StepUpParams): Promise<void>
{
    if (!await mfaEnrolledForUser(params.userId))
    {
        throw new MfaNotEnrolledError();
    }

    const method = await verifySecondFactor(params);

    await mfaVerificationsRepository.record(params.keyId, params.userId, method);
}

/**
 * Check exactly one of the three proofs, and say which one it was — or null.
 *
 * Exactly one: two inputs in a body is a caller trying combinations, and none
 * is a malformed request. Neither is a failed verification, so both are a 400
 * rather than the uniform 401 a wrong proof gets.
 *
 * Null rather than a throw for the failure itself, because one caller has
 * bookkeeping to do before it refuses: the new-device challenge counts the
 * attempt, and counting it inside a `catch` around the thing that threw would be
 * two control flows for one answer.
 *
 * @throws ValidationError when the body names none or more than one input
 */
export async function attemptSecondFactor(params: StepUpParams): Promise<MfaVerificationMethod | null>
{
    const presented = [params.code, params.recoveryCode, params.response].filter(value => value !== undefined);

    if (presented.length !== 1)
    {
        throw new ValidationError({
            message: 'Send exactly one of code, recoveryCode or response.',
        });
    }

    if (params.code !== undefined)
    {
        return await verifyTotpProof(params.userId, params.code);
    }

    return params.recoveryCode !== undefined
        ? await verifyRecoveryProof(params.userId, params.recoveryCode)
        : await verifyPasskeyProof(params.userId, params.response!);
}

/**
 * `attemptSecondFactor`, for the callers whose only answer to a wrong proof is
 * the uniform 401.
 *
 * @throws ValidationError | MfaVerificationFailedError
 */
export async function verifySecondFactor(params: StepUpParams): Promise<MfaVerificationMethod>
{
    const method = await attemptSecondFactor(params);

    if (!method)
    {
        throw new MfaVerificationFailedError();
    }

    return method;
}

/**
 * A code from the authenticator app.
 *
 * The step it belongs to is written back, so the same code presented again
 * inside its own 30 seconds is refused — including from a second device, which
 * is the one legitimate case this costs. The client retries on the next step.
 *
 * @returns null when the code does not verify
 */
async function verifyTotpProof(userId: number, code: string): Promise<MfaVerificationMethod | null>
{
    const row = await mfaTotpRepository.findByUserId(userId);

    if (!row?.confirmedAt)
    {
        return null;
    }

    const step = verifyTotp({
        secret: readSecret(row.secretEnc, userId),
        code,
        lastUsedStep: row.lastUsedStep,
    });

    if (step === null)
    {
        return null;
    }

    await mfaTotpRepository.recordUsedStep(userId, step);

    return 'totp';
}

/**
 * One of the ten written-down codes.
 *
 * Scoped to this account and its current generation, so a spent code, a code
 * from before the last regeneration and somebody else's code are all outside
 * the query rather than distinguished by it. The spend is a conditional UPDATE,
 * so two requests carrying the same code produce one winner.
 *
 * @returns null when the code does not verify
 */
async function verifyRecoveryProof(userId: number, submitted: string): Promise<MfaVerificationMethod | null>
{
    const generation = await mfaRecoveryCodesRepository.currentGeneration(userId);
    const candidates = generation === 0 ? [] : await mfaRecoveryCodesRepository.listUnused(userId, generation);

    for (const candidate of candidates)
    {
        const matched = await matchesRecoveryCode(submitted, candidate.codeHash);

        if (matched && await mfaRecoveryCodesRepository.consume(candidate.id))
        {
            return 'recovery';
        }
    }

    return null;
}

/**
 * An assertion from a passkey the owner marked as a second factor.
 *
 * A passkey they never marked is refused with the same body as a wrong code:
 * enrolling a credential is not the same decision as making it a second factor,
 * and the surface must not say which of the two is missing.
 *
 * @returns null when the assertion does not verify
 */
async function verifyPasskeyProof(
    userId: number,
    response: AuthenticationResponseJSON,
): Promise<MfaVerificationMethod | null>
{
    const challenge = presentedChallenge(response.response.clientDataJSON);

    if (!await spendChallenge(challenge, 'mfa', userId))
    {
        return null;
    }

    const marked = await passkeysRepository.listLiveSecondFactorByUserId(userId);
    const passkey = marked.find(row => row.credentialId === response.id);

    if (!passkey)
    {
        return null;
    }

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
        return null;
    }

    await passkeysRepository.recordUse(passkey.id, outcome.newCounter);

    return 'passkey';
}

/**
 * Drop enrolments nobody ever confirmed.
 *
 * A secret handed out and abandoned is a credential sitting in a table doing
 * nothing; a day is long enough for anyone who meant to finish.
 *
 * @returns number of rows deleted
 */
export async function sweepUnconfirmedMfaService(): Promise<{ deleted: number }>
{
    const cutoff = new Date(Date.now() - MFA_UNCONFIRMED_TTL_MS);

    return { deleted: await mfaTotpRepository.deleteUnconfirmedBefore(cutoff) };
}
