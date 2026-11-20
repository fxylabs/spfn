/**
 * @spfn/auth - Second Factor Service
 *
 * An optional second step the owner enrols, that the package then asks for at
 * the moments a stolen first credential would be used. Two forms: a TOTP
 * authenticator app, or a passkey the owner already enrolled and has marked as
 * satisfying a step-up. Ten single-use recovery codes come with either.
 *
 * The application's second-factor policy (`createAuthLifecycle({ secondFactor })`,
 * #309) narrows all of it: only a listed method counts as enrolled or proves
 * anything, recovery codes can be turned off, and a required policy makes the
 * enrolment itself mandatory — that last part is enforced where a person is
 * authenticated, not here.
 *
 * The rule the whole feature hangs on is the one in `assertStepUp`: an account
 * that never enrolled is answered exactly as it is today, on every route. That
 * is why the enrolment check comes first and returns, before any passkey
 * configuration is read and before any second query is made — an app with no
 * passkeys configured must still be able to change a password.
 *
 * The step-up window is per **credential** — a device key, or an application
 * profile with the key id its verifier reported — not per account: "this
 * device proved the second factor recently" is the claim a sensitive change
 * needs, and a verification made on a phone must not authorize a change from a
 * laptop. A key rotation carries a device key's row across, because rotating
 * is already proof of the same device.
 *
 * One function judges a proof — `checkSecondFactorProof` — and every route that
 * takes one goes through it, so the account's one failure budget
 * (`mfa_attempt_budgets`) is spent by every wrong proof wherever it arrived.
 *
 * A secret and a recovery code appear in exactly three response bodies —
 * `totp/enroll`, `totp/confirm` and `recovery/regenerate` — and nowhere else:
 * not in `status`, not in an event, and not in a log line.
 */

import { getTransactionContext, onAfterCommit, runInTransaction } from '@spfn/core/db';
import { NotFoundError, ValidationError } from '@spfn/core/errors';
import {
    MfaAlreadyEnrolledError,
    MfaNotEnrolledError,
    MfaVerificationFailedError,
    PasskeyNotFoundError,
    PasskeyUserVerificationRequiredError,
    SecondFactorLockedError,
    SignInRefusedError,
    StepUpRequiredError,
} from '@spfn/auth/errors';

import { authLogger } from '../logger';
import { getMfaConfig, getPasskeyConfig } from '../lib/config';
import { decryptMfaSecret, encryptMfaSecret } from '../lib/mfa-cipher';
import { generateRecoveryCodes, matchesRecoveryCode, type MintedRecoveryCode } from '../lib/recovery-codes';
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from '../lib/totp';
import { buildAuthenticationOptions, parseAssertion, verifyAuthentication } from '../lib/webauthn';
import type { AuthenticationResponseJSON, PresentedResponse, PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import {
    keysRepository,
    mfaAttemptBudgetsRepository,
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
import { authLoginEvent, mfaLockedEvent, passkeyRevokedEvent } from '../events';
import type { DeferredLoginEvent, MfaChallenge, MfaChallengeChannel } from '../entities/mfa-challenges';
import type { MfaTotp } from '../entities/mfa-totp';
import type { UserPublicKey } from '../entities/user-public-keys';
import type { User } from '../entities/users';
import type { MfaVerificationMethod } from '../entities/mfa-verifications';
import { stampFor, stampOf } from '../lib/deferred-stamp';
import { provesSecondFactor } from '../lib/passkey-assertion';
import { admitDeferred, deferredRefusalError, startingCredentialOf } from './deferred-admission.service';
import {
    challengeIsLive,
    liveChallenge,
    mintChallenge,
    mintStampedChallenge,
    spendChallenge,
} from './webauthn-challenge.service';
import { isMethodListed } from '../lib/second-factor-policy';
import { accountRefusal, admitPrincipal, sessionCredentialOf, type PrincipalCredential } from './admission.service';
import { SWEEP_BATCH, sweepEachAccount } from './account-sweep.service';
import {
    admitSignIn,
    assertSignInAdmits,
    failedCredentialAnswer,
    recordSignInFailure,
    reportAccountRefusal,
    reportSignIn,
    signInAttempt,
} from './sign-in-guard.service';
import type { SignInAttempt } from '../lib/sign-in-guard';
import {
    assertNotLastListedFactor,
    enrolmentNeedsProof,
    isEnrolledUnderPolicy,
    isEnrolmentOnly,
    secondFactorEnrolmentFields,
} from './second-factor-policy.service';

/** How long an unconfirmed enrolment is left lying around before the sweep takes it. */
export const MFA_UNCONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Does this account have a second factor — of a method the policy lists?
 *
 * One statement (`repositories/mfa-enrolment.repository.ts`), because every
 * sensitive route and every device registration asks it, including the
 * overwhelming majority that will answer false. The policy's reading of it is
 * `isEnrolledUnderPolicy`; with the default methods that is every second
 * factor, as it always was.
 */
export function mfaEnrolledForUser(userId: number): Promise<boolean>
{
    return isEnrolledUnderPolicy(userId);
}

export interface AssertStepUpParams
{
    userId: number;
    /** The credential this request presented (`getAuth(c).credential`) — the window is its window. */
    credential: PrincipalCredential;
    /**
     * A tighter window for this check. Only ever tighter: the window in force is
     * the smaller of this and the configured one, because `auth.mfa.sweep`
     * removes records the configured window has passed
     * (`sweepStaleStepUpsService`) — a longer one would find nothing to honour.
     */
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
 * The one exception is the policy's enrolment-only state (#309): an account
 * that may only enrol, and already holds a credential, proves it before it
 * enrols — see `assertEnrolmentProven`, which this runs for an unenrolled
 * account and which is a no-op unless the policy requires a second factor.
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
        await assertEnrolmentProven(params);

        return;
    }

    await assertWindowOpen(params);
}

/**
 * Refuse creating or marking a second factor in the enrolment-only state until
 * this device proved a credential the account already holds (#309).
 *
 * The proof is an ordinary step-up on this device key — in that state
 * `mfa/step-up` accepts any credential the account holds, listed or not — so
 * the refusal is the one `STEP_UP_REQUIRED` the client already handles. An
 * account holding nothing passes: that is trust on first use, and the
 * registration ceremony itself is its proof. Outside that state, and with no
 * policy, nothing is read but the policy.
 *
 * Called first by every route that creates or marks a factor — through
 * `assertStepUp` where the route already has it, directly where it has none
 * (`passkeys/register/verify`, `mfa/totp/confirm`) — so a refusal writes nothing.
 *
 * @throws StepUpRequiredError
 */
export async function assertEnrolmentProven(params: AssertStepUpParams): Promise<void>
{
    if (await enrolmentNeedsProof(params.userId))
    {
        await assertWindowOpen(params);
    }
}

/** @throws StepUpRequiredError unless this credential verified within the window */
async function assertWindowOpen(params: AssertStepUpParams): Promise<void>
{
    // A grant never steps up, so its window is never open
    const verifier = sessionCredentialOf(params.credential);
    const verification = verifier && await mfaVerificationsRepository.findFor(params.userId, verifier);
    const window = Math.min(params.maxAgeMs ?? Infinity, getMfaConfig().stepUpWindowMs);

    if (verification && Date.now() - verification.verifiedAt.getTime() <= window)
    {
        return;
    }

    throw new StepUpRequiredError();
}

/**
 * Carry a device's verification onto the key that replaces it.
 *
 * Called from one place: `registerPublicKeyService`, for a verified
 * replacement — a `keys/rotate`, a renewal, or a sign-in whose
 * `replacementProof` the old key signed. Never for a key id merely named: the
 * window is the device's, and only the old private key shows it is the same
 * device. Without it the window would expire silently on every rotation, which
 * the web proxy does at each login: a user who stepped up a minute ago would be
 * asked again with nothing to connect it to.
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

    await mfaChallengesRepository.markKeyPending(row);

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

    return await mfaChallengesRepository.resecret(live, hash)
        ? { secret, expiresAtMillis: live.expiresAt.getTime() }
        : null;
}

export interface VerifyMfaChallengeParams
{
    /** The secret from the 202 body, the callback query, or the pending page. */
    challenge: string;
    code?: string;
    recoveryCode?: string;
    /** A passkey assertion as it arrived; `verifyPasskeyProof` reads its shape. */
    response?: unknown;
    /** Client address of this request, from `deviceProvenance` at the route — not the 202's. */
    ip?: string;
    /** `user-agent` of this request, already truncated at the route. */
    userAgent?: string;
    /** Whether proxy-guard recognised the trusted Next.js proxy, from the same helper. */
    webProxy?: boolean;
}

