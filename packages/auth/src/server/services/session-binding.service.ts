/**
 * @spfn/auth - Session Binding Service
 *
 * The opt-in from #97: an account says its web sessions should run on a key that
 * expires in hours and can only be renewed by a fresh WebAuthn assertion. A
 * session cookie copied off that machine — out of a browser profile, out of
 * DevTools, by malware — still signs like the original until that key runs out,
 * and then stops, because the copy cannot produce the assertion.
 *
 * Three rules shape this file.
 *
 * It can only be turned on where the backend can recognise the trusted Next.js
 * proxy. `clientType` is that recognition and `proxy-guard` is what sets it;
 * without it every key would be registered unbound and the setting would be a
 * switch that reports success and protects nothing, so the request is refused as
 * the configuration error it is.
 *
 * Turning it *off* is the privileged direction, which is the reverse of the
 * usual posture. `assertRecentAuthentication` is satisfied by when this
 * session's credential last authenticated — for a device key, its own sign-in —
 * and a cookie copied in the ten minutes after a sign-in carries exactly that.
 * So leaving `'passkey'` asks for
 * a credential the copy does not hold: a renewal-grade assertion, or the account
 * password.
 *
 * Turning it *on* asks the passkey proof (`bindingEnable`): an assertion that
 * verified the person, which is exactly what every renewal will ask. An account
 * whose passkeys cannot give one — no live passkey, or only one that never
 * verifies the person — would otherwise be bound and then locked out by its own
 * setting.
 *
 * Enabling twice is idempotent. Recomputing the expiry on a repeat call would
 * make this route a way to extend a bound key without presenting anything, which
 * is the thing the short life exists to prevent.
 */

import { runInTransaction } from '@spfn/core/db';
import { RecentAuthenticationRequiredError, SessionBindingUnavailableError } from '@spfn/auth/errors';
import { NotFoundError, ValidationError } from '@spfn/core/errors';

