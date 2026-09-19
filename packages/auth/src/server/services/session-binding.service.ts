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
 * usual posture. `assertRecentAuthentication` is satisfied by the age of the
 * device key this request is signed with — and a cookie copied in the ten
 * minutes after a sign-in carries exactly that. So leaving `'passkey'` asks for
 * a credential the copy does not hold: a renewal-grade assertion, or the account
 * password.
 *
 * Enabling twice is idempotent. Recomputing the expiry on a repeat call would
 * make this route a way to extend a bound key without presenting anything, which
 * is the thing the short life exists to prevent.
 */

import { RecentAuthenticationRequiredError, SessionBindingUnavailableError } from '@spfn/auth/errors';
import { ValidationError } from '@spfn/core/errors';

import { getBoundKeyTtlMs } from '../lib/config';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '../lib/webauthn';
import { keysRepository, passkeysRepository, usersRepository } from '../repositories';
import { KEY_TTL_DAYS } from '../lib/key-policy';
import type { SessionBindingType } from '../types';
import { getDummyPasswordHash, verifyPassword } from '../helpers';
import {
    assertRecentAuthentication,
    startRenewalCeremonyService,
    verifyRenewalAssertionService,
} from './passkey.service';

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

export interface DisableSessionBindingParams extends SessionBindingParams
{
    /** A renewal-grade assertion, from `binding/disable/options`. */
    response?: AuthenticationResponseJSON;
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
    const key = await keysRepository.findByKeyId(keyId);

    if (key?.binding !== 'passkey' || !key.expiresAt)
    {
        return {};
    }

    return { sessionBinding: 'passkey', keyExpiresAtMillis: key.expiresAt.getTime() };
}

/**
 * Turn session binding on, and bind the key this request is signed with.
 *
 * The current key is bound here rather than only at the next sign-in, because
 * otherwise the setting would not apply to the session that asked for it until
 * the person signed in again — and the response is what tells the Next.js proxy
 * to re-seal the cookie with the new expiry, so the browser and the key row
 * agree from this moment on.
 *
 * @throws SessionBindingUnavailableError proxy-guard가 설정되지 않은 배포일 때
 * @throws ValidationError 살아 있는 패스키가 하나도 없을 때
 * @throws RecentAuthenticationRequiredError 최근 인증이 없을 때
 */
export async function enableSessionBindingService(
    params: SessionBindingParams,
): Promise<SessionBindingResult>
{
    if (!params.webProxy)
    {
        throw new SessionBindingUnavailableError();
    }

    const live = await passkeysRepository.listLiveByUserId(params.userId);

    if (live.length === 0)
    {
        throw new ValidationError({
            message: 'Session binding needs a passkey to renew with. Enroll one first.',
        });
    }

    await assertRecentAuthentication({ userId: params.userId, keyId: params.keyId });

    const user = await usersRepository.findById(params.userId);

    if (user?.sessionBinding === 'passkey')
    {
        return await getSessionBindingService(params);
    }

    await usersRepository.updateById(params.userId, {
        sessionBinding: 'passkey',
        sessionBindingChangedAt: new Date(),
    });

    const bound = await keysRepository.bindByKeyIdAndUserId(
        params.keyId,
        params.userId,
        new Date(Date.now() + getBoundKeyTtlMs()),
    );

    return { mode: 'passkey', keyExpiresAtMillis: bound?.expiresAt?.getTime() };
}

/**
 * Turn session binding off, once the caller has proved they are still the owner.
 *
 * Every bound key returns to an ordinary ninety-day life in the same call. A row
 * left marked `'passkey'` would keep expiring in hours with nothing left to
 * renew it, which is the state the person just asked not to be in.
 *
 * @throws RecentAuthenticationRequiredError 새 자격증명 없이 껐을 때
 */
export async function disableSessionBindingService(
    params: DisableSessionBindingParams,
): Promise<SessionBindingResult>
{
    if (!await provedOwnership(params))
    {
        throw new RecentAuthenticationRequiredError({
            message: 'Turning session binding off needs a passkey or your current password.',
        });
    }

    await usersRepository.updateById(params.userId, {
        sessionBinding: 'none',
        sessionBindingChangedAt: new Date(),
    });

    const unbound = new Date();
    unbound.setDate(unbound.getDate() + KEY_TTL_DAYS);
    await keysRepository.unbindActiveByUserId(params.userId, unbound);

    return { mode: 'none' };
}

/** The challenge the disabling ceremony signs. Same ceremony renewal uses. */
export async function startSessionBindingDisableService(
    userId: number,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    return await startRenewalCeremonyService(userId);
}

/**
 * Whether the caller presented something a copied cookie does not hold.
 *
 * Key age is deliberately not one of the answers — see this module's header. An
 * account with no password stored still pays a full bcrypt verify against a
 * dummy hash, on the same reasoning `assertRecentAuthentication` records: making
 * "no password on file" the fast refusal turns response time into an oracle for
 * which accounts are OAuth-only.
 */
async function provedOwnership(params: DisableSessionBindingParams): Promise<boolean>
{
    if (params.response)
    {
        return await verifyRenewalAssertionService(params.userId, params.response);
    }

    const user = await usersRepository.findById(params.userId);
    const storedHash = user?.passwordHash;
    const matched = await verifyPassword(
        params.currentPassword || NO_PASSWORD_PRESENTED,
        storedHash ?? await getDummyPasswordHash(),
    );

    return Boolean(storedHash) && matched;
}

/**
 * What is compared when the request carried no password at all.
 *
 * A fixed value nobody can have chosen, so the compare still runs and costs what
 * a wrong password costs.
 */
const NO_PASSWORD_PRESENTED = 'spfn-session-binding-no-password-presented';