/** A challenge that can still be spent, and its account as read on the primary. */
interface SpendableChallenge
{
    row: MfaChallenge;
    account: User;
}

/**
 * A `mfa/verify` that completes a sign-in, for the app's `signIn` guard: the
 * attempt, at the second-factor stage, and the pending key it would activate.
 */
interface SecondStep
{
    attempt: SignInAttempt;
    keyId: string;
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
 * Every refusal here is the same 401 with the same body, and none of them spends
 * the account's failure budget: a secret that reaches no row, an expired one,
 * one already spent and one from a key generation that has since ended are all
 * states the caller is guessing at, and a guess at a secret is not a proof of
 * the second factor — the budget is for those.
 *
 * The account half of the admission is asked here too, on the primary, before
 * any proof is looked at: an account that is not active spends no recovery
 * code and is charged no failure. The credential half stays where it is, after
 * the activation (`assertSignInAdmitted`). At `mfa/verify` (`verifying`) the
 * account refused is told to the app's `settled` (`reportAccountRefusal`).
 *
 * @throws MfaVerificationFailedError
 */
async function spendableChallenge(challengeHash: string, verifying?: VerifyMfaChallengeParams): Promise<SpendableChallenge>
{
    const row = await mfaChallengesRepository.findByHash(challengeHash);

    if (!row || row.verifiedAt || row.expiresAt.getTime() <= Date.now())
    {
        throw new MfaVerificationFailedError();
    }

    const account = await usersRepository.findByIdOnPrimary(row.userId);

    if (!account || row.keyEpoch !== account.keyEpoch)
    {
        throw new MfaVerificationFailedError();
    }

    const refusal = await accountRefusal(account);

    if (refusal)
    {
        const step = verifying && secondStepOf(row, account, verifying);
        await reportAccountRefusal(step?.attempt ?? null, refusal, row.keyId);

        throw new MfaVerificationFailedError();
    }

    return { row, account };
}

/**
 * Lock the challenge's account (`usersRepository.lockAccount`) and ask again,
 * of that read, what `spendableChallenge` asked before any proof was looked at:
 * the account active, and the challenge of its current key generation. A
 * suspension or a revoke-all that committed while the proof was being checked
 * refuses the activation here; one that arrives later waits for it, and then
 * revokes the key it activated. An account refused here is told to the app's
 * `settled` once the transaction has rolled back (`reportAccountRefusal`).
 *
 * @returns the account as of the lock
 * @throws MfaVerificationFailedError
 */
async function assertAccountStillAdmits(row: MfaChallenge, step: SecondStep | null): Promise<User>
{
    const account = await usersRepository.lockAccount(row.userId);

    if (!account || row.keyEpoch !== account.keyEpoch)
    {
        throw new MfaVerificationFailedError();
    }

    const refusal = await accountRefusal(account);

    if (refusal)
    {
        await reportAccountRefusal(step && { ...step.attempt, user: account }, refusal, row.keyId);

        throw new MfaVerificationFailedError();
    }

    return account;
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
    const { secondFactorEnrolmentRequired } = await secondFactorEnrolmentFields(row.userId);

    onAfterCommit(() => authLoginEvent.emit({
        ...row.loginEvent!,
        userId: String(row.userId),
        mfaEnrolled,
        secondFactorEnrolmentRequired: secondFactorEnrolmentRequired === true,
    }));
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
 * A wrong proof spends the account's failure budget (`checkSecondFactorProof`),
 * not this challenge's: a fresh sign-in mints a fresh challenge, and no fresh
 * tries with it (au2-A2). Nothing is counted on the challenge row.
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
 * With the app's `signIn` guard configured, `admit` is asked before the proof
 * is judged — a refused account is answered `SignInRefusedError`, its
 * challenge unspent and its proof not looked at — and again under the lock
 * in the completion transaction, which decides. A wrong proof and a spent
 * budget are told to `settled` (`stage: 'second-factor'`) in a transaction
 * of their own, after the count committed; the sign-in is told `succeeded`
 * once, here, in the transaction that activates the key.
 *
 * @throws ValidationError when the body names none or more than one proof
 * @throws SecondFactorLockedError while the account's budget is spent
 * @throws SignInRefusedError when the app's `signIn.admit` refuses the sign-in
 * @throws MfaVerificationFailedError for every other refusal, in one body
 */
export async function verifyMfaChallengeService(
    params: VerifyMfaChallengeParams,
): Promise<VerifyMfaChallengeResult>
{
    const challengeHash = hashCredential(params.challenge);
    const { row, account } = await spendableChallenge(challengeHash, params);
    const step = secondStepOf(row, account, params);

    if (step)
    {
        await refuseUnadmittedStep(step);
    }

    const proof = await judgeSecondFactor(row.userId, params, { kind: 'verify' }, step);

    // The transaction starts here and not at the route: a wrong proof's count
    // has to commit before the refusal that raised it (`checkSecondFactorProof`
    // runs outside any transaction for that reason). From here on the spend of
    // the proof, the mark, the activation and the announcements do have to land
    // together, under the account lock, and what `spendableChallenge` read of
    // the account is read again under it.
    return await runInTransaction(async () =>
    {
        const locked = await assertAccountStillAdmits(row, step);

        if (step)
        {
            await assertSignInAdmits({ ...step.attempt, user: locked }, step.keyId);
        }

        if (!await proof.spend() || !await mfaChallengesRepository.markVerified(row))
        {
            throw new MfaVerificationFailedError();
        }

        await mfaChallengesRepository.activateKey(row);
        await assertSignInAdmitted(row);
        await mfaVerificationsRepository.record(row.userId, { kind: 'deviceKey', keyId: row.keyId }, proof.method);

        const result = await settleStepUpLogin(row);

        if (step)
        {
            await reportSignIn({ ...step.attempt, user: locked, result: 'succeeded', keyId: row.keyId });
        }

        return { ...result, keyId: row.keyId, challengeHash };
    }, { context: 'auth:mfa-verify' });
}

/**
 * The sign-in a `mfa/verify` completes, on the channel the 202 came through,
 * from this request; null without the app's `signIn` guard.
 */
function secondStepOf(row: MfaChallenge, account: User, params: VerifyMfaChallengeParams): SecondStep | null
{
    const attempt = signInAttempt(account, row.channel, params, { stage: 'second-factor' });

    return attempt && { attempt, keyId: row.keyId };
}

/**
 * `admit`, asked before the proof is judged. A refusal is reported in a
 * transaction of its own and answered, with the challenge left unspent.
 *
 * @throws SignInRefusedError
 */
async function refuseUnadmittedStep(step: SecondStep): Promise<void>
{
    const refusal = await admitSignIn(step.attempt);

    if (refusal)
    {
        throw await failedCredentialAnswer(step.attempt, refusal, () => new MfaVerificationFailedError(), step.keyId);
    }
}

/**
 * Whether the person whose sign-in this completes may be let in now —
 * `admitPrincipal`, as every door asks it, on the key just activated: the
 * account active on the primary, the key live, the second-factor policy (which
 * a step-up never meets refused: a challenge is opened only for an account
 * enrolled under it).
 *
 * Asked inside the transaction that activated the key, after the activation
 * and before anything is announced, so a refusal rolls the activation back
 * with it: an account suspended while its challenge was open keeps the key
 * inactive, emits no login event and moves no `lastLoginAt`. The challenge
 * stays unspent, and every attempt on it is refused alike. The refusal is this
 * route's one `MfaVerificationFailedError` — the contract enumerates nothing
 * else for `auth.mfa.verify`.
 *
 * @throws MfaVerificationFailedError
 */
async function assertSignInAdmitted(row: MfaChallenge): Promise<void>
{
    const admission = await admitPrincipal({
        userId: row.userId,
        credential: { kind: 'deviceKey', keyId: row.keyId },
        route: null,
        presentedOn: null,
    });

    if ('refused' in admission)
    {
        throw new MfaVerificationFailedError();
    }
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
        ...await secondFactorEnrolmentFields(row.userId),
    };
}

/**
 * Options for finishing a new-device step-up with a passkey.
 *
 * The step-up challenge stands in for the session this caller does not have yet:
 * it is what names the account, so the WebAuthn challenge can be minted for the
 * right owner without the request having to say who that is. `allowCredentials`
 * is empty for the reason it is everywhere else here (D3), and the ceremony kind
 * is `'newDevice'`, which only `mfa/verify` spends: what comes back is neither
 * a sign-in nor a signed-in session's step-up.
 *
 * @throws MfaVerificationFailedError when the challenge cannot be spent
 */
export async function startMfaChallengeAssertionService(
    challenge: string,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    const { row } = await spendableChallenge(hashCredential(challenge));

    return await buildAuthenticationOptions({
        config: getPasskeyConfig(),
        challenge: await mintChallenge('newDevice', row.userId),
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
    const cutoff = new Date();
    const deleted = await sweepEachAccount(
        await mfaChallengesRepository.findAccountsWithFinished(cutoff, SWEEP_BATCH),
        'auth:mfa-sweep-challenges',
        userId => mfaChallengesRepository.sweepFinishedOf(userId, cutoff),
    );

    return { deleted };
}

export interface TotpEnrolmentResult
{
    /** The base32 secret, shown once. Never logged, never returned again. */
    secret: string;
    /** The same secret as the URI an authenticator app scans. */
    otpauthUri: string;
}

/**
 * Mint a secret and park it unconfirmed, stamped with the credential that
 * started it and the account's key generation (`lib/deferred-stamp.ts`).
 *
 * Calling this twice replaces the unconfirmed row, its stamp and its failure
 * counter — a user who closed the app before scanning starts over, which is
 * also the documented remedy for a row that spent its five confirm attempts. A
 * **confirmed** enrolment is refused instead: replacing a working second factor
 * is `disable` followed by a fresh enrolment, both step-up gated, so nobody
 * holding only a stolen session can swap an authenticator for their own.
 *
 * @throws MfaAlreadyEnrolledError when a confirmed enrolment already exists
 */
export async function startTotpEnrolmentService(
    userId: number,
    credential: PrincipalCredential,
): Promise<TotpEnrolmentResult>
{
    const account = await usersRepository.lockAccount(userId);
    const existing = await mfaTotpRepository.findByUserId(userId);

    if (!account)
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    if (existing?.confirmedAt)
    {
        throw new MfaAlreadyEnrolledError();
    }

    const secret = generateTotpSecret();

    await mfaTotpRepository.startEnrolment(userId, encryptMfaSecret(secret, userId), stampFor(account, startingCredentialOf(credential)));

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
    /**
     * The credential this request presented: the one the enrolment was started
     * with, and the one the first verification is recorded for.
     */
    credential: PrincipalCredential;
    code: string;
}

export interface ConfirmTotpResult
{
    /** The ten plaintext codes, shown once. Empty when the policy turned recovery codes off. */
    recoveryCodes: string[];
}

/**
 * Spend the first code, which is what turns an enrolment into a second factor.
 *
 * The code is judged by `checkSecondFactorProof` (`'enrol'`): a wrong one
 * spends the account's failure budget like any other second-factor proof, and
 * the pending secret stays — after five the account accepts no code for
 * fifteen minutes, and then the same enrolment can be confirmed. The route
 * therefore runs this outside a transaction, so a failure's count commits
 * before the refusal; the success path opens its own, because the
 * confirmation, the first verification and the recovery codes have to commit
 * together or not at all.
 *
 * **The decision is made here, at the write, under the account lock**
 * (`assertMayConfirm`): the enrolment's stamp admitted for this credential, and then
 * the factor-adding rule — `assertStepUp` — against the account as it is now.
 * `enroll` asked the same rule of the account as it was then; that is an early
 * refusal only. In the policy's enrolment-only state, an account that already
 * holds a credential is refused early too, before any code is judged
 * (`assertEnrolmentProven`, #309). The confirmation itself is conditional on the
 * row being unconfirmed (`mfaTotpRepository.confirm`): of two confirms with one
 * code, one confirms and issues the recovery codes, and the other is told there
 * is nothing to confirm.
 *
 * @throws StepUpRequiredError | MfaNotEnrolledError | SecondFactorLockedError | MfaVerificationFailedError
 */
export async function confirmTotpEnrolmentService(params: ConfirmTotpParams): Promise<ConfirmTotpResult>
{
    // Early refusal (#309); `assertMayConfirm` below is the decision.
    await assertEnrolmentProven(params);

    const proof = await checkSecondFactorProof(params.userId, { code: params.code }, { kind: 'enrol' });

    // Hashed before the lock: no password hash runs under it.
    const minted = isMethodListed('recoveryCodes') ? await generateRecoveryCodes() : [];

    return await runInTransaction(async () =>
    {
        await assertMayConfirm(await lockedEnrolment(params.userId), params);

        if (!await proof.spend())
        {
            throw new MfaNotEnrolledError();
        }

        await mfaVerificationsRepository.record(params.userId, startingCredentialOf(params.credential), 'totp');

        return { recoveryCodes: await issueRecoveryCodes(params.userId, minted) };
    }, { context: 'auth:mfa-confirm' });
}

/**
 * Lock the account and read its enrolment under the lock, for the stamp the
 * confirmation is admitted by. Whether it is still the unconfirmed enrolment
 * the code was checked against is the confirmation's own condition
 * (`pendingTotpProof`).
 *
 * @throws MfaNotEnrolledError
 */
async function lockedEnrolment(userId: number): Promise<MfaTotp>
{
    await usersRepository.lockAccount(userId);

    const row = await mfaTotpRepository.findByUserId(userId);

    if (!row)
    {
        throw new MfaNotEnrolledError();
    }

    return row;
}

/**
 * Whether this session may turn this enrolment into a second factor now —
 * asked under the account lock, of the row read under it.
 *
 * The enrolment's stamp first (`admitDeferred`): the credential that started
 * it is this request's, still live, of the account's key generation, and the person
 * is admitted now. Another session's enrolment, or one whose key generation
 * has ended, is no enrolment of this session's: `MfaNotEnrolledError`, and
 * `enroll` again. Then the rule for adding a factor, `assertStepUp`, against
 * the account as it is now — an account that enrolled a factor since `enroll`
 * ran is asked for a step-up here, which a session that only holds a stolen
 * cookie cannot give (au7-A1).
 *
 * @throws MfaNotEnrolledError | StepUpRequiredError | the admission's errors
 */
async function assertMayConfirm(pending: MfaTotp, params: ConfirmTotpParams): Promise<void>
{
    const admission = await admitDeferred(stampOf(pending), { credential: params.credential, route: 'mfaTotpConfirm' });

    if ('refused' in admission)
    {
        throw deferredRefusalError(admission.refused, new MfaNotEnrolledError());
    }

    await assertStepUp(params);
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
        onAfterCommit(() => runInTransaction(async () =>
        {
            await usersRepository.lockAccount(userId);
            await mfaTotpRepository.updateSecret(userId, secretEnc, encryptMfaSecret(value, userId));
        }, { context: 'auth:mfa-secret-rotation' }));
    }

    return value;
}

/**
 * Raise the generation and hand out the codes minted for it — hashed by the
 * caller before it took the account lock, which it holds here. None minted
 * (the policy turned them off) writes nothing.
 */
async function issueRecoveryCodes(userId: number, minted: MintedRecoveryCode[]): Promise<string[]>
{
    if (minted.length === 0)
    {
        return [];
    }

    const generation = await mfaRecoveryCodesRepository.currentGeneration(userId) + 1;

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
    const minted = await generateRecoveryCodes();

    await usersRepository.lockAccount(userId);

    if (!await mfaEnrolledForUser(userId))
    {
        throw new MfaNotEnrolledError();
    }

    return { recoveryCodes: await issueRecoveryCodes(userId, minted) };
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
    // A savepoint of the caller's transaction when there is one (the route's,
    // the operator reset's); its own otherwise. The account lock first either way.
    await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);
        await mfaTotpRepository.deleteByUserId(userId);
        await mfaRecoveryCodesRepository.deleteByUserId(userId);
        await mfaVerificationsRepository.deleteByUserId(userId);
        await passkeysRepository.clearSecondFactorByUserId(userId);
    }, { context: 'auth:mfa-disable' });
}