import type { PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import { keysRepository, usersRepository } from '../repositories';
import type { SessionBindingType } from '../types';
import { getDummyPasswordHash, verifyPassword } from '../helpers';
import {
    assertRecentAuthentication,
    checkPasskeyProof,
    checkRenewalAssertionService,
    startRenewalCeremonyService,
    type RenewalProof,
} from './passkey.service';
import { stampFor } from '../lib/deferred-stamp';
import { spendPasskeyProof } from '../lib/passkey-proof';
import { startingCredentialOf } from './deferred-admission.service';
import { isRenewable, renewalGraceCutoff, type PrincipalCredential } from './admission.service';
import { sweepEachAccount, SWEEP_BATCH } from './account-sweep.service';
import { keyLiveness, type KeyWithAccountEpoch } from '../lib/key-liveness';
import { getKeyExpiryDate } from './key.service';
import { decideKeyBinding } from '../lib/key-policy';
import { authLogger } from '../logger';
import type { PasskeyProofProcedure } from '../entities/webauthn-challenges';

/** What every one of the three reads and writes here answers with. */
export interface SessionBindingResult
{
    mode: SessionBindingType;
    /**
     * When the key this request is signed with expires, for a bound session.
     *
     * Absent when the account is unbound, and absent for a bound account asking
     * from a key that is not itself bound — a native client, say, whose key was
     * registered on a channel the proxy never touched. The response is the input
     * the Next.js interceptor re-seals the cookie from, so it describes this
     * session rather than the account.
     */
    keyExpiresAtMillis?: number;
}

export interface SessionBindingParams
{
    userId: number;
    /** The device key this request is signed with — the one binding is applied to. */
    keyId: string;
    /** Whether proxy-guard recognised the trusted Next.js proxy. */
    webProxy?: boolean;
}

export interface EnableSessionBindingParams extends SessionBindingParams
{
    /** The credential this request presented (`getAuth(c).credential`): its recent authentication is asked. */
    credential: PrincipalCredential;
    /** The `bindingEnable` passkey proof, as the request body carried it (`passkeyResponse`). */
    passkeyResponse?: unknown;
}

export interface DisableSessionBindingParams extends SessionBindingParams
{
    /** The credential this request presented (`getAuth(c).credential`): the one the challenge was asked with. */
    credential: PrincipalCredential;
    /** A renewal-grade assertion, from `binding/disable/options`. */
    response?: unknown;
    /** The account password, for a browser with no passkey to hand. */
    currentPassword?: string;
}

/** What binding is on this account, and when this session's key runs out. */
export async function getSessionBindingService(params: SessionBindingParams): Promise<SessionBindingResult>
{
    const user = await usersRepository.findById(params.userId);
    const key = await keysRepository.findByKeyIdAndUserId(params.keyId, params.userId);

    return {
        mode: user?.sessionBinding ?? 'none',
        keyExpiresAtMillis: key?.binding === 'passkey' ? key.expiresAt?.getTime() : undefined,
    };
}

/**
 * The binding facts of one key, by key id alone.
 *
 * For `/_auth/oauth/finalize`, which is the one sealing path with no session and
 * no `LoginResult` to read them off: the browser arrives at the callback page
 * holding a key id the OAuth state minted, and the interceptor seals a session
 * from the answer. Reflecting the caller's own claim about binding would let a
 * caller ask for an unbound cookie over a bound key, so the row is read instead.
 *
 * Scoped by key id and nothing else. The id is a server-minted UUID that only
 * ever travelled inside the sealed state, so a caller who holds one holds it
 * because the flow gave it to them; adding the caller's own `userId` to the
 * lookup would make the answer vary by a second guessable value without
 * withholding anything from someone who already has the first.
 */
export async function keySessionBindingService(
    keyId: string,
): Promise<{ sessionBinding?: SessionBindingType; keyExpiresAtMillis?: number }>
{
    const key = await keysRepository.findByKeyIdOnPrimary(keyId);

    if (key?.binding !== 'passkey' || !key.expiresAt)
    {
        return {};
    }

    return { sessionBinding: 'passkey', keyExpiresAtMillis: key.expiresAt.getTime() };
}

/**
 * Turn session binding on, and bind every web session the account has.
 *
 * The current key is bound here rather than only at the next sign-in, because
 * otherwise the setting would not apply to the session that asked for it until
 * the person signed in again — and the response is what tells the Next.js proxy
 * to re-seal the cookie with the new expiry, so the browser and the key row
 * agree from this moment on.
 *
 * The account's other web sessions are bound with it (au3-A5), the copy the
 * owner may be reacting to included: each gets a bound key's short life, and
 * at its expiry is asked for a passkey renewal a copy cannot give. A key that
 * is no web session's (`viaWebProxy` false — a native client, a device-code
 * device) is left as it is: it has no cookie to copy and no browser to renew
 * in. Keys registered afterwards are bound where every key is written
 * (`registerPublicKeyService`).
 *
 * @throws SessionBindingUnavailableError proxy-guard가 설정되지 않은 배포일 때
 * @throws RecentAuthenticationRequiredError 최근 인증이 없을 때
 * @throws PasskeyProofRequiredError 사용자 검증을 거친 패스키 증명이 없을 때
 */
export async function enableSessionBindingService(
    params: EnableSessionBindingParams,
): Promise<SessionBindingResult>
{
    if (!params.webProxy)
    {
        throw new SessionBindingUnavailableError();
    }

    await assertRecentAuthentication({ userId: params.userId, credential: params.credential });

    // An assertion that does not verify spends its challenge, so the proof is
    // checked before the transaction a refusal would roll that spend back with.
    const proof = await checkPasskeyProof({
        userId: params.userId,
        credential: params.credential,
        procedure: 'bindingEnable',
        response: params.passkeyResponse,
    });

    return await runInTransaction(() => bindAccount(params, proof), { context: 'auth:session-binding-enable' });
}

/**
 * The account locked (`usersRepository.lockAccount`), the proof is spent
 * before its setting is read and its key is bound: a passkey revoked since the
 * check fails the spend, so the account is never bound with nothing to renew
 * with.
 *
 * @throws PasskeyProofRequiredError
 */
async function bindAccount(params: SessionBindingParams, proof: RenewalProof | null): Promise<SessionBindingResult>
{
    const user = await usersRepository.lockAccount(params.userId);

    await spendPasskeyProof(proof, 'bindingEnable', BINDING_ENABLE_PROOF_MESSAGE);

    if (user?.sessionBinding === 'passkey')
    {
        return await getSessionBindingService(params);
    }

    await usersRepository.updateById(params.userId, {
        sessionBinding: 'passkey',
        sessionBindingChangedAt: new Date(),
    });

    const bound = await keysRepository.bindKeys(
        params.userId,
        await webSessionKeyIds(params),
        getKeyExpiryDate('passkey'),
    );

    return { mode: 'passkey', keyExpiresAtMillis: bound.find(key => key.keyId === params.keyId)?.expiresAt?.getTime() };
}

/**
 * The keys turning binding on binds, read under the account lock: the one this
 * request is signed with, and every web key (`viaWebProxy`) that still opens a
 * session — live (`keyLiveness`), or waiting on a second factor, which would
 * otherwise be activated unbound. An expired or revoked key is not given a new
 * life by being bound, and a narrowed key is never bound (`decideKeyBinding`).
 */
async function webSessionKeyIds(params: SessionBindingParams): Promise<string[]>
{
    const keys = await keysRepository.findUnrevokedWithAccountEpochByUserId(params.userId);

    return keys
        .filter(key => decideKeyBinding('passkey', key.viaWebProxy || key.keyId === params.keyId, key.reach) === 'passkey')
        .filter(opensASession)
        .map(key => key.keyId);
}

function opensASession(key: KeyWithAccountEpoch): boolean
{
    return keyLiveness(key) === 'live' || key.pendingMfaChallengeId !== null;
}

/** What turning binding on without a proof is refused with: what every renewal will ask. */
const BINDING_ENABLE_PROOF_MESSAGE =
    'Session binding renews with a passkey that verifies you (PIN or biometric). Confirm with one to turn it on.';

/**
 * Turn session binding off, once the caller has proved they are still the owner.
 *
 * Every bound key not yet expired returns to an ordinary ninety-day life in the
 * same call. A row left marked `'passkey'` would keep expiring in hours with
 * nothing left to renew it, which is the state the person just asked not to be
 * in. A bound key already expired is not one of them, inside its grace or past
 * it: only a passkey could have renewed it, and it is revoked
 * (`releaseBoundKeys`).
 *
 * @throws RecentAuthenticationRequiredError 새 자격증명 없이 껐을 때
 */
export async function disableSessionBindingService(
    params: DisableSessionBindingParams,
): Promise<SessionBindingResult>
{
    const proof = await ownershipProof(params);

    if (!proof)
    {
        throw new RecentAuthenticationRequiredError({
            message: 'Turning session binding off needs a passkey or your current password.',
        });
    }

    return await runInTransaction(() => unbindAccount(params.userId, proof), { context: 'auth:session-binding-disable' });
}

/**
 * After the proof, which may verify a password: the account lock first
 * (`usersRepository.lockAccount`), the proof spent under it, then the setting
 * and the keys.
 *
 * @throws RecentAuthenticationRequiredError when the proof went stale under the lock
 */
async function unbindAccount(userId: number, proof: RenewalProof): Promise<SessionBindingResult>
{
    await usersRepository.lockAccount(userId);

    if (!await proof.spend())
    {
        throw new RecentAuthenticationRequiredError({
            message: 'Turning session binding off needs a passkey or your current password.',
        });
    }

    await releaseAccount(userId);

    return { mode: 'none' };
}

/**
 * Turn session binding off for an account, with no proof — the operator's way
 * out for an owner who lost every passkey and has neither a password nor a
 * verified e-mail to reset one with: such an account can neither renew, nor
 * turn binding off, nor enrol a passkey (that asks the passkey proof). The keys
 * are released as turning it off releases them (`releaseBoundKeys`).
 *
 * A service, not a route: the application decides who may call it. Once
 * committed it logs the account and how many keys it released and revoked. It
 * ends no session; an operator who suspects a takeover also calls
 * `revokeAllKeysService({ userId, includeCurrent: true })`.
 *
 * @throws NotFoundError for an account that does not exist
 */
export async function resetSessionBindingService(userId: number): Promise<void>
{
    const keys = await runInTransaction(async () =>
    {
        if (!await usersRepository.lockAccount(userId))
        {
            throw new NotFoundError({ message: 'User not found', resource: 'User' });
        }

        return await releaseAccount(userId);
    }, { context: 'auth:session-binding-reset' });

    authLogger.service.info('Session binding reset by operator', { userId, ...keys });
}

/** How many bound keys turning binding off returned to ordinary keys, and how many it revoked. */
interface ReleasedKeys
{
    released: number;
    revoked: number;
}

/** Under the account lock: the setting off, and its bound keys released. */
async function releaseAccount(userId: number): Promise<ReleasedKeys>
{
    await usersRepository.updateById(userId, {
        sessionBinding: 'none',
        sessionBindingChangedAt: new Date(),
    });

    return await releaseBoundKeys(userId);
}

/**
 * Under the account lock: every bound key not yet expired that opens a session
 * — live (`keyLiveness`), or still waiting on a second factor — becomes an
 * ordinary key with ninety days; every other bound key — expired, inside its
 * renewal grace or past it, parked or not — is revoked (au3-A1). Before the
 * switch only a passkey could renew an expired one; handing it ninety days
 * would revive, with no proof, exactly the copied session binding exists to
 * end. `isRenewable` stays what renewal admission and the sweep use.
 */
async function releaseBoundKeys(userId: number): Promise<ReleasedKeys>
{
    const bound = (await keysRepository.findUnrevokedWithAccountEpochByUserId(userId))
        .filter(key => key.binding === 'passkey');
    const released = bound.filter(key => opensASession(key) && !hasExpired(key));

    await keysRepository.unbindKeys(userId, released.map(key => key.keyId), getKeyExpiryDate('none'));

    return {
        released: released.length,
        revoked: await revokeDead(userId, bound.filter(key => !released.includes(key)), EXPIRED_AT_UNBIND_REASON),
    };
}

function hasExpired(key: KeyWithAccountEpoch): boolean
{
    return key.expiresAt !== null && Date.now() > key.expiresAt.getTime();
}

/** Revoke dead bound keys one at a time, a parked one with its pending mark. */
async function revokeDead(userId: number, keys: KeyWithAccountEpoch[], reason: string): Promise<number>
{
    for (const key of keys)
    {
        await keysRepository.revokeUnrevokedByKeyIdAndUserId(key.keyId, userId, reason);
    }

    return keys.length;
}

/** What a bound key revoked for being past its renewal grace records. */
export const PAST_GRACE_REASON = 'Bound key past its renewal grace';

/** What a bound key already expired when binding was turned off records. */
export const EXPIRED_AT_UNBIND_REASON = 'Bound key expired when session binding was turned off';

/**
 * Revoke the bound keys that are past their renewal grace, one account at a
 * time under its lock (`sweepEachAccount`), so an expired bound key does not
 * linger as an "active" row a later write could mistake for a live one. The
 * candidates are picked by the grace boundary (`renewalGraceCutoff`); under
 * the lock, `isRenewable` decides.
 *
 * @returns number of keys revoked
 */
export async function sweepPastGraceBoundKeysService(): Promise<{ revoked: number }>
{
    const revoked = await sweepEachAccount(
        await keysRepository.findAccountsWithBoundKeysExpiredBefore(renewalGraceCutoff(), SWEEP_BATCH),
        'auth:bound-key-sweep',
        revokePastGrace,
    );

    return { revoked };
}

/** One account's sweep, under its lock: its active bound keys that are no longer renewable. */
async function revokePastGrace(userId: number): Promise<number>
{
    const keys = await keysRepository.findUnrevokedWithAccountEpochByUserId(userId);

    return await revokeDead(userId, keys.filter(key => key.binding === 'passkey' && key.isActive && !isRenewable(key)), PAST_GRACE_REASON);
}

/**
 * The challenge the disabling ceremony signs — a renewal-grade assertion of
 * its own kind (`'bindingOff'`), stamped with this request's credential
 * (`lib/deferred-stamp.ts`): only this session, in this key generation, can
 * spend it, and only to turn binding off.
 */
export async function startSessionBindingDisableService(
    userId: number,
    credential: PrincipalCredential,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    const user = await usersRepository.findByIdOnPrimary(userId);

    if (!user)
    {
        throw new ValidationError({ message: 'User not found' });
    }

    return await startRenewalCeremonyService('bindingOff', stampFor(user, startingCredentialOf(credential)));
}

/**
 * The challenge one procedure that lets another credential in asks of a bound
 * account (`lib/passkey-proof.ts`) — its own kind, stamped with this request's
 * credential, as binding-off's is. Minted for any account: a client may ask
 * before it knows whether the account is bound, and an unbound account's
 * procedure ignores the proof.
 */
export async function startPasskeyProofService(
    userId: number,
    credential: PrincipalCredential,
    procedure: PasskeyProofProcedure,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    const user = await usersRepository.findByIdOnPrimary(userId);

    if (!user)
    {
        throw new ValidationError({ message: 'User not found' });
    }

    return await startRenewalCeremonyService(procedure, stampFor(user, startingCredentialOf(credential)));
}

/**
 * Whether the caller presented something a copied cookie does not hold, as a
 * proof to spend under the account lock — or null.
 *
 * Key age is deliberately not one of the answers — see this module's header. An
 * account with no password stored still pays a full bcrypt verify against a
 * dummy hash, on the same reasoning `assertRecentAuthentication` records: making
 * "no password on file" the fast refusal turns response time into an oracle for
 * which accounts are OAuth-only. An assertion that does not verify spends its
 * challenge (`checkRenewalAssertionService`), which is why the route runs no
 * transaction a refusal would roll that spend back with.
 */
async function ownershipProof(params: DisableSessionBindingParams): Promise<RenewalProof | null>
{
    if (params.response)
    {
        return await checkRenewalAssertionService({
            userId: params.userId,
            ceremony: 'bindingOff',
            credential: params.credential,
            response: params.response,
        });
    }

    const user = await usersRepository.findById(params.userId);
    const storedHash = user?.passwordHash;
    const matched = await verifyPassword(
        params.currentPassword || NO_PASSWORD_PRESENTED,
        storedHash ?? await getDummyPasswordHash(),
    );

    return storedHash && matched ? { spend: async () => true } : null;
}

/**
 * What is compared when the request carried no password at all.
 *
 * A fixed value nobody can have chosen, so the compare still runs and costs what
 * a wrong password costs.
 */
const NO_PASSWORD_PRESENTED = 'spfn-session-binding-no-password-presented';
