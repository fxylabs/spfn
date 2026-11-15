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
 * Revoking the last thing an account can sign in with is refused (D6) rather
 * than warned about, because that state has no undo. A verified email address
 * counts as one of those things: the password reset flow can always give such an
 * account a password back.
 */

import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import { ValidationError } from '@spfn/core/errors';
import {
    LastRecoveryCredentialError,
    PasskeyAlreadyRegisteredError,
    PasskeyChallengeError,
    PasskeyNotFoundError,
    PasskeyVerificationError,
    RecentAuthenticationRequiredError,
} from '@spfn/auth/errors';
import { authLogger } from '../logger';
import { getPasskeyConfig, isSignInProvider } from '../lib/config';
import {
    challengeIsLive,
    liveChallenge,
    mintChallenge,
    mintStampedChallenge,
    presentedChallenge,
    spendChallenge,
} from './webauthn-challenge.service';
import { stampFor, stampOf, type DeferredStamp } from '../lib/deferred-stamp';
import { admitDeferred, deferredRefusalError, startingCredentialOf } from './deferred-admission.service';
import type { PrincipalCredential } from './admission.service';
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
} from '../repositories';
import type { Passkey, PasskeyDeviceType } from '../entities/passkeys';
import type { WebAuthnChallenge, WebAuthnChallengeKind } from '../entities/webauthn-challenges';
import type { User } from '../entities/users';
import { getDummyPasswordHash, verifyPassword } from '../helpers';
import type { KeyAlgorithmType, KeyPlatformType } from '../types';
import { registerPublicKeyService } from './key.service';
import { assertEnrolmentProven, assertStepUp, mfaEnrolledForUser, mfaStatusService, type MfaStatus } from './mfa.service';
import { assertNotLastListedFactor, isEnrolmentOnly, secondFactorEnrolmentFields } from './second-factor-policy.service';
import { isMethodListed } from '../lib/second-factor-policy';
import { decideKeyBinding } from '../lib/key-policy';
import { updateLastLoginService } from './user.service';
import { accountRefusal, admissionRefusalError } from './admission.service';
import { authLoginEvent, passkeyEnrolledEvent, passkeyRevokedEvent } from '../events';
import { loginBindingFields, type LoginResult } from './auth.service';

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
 * Refuse the ceremony when its challenge was not live to read
 * (`challengeIsLive`) or not there to spend under the lock (`spendChallenge`).
 *
 * @throws PasskeyChallengeError
 */
function assertChallenge(held: boolean, kind: WebAuthnChallengeKind): void
{
    if (held)
    {
        return;
    }

    authLogger.service.warn('Passkey challenge refused', { kind });

    throw new PasskeyChallengeError();
}

export interface RecentAuthenticationParams
{
    userId: number;
    /** The device key this request is signed with — when it last proved a credential is the signal. */
    keyId: string;
    currentPassword?: string;
}

/**
 * Refuse a passkey change unless the caller has recently proved themselves (D4).
 *
 * Two ways to satisfy it. A person proved a credential on the device key this
 * request is signed with within the window — its `authenticatedAt`, which a
 * sign-in sets and a `keys/rotate` only inherits. Not `createdAt`: a rotation
 * writes a new row without anybody proving anything, so a stale session could
 * rotate its way past this gate. Or the body carries the account password.
 *
 * A password in the body is the proof offered, and it is judged: a wrong one
 * is refused even on a device that signed in a moment ago. Either suffices
 * when it is what the person offers; a proof presented and failed is a failed
 * proof, not an absent one.
 *
 * An account with no password stored cannot satisfy it with a password, however
 * plausible the value (E5): the comparison still runs, against a dummy hash, so
 * "no password on file" costs exactly what "wrong password" costs. Skipping it
 * would turn response time into an oracle for which accounts are OAuth-only.
 *
 * @param windowMs - The window to hold the key's `authenticatedAt` to. Omitted, it is the
 *                   passkey window; a provider link passes its own (#155), so
 *                   that path never resolves the passkey configuration.
 * @returns which of the two satisfied it
 * @throws RecentAuthenticationRequiredError
 */