/**
 * The operator's reset: take every second-factor credential off the account,
 * passkeys included, so its owner can enrol again from nothing.
 *
 * `disableMfaService` leaves the passkeys, and under a required policy a live
 * passkey is a credential the account must prove before it enrols — so an
 * owner whose only credential is a lost passkey could never enrol again. This
 * revokes every live passkey, the revocation `passkeys/revoke` performs and
 * each one announced by `auth.passkey.revoked` after commit (`reason:
 * 'operator'`), but without that route's step-up, recent-authentication and
 * last-credential refusals; and it removes the TOTP, the recovery codes, the
 * second-factor marks and the step-up verifications. One transaction, after
 * the owner row's lock. Revoking a passkey ends no session today, here as on
 * the route. Afterwards the account holds nothing, so under a required policy
 * its next sign-in enrols on first use.
 *
 * A service, not a route: the application decides who may call it.
 *
 * It does not touch the password or the account's device keys — the sessions
 * signed in now stay signed in. An operator who suspects the account was taken
 * over also ends them with `revokeAllKeysService({ userId, includeCurrent: true })`.
 *
 * @throws NotFoundError for an account that does not exist
 */
export async function resetSecondFactorService(userId: number): Promise<void>
{
    await runInTransaction(async () =>
    {
        if (!await usersRepository.lockAccount(userId))
        {
            throw new NotFoundError({ message: 'User not found', resource: 'User' });
        }

        const revoked = await passkeysRepository.revokeAllLiveByUserId(userId, 'Revoked by operator');

        await disableMfaService(userId);

        onAfterCommit(() => revoked.forEach(passkey => passkeyRevokedEvent.emit({
            userId: String(userId),
            passkeyId: String(passkey.id),
            reason: 'operator',
        })));
    }, { context: 'auth:mfa-reset' });
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
 * Unmarking the last one is allowed, and leaves the account unenrolled — unless
 * the policy requires a second factor and it is the last listed one
 * (`SecondFactorRequiredError`). It is deliberately independent of
 * `assertNotLastRecoveryCredential`, which guards `passkeys/revoke`: that rule
 * protects a way *into* the account, and a second-factor mark is not one — the
 * credential still signs the owner in afterwards, unchanged.
 *
 * Marking needs a credential whose registration verified the person
 * (`registered_user_verified`): one that only ever showed possession is not a
 * second factor (au7-A4). The condition is the marking statement's own.
 *
 * @throws PasskeyNotFoundError for a credential that is not theirs, or revoked
 * @throws PasskeyUserVerificationRequiredError when marking one registered without user verification
 * @throws SecondFactorRequiredError when unmarking would leave no listed factor under a required policy
 */
export async function markPasskeySecondFactorService(params: MarkPasskeyParams): Promise<MfaStatus>
{
    await usersRepository.lockAccount(params.userId);

    const passkeyId = Number(params.passkeyId);

    if (!params.secondFactor)
    {
        await assertNotLastListedFactor(params.userId, { passkeyId });
    }

    if (await passkeysRepository.markSecondFactorByIdAndUserId(passkeyId, params.userId, params.secondFactor))
    {
        return await mfaStatusService(params.userId);
    }

    throw await passkeysRepository.findLiveByIdAndUserId(passkeyId, params.userId)
        ? new PasskeyUserVerificationRequiredError()
        : new PasskeyNotFoundError();
}

/** What the account surface shows about the second factor. No secret is in it. */
export interface MfaStatus
{
    /** Whether a listed method is live — the policy's reading of enrolled. */
    enrolled: boolean;
    /** Which listed second factors are live: `'totp'`, `'passkey'`, or both. */
    methods: ('totp' | 'passkey')[];
    /** Unspent codes of the current generation, for the "2 left" warning. 0 while the policy turned them off. */
    recoveryCodesRemaining: number;
}

/**
 * The account's second-factor state.
 *
 * Carries no secret, no otpauth URI and no recovery code — only the counts and
 * names an account screen needs. An unconfirmed enrolment is not a method: it
 * gates nothing, so reporting it would tell the owner they are protected when
 * they are not. A method the policy does not list is not reported either, for
 * the same reason: it is not accepted as a proof.
 */
export async function mfaStatusService(userId: number): Promise<MfaStatus>
{
    const methods: ('totp' | 'passkey')[] = [];

    if (isMethodListed('totp') && (await mfaTotpRepository.findByUserId(userId))?.confirmedAt)
    {
        methods.push('totp');
    }

    if (isMethodListed('passkey') && await mfaEnrolmentRepository.hasSecondFactorPasskey(userId))
    {
        methods.push('passkey');
    }

    return {
        enrolled: methods.length > 0,
        methods,
        recoveryCodesRemaining: isMethodListed('recoveryCodes') ? await unusedRecoveryCodes(userId) : 0,
    };
}

async function unusedRecoveryCodes(userId: number): Promise<number>
{
    const generation = await mfaRecoveryCodesRepository.currentGeneration(userId);

    return generation === 0 ? 0 : await mfaRecoveryCodesRepository.countUnused(userId, generation);
}

/**
 * Options for a step-up by passkey assertion.
 *
 * `allowCredentials` is empty, as it is for a sign-in and for the same reason
 * (D3): the discoverable credential on the device names itself, and the owner
 * and the second-factor mark are checked when the assertion comes back. The
 * challenge is minted with kind `'stepUp'` and this account's id, which only a
 * step-up spends — not `passkeys/login/verify`, not a new-device `mfa/verify` —
 * and a step-up spends no other kind. It is stamped with this request's
 * credential and the account's key generation (`lib/deferred-stamp.ts`): the
 * window it opens is this session's, so only this session, in this
 * generation, can spend it.
 */
export async function startStepUpService(
    userId: number,
    credential: PrincipalCredential,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    const account = await usersRepository.findByIdOnPrimary(userId);

    if (!account)
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    return await buildAuthenticationOptions({
        config: getPasskeyConfig(),
        challenge: await mintStampedChallenge('stepUp', stampFor(account, startingCredentialOf(credential))),
    });
}

/** The proof a body presents: exactly one of the three. */
export interface PresentedSecondFactor
{
    code?: string;
    recoveryCode?: string;
    /** A passkey assertion as it arrived; `verifyPasskeyProof` reads its shape. */
    response?: unknown;
}

export interface StepUpParams extends PresentedSecondFactor
{
    userId: number;
    /**
     * The credential this request presented (`getAuth(c).credential`): the
     * verification is recorded for it, and a passkey assertion's `'stepUp'`
     * challenge was asked for with it, and is spent only with it.
     */
    credential: PrincipalCredential;
}

/**
 * What a second-factor proof is for, which decides what it is checked against:
 *
 * - `'verify'` — a new-device sign-in (`mfa/verify`): the listed methods, a
 *   passkey over a `'newDevice'` challenge;
 * - `'stepUp'` — a signed-in credential's step-up (`mfa/step-up`): the listed
 *   methods, or in the enrolment-only state any credential the account holds
 *   (#309), a passkey over a `'stepUp'` challenge stamped with that credential;
 * - `'enrol'` — the first code of a TOTP enrolment (`mfa/totp/confirm`), against
 *   the unconfirmed secret.
 */
export type SecondFactorPurpose =
    | { kind: 'verify' }
    | { kind: 'stepUp'; credential: PrincipalCredential }
    | { kind: 'enrol' };

/**
 * The procedure a passkey proof completes, which is the one challenge kind it
 * is checked against: a signed-in session's step-up, held to its stamp, or a
 * new-device sign-in, whose challenge handle already names its pending key.
 */
type PasskeyCeremony =
    | { kind: 'stepUp'; credential: PrincipalCredential }
    | { kind: 'newDevice' };

/**
 * Re-prove the second factor on this credential, refreshing its window.
 *
 * The escape hatch the exempt registration channels need: a device-code
 * approval and a passkey sign-in register a key with no verification against
 * it, by design, so the session they create would otherwise fail every
 * sensitive change with no way forward.
 *
 * In the policy's enrolment-only state (#309) it is also how an account proves
 * a credential it already holds before it may enrol: there, and only there, it
 * accepts any of them. Once the account is enrolled, an unlisted proof is
 * refused again as it is everywhere.
 *
 * Runs outside a transaction (the route has none): a wrong proof's count must
 * commit before the refusal. The spend and the record open their own.
 *
 * @throws ValidationError when the body names none or more than one input
 * @throws MfaNotEnrolledError | SecondFactorLockedError | MfaVerificationFailedError
 */
export async function stepUpService(params: StepUpParams): Promise<void>
{
    if (!await isEnrolmentOnly(params.userId) && !await mfaEnrolledForUser(params.userId))
    {
        throw new MfaNotEnrolledError();
    }

    const proof = await checkSecondFactorProof(params.userId, params, { kind: 'stepUp', credential: params.credential });

    await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(params.userId);

        if (!await proof.spend())
        {
            throw new MfaVerificationFailedError();
        }

        await mfaVerificationsRepository.record(params.userId, startingCredentialOf(params.credential), proof.method);
    }, { context: 'auth:mfa-step-up' });
}

/** Which proofs a check accepts, and which of the account's passkeys count. */
interface AcceptedProofs
{
    totp: boolean;
    recoveryCodes: boolean;
    /** Marked passkeys only, every live one, or none. */
    passkeys: 'marked' | 'live' | null;
}

/** What proves a second factor: the listed methods only. */
function listedProofs(): AcceptedProofs
{
    return {
        totp: isMethodListed('totp'),
        recoveryCodes: isMethodListed('recoveryCodes'),
        passkeys: isMethodListed('passkey') ? 'marked' : null,
    };
}

/**
 * What proves a credential the account holds, in the enrolment-only state: any
 * live passkey and a confirmed TOTP whatever is listed, and recovery codes only
 * while they exist at all.
 */
function heldProofs(): AcceptedProofs
{
    return { totp: true, recoveryCodes: isMethodListed('recoveryCodes'), passkeys: 'live' };
}

/**
 * A second-factor proof that checked out, not yet spent.
 *
 * `spend` runs under the account lock, in the caller's transaction: it asks
 * the failure budget again under the lock, then spends the proof with a
 * statement conditional on what the check read — the step newer than the last
 * spent, the code unused and of the newest generation, the enrolment
 * unconfirmed, the WebAuthn challenge unspent and the passkey live at the
 * counter verified against. False when the proof went stale since.
 */