export async function assertRecentAuthentication(
    params: RecentAuthenticationParams,
    windowMs?: number,
): Promise<'key' | 'password'>
{
    return (await proveRecentAuthentication(params, windowMs)).by;
}

/** What satisfied recent authentication: the key's own sign-in, or the password and the hash it was verified against. */
export type RecentAuthenticationProof = { by: 'key' } | { by: 'password'; verifiedHash: string };

/**
 * `assertRecentAuthentication`, answering with what satisfied it, for a caller
 * that confirms the proof again under the account lock
 * (`recentAuthenticationHolds`). The stored hash is read on the primary: it is
 * compared there with what the lock reads.
 *
 * @throws RecentAuthenticationRequiredError
 */
export async function proveRecentAuthentication(
    params: RecentAuthenticationParams,
    windowMs?: number,
): Promise<RecentAuthenticationProof>
{
    if (!params.currentPassword && await keyRecentlyAuthenticated(params, windowMs))
    {
        return { by: 'key' };
    }

    const storedHash = (await usersRepository.findByIdOnPrimary(params.userId))?.passwordHash;
    const matched = await verifyPassword(
        params.currentPassword || NO_PASSWORD_PRESENTED,
        storedHash ?? await getDummyPasswordHash(),
    );

    if (storedHash && matched)
    {
        return { by: 'password', verifiedHash: storedHash };
    }

    throw new RecentAuthenticationRequiredError();
}

/**
 * Whether a proof from `proveRecentAuthentication` still holds, asked under the
 * account lock with the row the lock read: the key's sign-in still inside the
 * window, or the hash the password was verified against still the one stored.
 * Nothing hashes here.
 *
 * @returns false when the stored hash moved since it was verified — the proof
 *   is stale, not wrong: the caller verifies again outside the lock
 * @throws RecentAuthenticationRequiredError when the key's window closed meanwhile
 */
export async function recentAuthenticationHolds(
    params: RecentAuthenticationParams,
    proof: RecentAuthenticationProof,
    account: Pick<User, 'passwordHash'>,
    windowMs?: number,
): Promise<boolean>
{
    if (proof.by === 'password')
    {
        return account.passwordHash === proof.verifiedHash;
    }

    if (!await keyRecentlyAuthenticated(params, windowMs))
    {
        throw new RecentAuthenticationRequiredError();
    }

    return true;
}

/**
 * Recent authentication as a registration's completion asks it, under the
 * account lock and with no password in the body: a person proved a credential
 * on this device key within the passkey window, or answered this ceremony's
 * options with the account password within it (`passwordProvenAt` on its
 * challenge). The password proof is the procedure's own — no other route
 * reads it, and the key's `authenticatedAt` never learns of it.
 *
 * @throws RecentAuthenticationRequiredError
 */
async function assertRegistrationRecentlyAuthenticated(
    params: RecentAuthenticationParams,
    challenge: WebAuthnChallenge,
): Promise<void>
{
    const provenAt = challenge.passwordProvenAt;

    if (provenAt !== null && Date.now() - provenAt.getTime() <= getPasskeyConfig().recentAuthMs)
    {
        return;
    }

    if (!await keyRecentlyAuthenticated(params))
    {
        throw new RecentAuthenticationRequiredError();
    }
}

async function keyRecentlyAuthenticated(params: RecentAuthenticationParams, windowMs?: number): Promise<boolean>
{
    const key = await keysRepository.findByKeyIdAndUserId(params.keyId, params.userId);

    return key !== null && Date.now() - key.authenticatedAt.getTime() <= (windowMs ?? getPasskeyConfig().recentAuthMs);
}

/** The credential a removal takes away: one passkey, or one linked social account (#154). */
export type RemovedCredential = 'passkey' | 'social';