export interface SecondFactorProof
{
    method: MfaVerificationMethod;
    /** @throws SecondFactorLockedError when the budget ran out since the check */
    spend: () => Promise<boolean>;
}

/**
 * Judge one second-factor proof — the only place a TOTP code, a recovery code
 * or a second-factor passkey assertion is judged. `mfa/verify`, `mfa/step-up`
 * and `mfa/totp/confirm` call it; an app route that takes such a proof calls it
 * too, then spends the answer under the account lock.
 *
 * In this order:
 *
 * 1. the account's failure budget: past it, no proof is accepted, right or
 *    wrong — `SecondFactorLockedError` (429, `Retry-After`);
 * 2. the proof, outside the account lock — a bcrypt comparison, a signature
 *    check. Exactly one of the three inputs, or a `ValidationError`. A method
 *    the policy does not list, a code that is not six ASCII digits, a passkey
 *    without user verification: each is a wrong proof like any other;
 * 3. a wrong proof spends the budget (`refuseProof`) and is answered
 *    `MfaVerificationFailedError`.
 *
 * Must run outside any transaction: the failure it counts has to commit before
 * its refusal, which would roll back a transaction around it — and a count
 * that rolls back is a free guess.
 *
 * @throws ValidationError | SecondFactorLockedError | MfaVerificationFailedError
 */
export async function checkSecondFactorProof(
    userId: number,
    proof: PresentedSecondFactor,
    purpose: SecondFactorPurpose,
): Promise<SecondFactorProof>
{
    return await judgeSecondFactor(userId, proof, purpose, null);
}

/**
 * `checkSecondFactorProof`, and for `mfa/verify` the sign-in it completes:
 * with one, a spent budget and a wrong proof are told to the app's `settled`
 * — a step-up's or an enrolment's never are, a signed-in person's typo is not
 * a sign-in.
 */
async function judgeSecondFactor(
    userId: number,
    proof: PresentedSecondFactor,
    purpose: SecondFactorPurpose,
    step: SecondStep | null,
): Promise<SecondFactorProof>
{
    assertOutsideTransaction();
    assertExactlyOneProof(proof, purpose);
    await assertBudgetOpen(userId, step);

    const checked = await judgeProof(userId, proof, purpose);

    if (!checked)
    {
        return await refuseProof(userId, step);
    }

    return {
        method: checked.method,
        spend: async () =>
        {
            await assertBudgetOpen(userId);

            return await checked.spend();
        },
    };
}

/** @throws Error when a caller holds a transaction a counted failure would roll back with */
function assertOutsideTransaction(): void
{
    if (getTransactionContext())
    {
        throw new Error('checkSecondFactorProof ran inside a transaction: the failure it counts would roll back '
            + 'with the refusal. Call it before opening one, and spend the proof in your own.');
    }
}