/**
 * Refuse to remove the only thing an account can sign in with (D6).
 *
 * The recovery paths are: a live passkey, a password, a linked social account,
 * and a verified email address. The last one is new — a password reset now
 * exists in this package, and an account that can be reset by email can always
 * get a password back, so the refusal has nothing left to protect.
 *
 * `removing` names the one being taken away, which is not counted: removing a
 * passkey needs another live passkey, and unlinking a social account needs
 * another social account. A social account of a link-only provider (#157) is
 * never counted, since nobody can sign in with it. What remains refused is the account with none of the
 * four left — a phone-only account among them. Nobody, support included, could
 * undo that state.
 *
 * @throws LastRecoveryCredentialError
 */
export async function assertNotLastRecoveryCredential(
    userId: number,
    removing: RemovedCredential = 'passkey',
): Promise<void>
{
    const live = await passkeysRepository.listLiveByUserId(userId);

    if (live.length > (removing === 'passkey' ? 1 : 0))
    {
        return;
    }

    const user = await usersRepository.findById(userId);

    if (user?.passwordHash)
    {
        return;
    }

    if (user?.emailVerifiedAt)
    {
        return;
    }

    // A link-only provider's identity (#157) is no way in, so it does not count.
    const socialAccounts = (await socialAccountsRepository.findByUserId(userId))
        .filter(account => isSignInProvider(account.provider));

    if (socialAccounts.length > (removing === 'social' ? 1 : 0))
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
    /** The credential this request presented (`getAuth(c).credential`): the ceremony is stamped with it. */
    credential: PrincipalCredential;
    currentPassword?: string;
}

/**
 * Step 1 of enrollment — options for `navigator.credentials.create()`.
 *
 * An enrolled account steps up first, and every account then meets the
 * recent-authentication rule this route has always had (#95). The order is what
 * makes the two independent: `assertStepUp` is a no-op for an unenrolled
 * account, so the answer such a caller gets is byte-for-byte today's.
 *
 * Both are early refusals: the verify asks them again of the account as it is
 * then, and that is the decision. The challenge is stamped with this request's
 * credential and the account's key generation (`lib/deferred-stamp.ts`), so
 * only this session, in this generation, can complete it. A password given
 * here is recorded on the challenge, for this ceremony's verify alone
 * (`assertRegistrationRecentlyAuthenticated`).
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
    await assertStepUp(params);

    const passwordProvenAt = await assertRecentAuthentication(params) === 'password' ? new Date() : null;
    const user = await usersRepository.findByIdOnPrimary(params.userId);

    if (!user)
    {
        throw new PasskeyNotFoundError();
    }

    const live = await passkeysRepository.listLiveByUserId(params.userId);

    return await buildRegistrationOptions({
        config: getPasskeyConfig(),
        challenge: await mintStampedChallenge(
            'registration',
            stampFor(user, startingCredentialOf(params.credential)),
            passwordProvenAt,
        ),
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
    /** The device key this request is signed with — its step-up window is the enrolment proof (#309). */
    keyId: string;
    /** The credential this request presented: the one the options were asked with. */
    credential: PrincipalCredential;
    response: RegistrationResponseJSON;
    label?: string;
}

export interface FinishPasskeyEnrollmentResult
{
    passkeyId: string;
    label: string | null;
    createdAt: string;
    /**
     * The account's second-factor state, present only when this registration
     * also marked the passkey as its second factor — in the policy's
     * enrolment-only state (#309). Absent otherwise, so the answer without a
     * policy is the one it always was.
     */
    mfaStatus?: MfaStatus;
}

/**
 * Step 2 of enrollment — verify the attestation and keep the credential.
 *
 * Runs under `Transactional()`. The challenge is read, the attestation
 * verified, and then — under the account lock — the challenge is spent and the
 * row written together: a failure after the spend, the lock's own
 * `AccountBusyError` included, leaves the challenge live and the ceremony
 * retryable, while a success can never be replayed.
 *
 * In the policy's enrolment-only state (#309) with `'passkey'` listed, the new
 * passkey is marked as the second factor in the same transaction: the ceremony
 * with user verification is the proof, and the session is ordinary on its next
 * request. An account that already held a credential reaches this only from a
 * device that proved it (`assertEnrolmentProven`). With no policy, or outside
 * that state, nothing is marked.
 *
 * **The decision is made here, under the account lock** (`assertMayRegister`):
 * the challenge's stamp admitted for this key, then step-up and recent
 * authentication against the account as it is now — not as it was when the
 * options were asked for (au7-A3).
 *
 * @throws StepUpRequiredError | RecentAuthenticationRequiredError | PasskeyChallengeError
 *   | PasskeyVerificationError | PasskeyAlreadyRegisteredError
 */