/**
 * Exactly one proof, of a kind the purpose takes. Two inputs in a body is a
 * caller trying combinations, and none is a malformed request; neither is a
 * failed verification, so both are a 400 rather than the counted 401.
 *
 * @throws ValidationError
 */
function assertExactlyOneProof(proof: PresentedSecondFactor, purpose: SecondFactorPurpose): void
{
    const presented = [proof.code, proof.recoveryCode, proof.response].filter(value => value !== undefined);

    if (presented.length !== 1 || (purpose.kind === 'enrol' && proof.code === undefined))
    {
        throw new ValidationError({
            message: purpose.kind === 'enrol'
                ? 'Send the code from the authenticator app.'
                : 'Send exactly one of code, recoveryCode or response.',
        });
    }
}

/**
 * A spent budget at a sign-in's second step is told to `settled` first, in a
 * transaction of its own, and answered the app's refusal when `admit` now
 * refuses.
 *
 * @throws SecondFactorLockedError | SignInRefusedError while the account's budget is spent
 */
async function assertBudgetOpen(userId: number, step: SecondStep | null = null): Promise<void>
{
    const lockedUntil = await mfaAttemptBudgetsRepository.lockedUntil(userId);

    if (!lockedUntil)
    {
        return;
    }

    const refusal = step && await recordSignInFailure(step.attempt, 'secondFactorLocked', step.keyId);

    throw refusal
        ? new SignInRefusedError({ code: refusal.code })
        : new SecondFactorLockedError({ retryAfter: Math.ceil((lockedUntil.getTime() - Date.now()) / 1000) });
}

/**
 * Refuse a wrong proof: count it (`countFailure`), and at a sign-in's second
 * step tell the app's `settled` and ask `admit` again (`recordSignInFailure`)
 * — in a transaction of its own, after the count committed. The count is the
 * package's: an app callback that throws answers 500 and leaves it, and the
 * lock it reached, in force.
 *
 * @throws SecondFactorLockedError | SignInRefusedError | MfaVerificationFailedError, always
 */
async function refuseProof(userId: number, step: SecondStep | null): Promise<never>
{
    const counted = await countFailure(userId);
    const refusal = step && await recordSignInFailure(step.attempt, 'secondFactor', step.keyId);

    if (refusal)
    {
        throw new SignInRefusedError({ code: refusal.code });
    }

    if (!counted)
    {
        await assertBudgetOpen(userId);
    }

    throw new MfaVerificationFailedError();
}

/**
 * Count a wrong proof against the account, in a transaction of its own under
 * the account lock, committed before the refusal. The count that reaches the
 * limit — one statement, so exactly one — announces the lock after commit
 * (`auth.mfa.locked`), for the app to tell the owner.
 *
 * @returns false when the account locked meanwhile and the count was refused
 */
async function countFailure(userId: number): Promise<boolean>
{
    return await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);

        const failure = await mfaAttemptBudgetsRepository.spendFailure(userId);
        const lockedUntil = failure?.lockedUntil;

        if (lockedUntil)
        {
            authLogger.service.warn('Second factor locked after repeated wrong proofs', { userId });
            onAfterCommit(() => mfaLockedEvent.emit({ userId: String(userId), lockedUntil: lockedUntil.toISOString() }));
        }

        return failure !== null;
    }, { context: 'auth:mfa-failure' });
}

/**
 * Step 2 of `checkSecondFactorProof`: whether the proof holds, read and
 * verified without the account lock.
 *
 * @returns the proof to spend, or null when it does not verify
 */
async function judgeProof(
    userId: number,
    proof: PresentedSecondFactor,
    purpose: SecondFactorPurpose,
): Promise<SecondFactorProof | null>
{
    if (purpose.kind === 'enrol')
    {
        return await verifyPendingTotpProof(userId, proof.code!);
    }

    const accepts = purpose.kind === 'stepUp' && await isEnrolmentOnly(userId) ? heldProofs() : listedProofs();

    if (proof.code !== undefined)
    {
        return accepts.totp ? await verifyTotpProof(userId, proof.code) : null;
    }

    if (proof.recoveryCode !== undefined)
    {
        return accepts.recoveryCodes ? await verifyRecoveryProof(userId, proof.recoveryCode) : null;
    }

    const ceremony: PasskeyCeremony = purpose.kind === 'stepUp' ? purpose : { kind: 'newDevice' };

    return accepts.passkeys === null
        ? null
        : await verifyPasskeyProof(userId, proof.response!, accepts.passkeys, ceremony);
}

/**
 * A code from the authenticator app.
 *
 * The step it belongs to is written back, and the write is conditional on the
 * enrolment being the one the code was verified against and the step being
 * newer than the last one spent (`recordUsedStep`), so the same code
 * presented again inside its own 30 seconds — or by four requests at once — is
 * spent once. That includes a second device signing in during the same step,
 * the one legitimate case this costs; the client retries on the next step.
 *
 * @returns null when the code does not verify
 */
async function verifyTotpProof(userId: number, code: string): Promise<SecondFactorProof | null>
{
    const row = await mfaTotpRepository.findByUserId(userId);

    if (!row?.confirmedAt)
    {
        return null;
    }

    const step = verifyTotp({ secret: readSecret(row.secretEnc, userId), code });

    return step === null
        ? null
        : { method: 'totp', spend: () => mfaTotpRepository.recordUsedStep(userId, row.id, step) };
}

/**
 * The first code of an unconfirmed enrolment. Spending it confirms the
 * enrolment — only while it is still the one the code was checked against
 * (its row id; a re-encryption leaves that alone, a fresh `enroll` does not)
 * and still unconfirmed, the conditions of the confirming statement.
 *
 * @returns null when there is no unconfirmed enrolment or the code does not verify
 */
async function verifyPendingTotpProof(userId: number, code: string): Promise<SecondFactorProof | null>
{
    const row = await mfaTotpRepository.findByUserId(userId);

    if (!row || row.confirmedAt)
    {
        throw new MfaNotEnrolledError();
    }

    const step = verifyTotp({ secret: readSecret(row.secretEnc, userId), code });

    return step === null
        ? null
        : { method: 'totp', spend: () => mfaTotpRepository.confirm(userId, row.id, step) };
}

/**
 * One of the ten written-down codes.
 *
 * Scoped to this account and its current generation, so a spent code, a code
 * from before the last regeneration and somebody else's code are all outside
 * the query rather than distinguished by it. The spend is a conditional UPDATE
 * (`used_at IS NULL`, newest generation), so two requests carrying the same
 * code produce one winner.
 *
 * @returns null when the code does not verify
 */
async function verifyRecoveryProof(userId: number, submitted: string): Promise<SecondFactorProof | null>
{
    const generation = await mfaRecoveryCodesRepository.currentGeneration(userId);
    const candidates = generation === 0 ? [] : await mfaRecoveryCodesRepository.listUnused(userId, generation);

    for (const candidate of candidates)
    {
        if (await matchesRecoveryCode(submitted, candidate.codeHash))
        {
            return { method: 'recovery', spend: () => mfaRecoveryCodesRepository.consume(userId, candidate.id) };
        }
    }

    return null;
}

/**
 * An assertion from a passkey of this account that proves a second factor
 * (`provesSecondFactor`): with user verification, always, and from a passkey
 * the owner marked — or, with `'live'`, from any live passkey of theirs.
 *
 * A passkey they never marked, and an assertion without user verification, are
 * refused with the same body as a wrong code: the surface must not say which of
 * the two is missing. `'live'` is the enrolment-only state's step-up, where
 * proving a passkey the account holds is the point. Another account's passkey
 * is never among the candidates.
 *
 * The presented value is read first (`parseAssertion`), and one that is no
 * assertion is a wrong proof too — refused and counted by the same branch as a
 * bad signature, never a 500 that escapes the count.
 *
 * @returns null when the assertion does not prove a second factor
 */
async function verifyPasskeyProof(
    userId: number,
    presented: unknown,
    candidates: 'marked' | 'live',
    ceremony: PasskeyCeremony,
): Promise<SecondFactorProof | null>
{
    const assertion = parseAssertion(presented);

    return assertion && await verifyAssertionProof(userId, assertion, candidates, ceremony);
}

async function verifyAssertionProof(
    userId: number,
    assertion: PresentedResponse<AuthenticationResponseJSON>,
    candidates: 'marked' | 'live',
    ceremony: PasskeyCeremony,
): Promise<SecondFactorProof | null>
{
    const { challenge } = assertion;
    const passkey = await challengeIsLive(challenge, ceremony.kind, userId)
        ? (await passkeysRepository.listLiveByUserId(userId)).find(row => row.credentialId === assertion.credentialId)
        : undefined;
    const outcome = passkey && await verifyAuthentication({
        config: getPasskeyConfig(),
        response: assertion.response,
        expectedChallenge: challenge,
        credential: passkey,
    });

    if (!passkey || !outcome?.verified || !provesSecondFactor({
        credentialId: passkey.credentialId,
        userVerified: outcome.userVerified,
        markedSecondFactor: passkey.secondFactor,
    }, candidates))
    {
        return null;
    }

    return {
        method: 'passkey',
        spend: async () => await spendCeremonyChallenge(ceremony, challenge, userId)
            && await passkeysRepository.recordUse(passkey, outcome.newCounter),
    };
}

/**
 * Under the account lock: spend a passkey proof's challenge, of its ceremony's
 * kind. A `'stepUp'` challenge is stamped (`lib/deferred-stamp.ts`), and only
 * the session that asked for it, still admitted and in its key generation,
 * spends it; one without a stamp was minted before the upgrade and is
 * refused. A `'newDevice'` challenge names no session — its sign-in's
 * `mfa_challenges` row carries the key and generation, and `mfa/verify` asks
 * them.
 */
async function spendCeremonyChallenge(ceremony: PasskeyCeremony, challenge: string, userId: number): Promise<boolean>
{
    if (ceremony.kind === 'stepUp' && !await stepUpChallengeAdmits(challenge, userId, ceremony.credential))
    {
        return false;
    }

    return await spendChallenge(challenge, ceremony.kind, userId);
}

async function stepUpChallengeAdmits(challenge: string, userId: number, credential: PrincipalCredential): Promise<boolean>
{
    const row = await liveChallenge(challenge, 'stepUp', userId);
    const admission = await admitDeferred(row && stampOf(row), { credential, route: 'mfaStepUp' });

    return !('refused' in admission);
}

/**
 * Drop step-up records the configured window has passed, of every credential.
 *
 * Such a record grants nothing (`assertWindowOpen`). A device key's goes with
 * its key row anyway; an application profile's has no row to go with, so
 * without this every profile key that ever stepped up would stay for good.
 *
 * @returns number of records deleted
 */
export async function sweepStaleStepUpsService(): Promise<{ deleted: number }>
{
    const cutoff = new Date(Date.now() - getMfaConfig().stepUpWindowMs);
    const deleted = await sweepEachAccount(
        await mfaVerificationsRepository.findAccountsVerifiedBefore(cutoff, SWEEP_BATCH),
        'auth:mfa-sweep-step-ups',
        userId => mfaVerificationsRepository.deleteVerifiedBeforeOf(userId, cutoff),
    );

    return { deleted };
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
    const deleted = await sweepEachAccount(
        await mfaTotpRepository.findAccountsUnconfirmedBefore(cutoff, SWEEP_BATCH),
        'auth:mfa-sweep-unconfirmed',
        userId => mfaTotpRepository.deleteUnconfirmedOf(userId, cutoff),
    );

    return { deleted };
}