export async function finishPasskeyEnrollmentService(
    params: FinishPasskeyEnrollmentParams,
): Promise<FinishPasskeyEnrollmentResult>
{
    // Early refusal (#309), before the attestation is verified; `assertMayRegister` is the decision.
    await assertEnrolmentProven(params);

    const challenge = presentedChallenge(params.response.response.clientDataJSON);

    assertChallenge(await challengeIsLive(challenge, 'registration', params.userId), 'registration');

    const verified = await verifyRegistration({
        config: getPasskeyConfig(),
        response: params.response,
        expectedChallenge: challenge,
    });

    if (!verified)
    {
        throw new PasskeyVerificationError();
    }

    // The attestation verified, the account is locked before the challenge is
    // spent and the row written: an operator's `resetSecondFactorService`
    // either lands first and this enrols after it, or waits and revokes what
    // this enrolled.
    await usersRepository.lockAccount(params.userId);
    await assertMayRegister(challenge, params);
    assertChallenge(await spendChallenge(challenge, 'registration', params.userId), 'registration');

    // Global, and over revoked rows too: a credential id is reserved for good
    // once used, so this is also what refuses re-enrolling one's own revoked
    // passkey (D5). The unique constraint would catch a race here; this makes
    // the ordinary case a 409 rather than a database error.
    if (await passkeysRepository.existsByCredentialId(verified.credentialId))
    {
        throw new PasskeyAlreadyRegisteredError();
    }

    const marksFactor = isMethodListed('passkey') && await isEnrolmentOnly(params.userId);
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
        secondFactor: marksFactor,
    });

    onAfterCommit(() => passkeyEnrolledEvent.emit({
        userId: String(params.userId),
        passkeyId: String(row.id),
        label: row.label ?? undefined,
    }));

    const enrolled = { passkeyId: String(row.id), label: row.label, createdAt: row.createdAt.toISOString() };

    return marksFactor ? { ...enrolled, mfaStatus: await mfaStatusService(params.userId) } : enrolled;
}

/**
 * Whether this session may add a passkey now — asked under the account lock,
 * of the challenge read under it.
 *
 * The challenge's stamp first (`admitDeferred`): the credential that asked for
 * the options is this request's, still live, of the account's key generation,
 * and the person is admitted now. Anything else is a challenge this session
 * may not spend — `PasskeyChallengeError`, the one answer for every unusable
 * challenge. Then the rules for adding a credential, against the account as
 * it is now: a step-up when the account is enrolled, and recent
 * authentication — on this key, or by the password this ceremony's options
 * were answered with.
 *
 * @throws PasskeyChallengeError | StepUpRequiredError | RecentAuthenticationRequiredError | the admission's errors
 */
async function assertMayRegister(challenge: string, params: FinishPasskeyEnrollmentParams): Promise<void>
{
    const row = await liveChallenge(challenge, 'registration', params.userId);
    const admission = await admitDeferred(row && stampOf(row), {
        credential: params.credential,
        route: 'passkeyRegisterVerify',
    });

    if ('refused' in admission)
    {
        throw deferredRefusalError(admission.refused, new PasskeyChallengeError());
    }

    await assertStepUp(params);
    await assertRegistrationRecentlyAuthenticated(params, row!);
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

/**
 * Step 1 of a renewal-grade ceremony — options for `navigator.credentials.get()`.
 *
 * Two flows need one: renewing a bound session key, and leaving
 * `session_binding: 'passkey'`. Both ask the same question — "is the person who
 * enrolled a passkey here, right now" — and both are answered by an assertion
 * over a challenge this account owns.
 *
 * Each is its own challenge kind — `'renewal'` and `'bindingOff'` — so a
 * challenge minted to renew a key does not turn binding off, nor the other way
 * round. The challenge is stamped with the credential it is for
 * (`lib/deferred-stamp.ts`): the key being renewed, or the session turning
 * binding off. Only that credential can spend it (au9-N7).
 *
 * `allowCredentials` is empty, exactly as on the sign-in ceremony and for the
 * same reason (D3): the renewal options route is public, a key id is not a
 * secret the cookie-copying adversary lacks, and an answer that listed the
 * account's credential ids would hand them a stable per-relying-party identifier
 * list plus a live-or-not oracle on the key id. The challenge row is what carries
 * the account, server-side, where nobody can read it.
 */
export async function startRenewalCeremonyService(
    ceremony: RenewalGradeCeremony,
    stamp: DeferredStamp,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    return await buildAuthenticationOptions({
        config: getPasskeyConfig(),
        challenge: await mintStampedChallenge(ceremony, stamp),
    });
}

/** The two renewal-grade ceremonies, each its own challenge kind. */
export type RenewalGradeCeremony = Extract<WebAuthnChallengeKind, 'renewal' | 'bindingOff'>;

/** The route each renewal-grade ceremony completes on (`ROUTE_ENROLMENT`). */
const COMPLETING_ROUTE = {
    renewal: 'sessionRenewVerify',
    bindingOff: 'setSessionBinding',
} as const satisfies Record<RenewalGradeCeremony, string>;

export interface RenewalAssertionParams
{
    userId: number;
    ceremony: RenewalGradeCeremony;
    /**
     * What completes the ceremony: for a renewal, the `renewal` credential of
     * the key being renewed — admitted by the renewal grace rule rather than as
     * a live key; for binding-off, the session's own credential.
     */
    credential: PrincipalCredential;
    response: AuthenticationResponseJSON;
}

/** A renewal-grade assertion that verified, not yet spent. `spend` runs in the caller's transaction. */
export interface RenewalProof
{
    /** Under the account lock: false when the proof went stale, or the challenge is not this key's. */
    spend: () => Promise<boolean>;
}

/**
 * Step 2 — whether this assertion was signed by a live passkey of this account,
 * checked outside the account lock; null on every refusal.
 *
 * Answers rather than throws, because the two callers refuse in different
 * vocabularies and neither wants this file's: the renewal route answers one
 * `SessionRenewalRefusedError` to every refusal so that a live key, a
 * stranger's key and a key that never existed are indistinguishable, and the
 * binding route answers `RecentAuthenticationRequiredError` so the browser knows
 * to ask for the password instead.
 *
 * **A failed assertion spends the challenge** (au9-N7), in a transaction of its
 * own that commits before the caller refuses — so the refusal, which rolls back
 * the caller's transaction, cannot roll the spend back with it, and the same
 * challenge cannot be tried again. Both callers therefore run this outside any
 * transaction and open theirs for the success path. A proof that verified is
 * spent by `spend`, under the lock, only when the challenge's stamp admits this
 * key (`admitDeferred`).
 */
export async function checkRenewalAssertionService(params: RenewalAssertionParams): Promise<RenewalProof | null>
{
    const challenge = params.response?.response?.clientDataJSON
        ? presentedChallenge(params.response.response.clientDataJSON)
        : '';

    if (!await challengeIsLive(challenge, params.ceremony, params.userId))
    {
        authLogger.service.warn('Renewal challenge refused', { kind: params.ceremony });

        return null;
    }

    const verified = await verifiedRenewalAssertion(params.userId, params.response, challenge);

    if (!verified)
    {
        await spendFailedRenewalChallenge(params, challenge);

        return null;
    }

    return { spend: () => spendRenewalProof(params, challenge, verified) };
}

interface VerifiedAssertion
{
    passkey: Passkey;
    newCounter: number;
}

/**
 * The half of the check that is the credential rather than the nonce.
 *
 * The credential's owner must be the account the challenge was minted for. That
 * is the condition §5.3 asks for, and it holds the line a layer deeper than the
 * renewal middleware does: even a caller who somehow reached this step for a key
 * that is not theirs cannot finish the ceremony with their own passkey.
 */
async function verifiedRenewalAssertion(
    userId: number,
    response: AuthenticationResponseJSON,
    challenge: string,
): Promise<VerifiedAssertion | null>
{
    const passkey = await passkeysRepository.findLiveByCredentialId(response.id);

    if (!passkey || passkey.userId !== userId)
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

    return outcome.verified ? { passkey, newCounter: outcome.newCounter } : null;
}

/** Spend the challenge of an assertion that did not verify, in a transaction of its own (au9-N7). */
async function spendFailedRenewalChallenge(params: RenewalAssertionParams, challenge: string): Promise<void>
{
    await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(params.userId);
        await spendChallenge(challenge, params.ceremony, params.userId);
    }, { context: 'auth:renewal-failed-assertion' });
}

/**
 * Spend a verified renewal-grade proof, in the caller's transaction.
 *
 * The account lock first (`lockAccount`). Under it the challenge's stamp is
 * read and admitted for the credential this ceremony is for (`admitDeferred`):
 * a challenge minted for another — another session of the account, or the
 * key before it was renewed by someone else — is not this one's to spend. Then
 * the challenge is spent, and the passkey — read before the lock — has its use
 * recorded only on a row still live, at the counter verified against: a
 * revocation or another assertion that landed meanwhile refuses the renewal.
 */
async function spendRenewalProof(
    params: RenewalAssertionParams,
    challenge: string,
    verified: VerifiedAssertion,
): Promise<boolean>
{
    await usersRepository.lockAccount(params.userId);

    const row = await liveChallenge(challenge, params.ceremony, params.userId);
    const admission = await admitDeferred(row && stampOf(row), {
        credential: params.credential,
        route: COMPLETING_ROUTE[params.ceremony],
    });

    return !('refused' in admission)
        && await spendChallenge(challenge, params.ceremony, params.userId)
        && await passkeysRepository.recordUse(verified.passkey, verified.newCounter);
}

export interface FinishPasskeyLoginParams
{
    response: AuthenticationResponseJSON;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    /**
     * The sign-in body's `replacementProof`: a short JWT signed by the key this
     * one replaces. `registerPublicKeyService` alone decides whether it holds;
     * absent or not, the passkey was proved and the sign-in goes ahead.
     */
    replacementProof?: string;
    deviceName?: string;
    platform?: KeyPlatformType;
    /** Client address of the request, from `deviceProvenance` at the route. */
    ip?: string;
    /** `user-agent` of the request, already truncated at the route. */
    userAgent?: string;
    /** Whether proxy-guard recognised the trusted Next.js proxy, from the same helper. */
    webProxy?: boolean;
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

        assertChallenge(await challengeIsLive(challenge, 'authentication', null), 'authentication');

        const passkey = await passkeysRepository.findLiveByCredentialId(params.response.id);

        // A revoked credential and one that was never here answer identically
        // (L4/L5): anything else says whether this account once had it.
        if (!passkey)
        {
            throw new PasskeyVerificationError();
        }

        await assertActiveForPasskeyLogin(await usersRepository.findById(passkey.userId));
        const newCounter = await verifiedCounter(passkey, params.response, challenge);

        // The verification done, the account is locked (`lockAccount`) before
        // the challenge is spent and the passkey row written, and its status
        // is asked again under it. The passkey was read before the lock: its
        // use is recorded only on a row still live under it, at the counter
        // verified against, and a revocation that landed meanwhile refuses the
        // sign-in as a revoked credential is refused (L4/L5).
        const user = await assertActiveForPasskeyLogin(await usersRepository.lockAccount(passkey.userId));
        assertChallenge(await spendChallenge(challenge, 'authentication', user.id), 'authentication');

        if (!await passkeysRepository.recordUse(passkey, newCounter))
        {
            throw new PasskeyVerificationError();
        }

        return await startSession(user, params);
    }, { context: 'auth:passkey-login' });
}

/**
 * The tail every identified sign-in runs, once identity is settled.
 *
 * Lifted verbatim from `loginService` and the OAuth flows: register the new
 * device key (which retires the one it replaces, when the body proves it),
 * stamp the last login, announce it after the commit. Passkeys add a way to
 * prove identity, not a second way to hold a session, so this must stay the
 * same steps in the same order.
 */
async function startSession(user: User, params: FinishPasskeyLoginParams): Promise<LoginResult>
{
    const registered = await registerPublicKeyService({
        userId: user.id,
        keyId: params.keyId,
        publicKey: params.publicKey,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
        channel: 'passkey',
        missingAccount: () => new PasskeyVerificationError(),
        ip: params.ip,
        userAgent: params.userAgent,
        binding: decideKeyBinding(user.sessionBinding, params.webProxy),
        replaces: params.replacementProof ? { proof: params.replacementProof } : undefined,
        loginEvent: {
            provider: 'passkey',
            email: user.email || undefined,
            phone: user.phone || undefined,
        },
    });

    // A passkey sign-in steps up only when the second-factor policy does not
    // list passkeys: then the assertion is not a second factor, and an enrolled
    // account on a new device is asked for one like a password sign-in (#309).
    // Nothing below runs — `verify` does it instead.
    if (registered.pending)
    {
        return { mfaRequired: true, challenge: registered.challenge };
    }

    await updateLastLoginService(user.id);

    const result: LoginResult = {
        mfaRequired: false,
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
        ...loginBindingFields(registered),
        ...await secondFactorEnrolmentFields(user.id),
    };

    const mfaEnrolled = await mfaEnrolledForUser(user.id);

    onAfterCommit(() => authLoginEvent.emit({
        userId: String(user.id),
        provider: 'passkey',
        email: result.email,
        phone: result.phone,
        mfaEnrolled,
        secondFactorEnrolmentRequired: result.secondFactorEnrolmentRequired === true,
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
async function assertActiveForPasskeyLogin(user: User | null): Promise<User>
{
    if (!user)
    {
        throw new PasskeyVerificationError();
    }

    const refusal = await accountRefusal(user);
    if (refusal)
    {
        throw admissionRefusalError(refusal);
    }

    return user;
}

/**
 * Check the assertion, or refuse; the counter it moves to is the caller's to
 * record, under the account lock.
 *
 * A regressed counter is logged by passkey id and left alone (D11). It is the
 * signal a cloned authenticator would produce, but a synced passkey reports 0
 * forever and a legitimate device can hit it after a restore — revoking on it
 * automatically would lock people out over a false positive, so the refusal is
 * per request and a human decides what it meant.
 *
 * @throws PasskeyVerificationError
 */
async function verifiedCounter(
    passkey: Passkey,
    response: AuthenticationResponseJSON,
    challenge: string,
): Promise<number>
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

    return outcome.newCounter;
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
 * Gated on the second factor for an enrolled account, and then — for every
 * account, enrolled or not — on recent authentication, because someone who
 * walked up to an unlocked laptop should not be able to strip the account's
 * credentials; and on the
 * last-recovery-credential guard, because there is no undo for the state that
 * would leave.
 *
 * The owner row is locked before the guard runs, and the route's
 * `Transactional()` is what holds that lock to commit. Without it the guard is a
 * read-modify-write with a gap: an owner with two passkeys and nothing else who
 * fires two revokes at once has both count two live credentials, both pass, and
 * both revoke — the exact state the guard exists to refuse. Locking makes the
 * second revoke count one.
 */
export async function revokePasskeyService(params: RevokePasskeyParams): Promise<{ passkeyId: string }>
{
    await assertStepUp(params);
    await assertRecentAuthentication(params);

    const passkey = await passkeysRepository.findLiveByIdAndUserId(Number(params.passkeyId), params.userId);

    if (!passkey)
    {
        throw new PasskeyNotFoundError();
    }

    await usersRepository.lockAccount(params.userId);
    await assertNotLastRecoveryCredential(params.userId);
    await assertNotLastListedFactor(params.userId, { passkeyId: passkey.id });

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
