/**
 * @spfn/auth - Key Service
 *
 * Handles public key registration, rotation, and revocation
 */

import { type KeyAlgorithmType, type KeyPlatformType, type SessionBindingType } from '../types';
import { assertKeyMatchesAlgorithm, verifyKeyFingerprint } from '../helpers/jwt';
import { KEY_TTL_DAYS } from '../lib/key-policy';
import { getBoundKeyTtlMs } from '../lib/config';
import { uaFamily } from '../lib/ua-family';
import { InvalidKeyFingerprintError, KeyIdAlreadyRegisteredError } from '@spfn/auth/errors';
import { ValidationError } from '@spfn/core/errors';
import { deviceAuthorizationsRepository, deviceLinksRepository, keysRepository, usersRepository } from '../repositories';
import { revokeAllOAuth2GrantsForUser } from './oauth2-grant.service';
import { emitDeviceRegistered } from './device-registration.service';
import {
    assertStepUp,
    carryStepUpVerification,
    mfaEnrolledForUser,
    openStepUpChallengeService,
    resumeStepUpChallengeService,
} from './mfa.service';
import type { MfaChallengeHandle } from './login-result';
import { MFA_CHALLENGE_CHANNELS, type DeferredLoginEvent, type MfaChallengeChannel } from '../entities/mfa-challenges';
import type { DeviceRegistrationChannel } from '../events';

export interface RegisterPublicKeyParams
{
    userId: number;
    keyId: string;
    publicKey: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    /** Device label for the key list. Display only — nothing is authorized by it. */
    deviceName?: string;
    platform?: KeyPlatformType;
    /**
     * Which door this device came through. Required, so that a registration path
     * added later has to say what it is rather than inherit an answer.
     */
    channel: DeviceRegistrationChannel;
    /** Client address of the registering request, absent when none resolved. */
    ip?: string;
    /** `user-agent` of the registering request, already truncated. */
    userAgent?: string;
    /**
     * Whether this key is bound to a passkey, as the registering path decided.
     *
     * Decided by the caller from two facts it is the only one holding: the
     * owner's `session_binding` setting, and whether `proxy-guard` recognised the
     * request as coming through the trusted Next.js proxy (`decideKeyBinding`).
     * Never read off a request body, and `platform` is not consulted — that field
     * is display-only, usually absent on a proxy-made key, and a native client
     * may declare `'web'` freely. Omitted means `'none'`, which is what every
     * path that has no opinion gets.
     */
    binding?: SessionBindingType;
    /**
     * The key this one replaces on the same device, when a revocation actually
     * happened. Its presence is what makes this a rotation rather than a new
     * device, so no event is announced for it.
     *
     * Only ever set from a `revokeKeyService` that returned true: an `oldKeyId`
     * naming somebody else's key, an already-revoked key or nothing at all
     * revokes nothing, and treating that as a rotation would be a way to
     * register a device with the owner's notice switched off.
     */
    replacesKeyId?: string;
    /**
     * What to announce if this registration is stopped and later verified (#95).
     *
     * Read only on a channel that can step up, and only when it does. The login
     * event has to fire once and with the original channel's payload, and the
     * app's own `metadata` and the social provider that carried it are gone by
     * the time `POST /_auth/mfa/verify` runs — so the announcement rides the
     * challenge row rather than being guessed at from the user row.
     */
    loginEvent?: DeferredLoginEvent;
}

/**
 * What a registration settled on: a key, or a second factor still to prove.
 *
 * The `pending` branch is the 202 (#95). Its callers answer it to the client and
 * stop — no session, no event, no `lastLoginAt` — and everything they would have
 * done happens at `verify` instead.
 */
export type RegisterPublicKeyResult =
    | ({ pending: false } & RegisteredKeyBinding)
    | { pending: true; challenge: MfaChallengeHandle };

/**
 * The binding half of a registration that could not have been stepped up.
 *
 * Only four channels can answer `pending`, so a caller on any other one is
 * reading a case its channel cannot reach. Throwing rather than defaulting is
 * the honest answer if that ever stops being true: a silent `{}` would seal an
 * unbound session for a key nobody had proved, which is the one outcome this
 * whole feature exists to prevent.
 */
export function registeredBinding(result: RegisterPublicKeyResult): RegisteredKeyBinding
{
    if (result.pending)
    {
        throw new Error('This registration channel cannot require a second factor');
    }

    return result;
}

export interface RotateKeyParams
{
    userId: number;
    oldKeyId: string;
    newKeyId: string;
    newPublicKey: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    /** Omitted: the replaced key's label carries over, so rotation keeps its name. */
    deviceName?: string;
    platform?: KeyPlatformType;
}

export interface RotateKeyResult
{
    success: boolean;
    keyId: string;
}

export interface RevokeKeyParams
{
    userId: number;
    keyId: string;
    reason: string;
}

export interface RevokeAllKeysParams
{
    userId: number;
    /**
     * The key the request itself is signed with — spared unless includeCurrent.
     *
     * Optional because the two branches have different needs and always did: the
     * sparing branch has to know what to spare, and the `includeCurrent` branch
     * never reads it. The signed revoke-all link is the caller with no current
     * key to name — it arrives with no session at all — and requiring a value it
     * would have to invent is how a claim about a device that made no request
     * gets into a result.
     */
    currentKeyId?: string;
    /** true signs the caller out too. Default false: "my other devices". */
    includeCurrent?: boolean;
    reason: string;
}

export interface RevokeAllKeysResult
{
    revokedCount: number;
    currentKeyRevoked: boolean;
}

/** One registered device as the account surface shows it. */
export interface KeySummary
{
    keyId: string;
    deviceName?: string;
    /** One of `KEY_PLATFORM`, which is what the routes accept and the column stores. */
    platform?: KeyPlatformType;
    algorithm: KeyAlgorithmType;
    /** First bytes of the fingerprint — enough to tell two entries apart. */
    fingerprintPrefix: string;
    /**
     * Milliseconds since the Unix epoch, not an ISO string.
     *
     * One representation of a moment across the whole surface: a generated Swift
     * or Kotlin client reads an integer with no date formatter, and
     * `ISO8601DateFormatter` rejecting fractional seconds by default stops being
     * a way for the two SDKs to disagree about the same value.
     */
    createdAtMillis: number;
    lastUsedAtMillis?: number;
    expiresAtMillis?: number;
    /** The TTL has run out. The key still reads as active; authenticate refuses it. */
    isExpired: boolean;
    /** False once revoked. Only ever false when the caller asked for revoked keys. */
    isActive: boolean;
    /** When it was revoked, for the "what did I cut off, and when" reading. */
    revokedAtMillis?: number;
    /**
     * Client address the key was registered from, absent when none was resolved
     * or the key predates the column. Registration only — it does not move when
     * the device authenticates from somewhere else, which is what makes it
     * useful for recognising a device that was never yours.
     */
    registeredIp?: string;
    /** `user-agent` of the registering request, on the same terms as above. */
    registeredUserAgent?: string;
    /**
     * `'passkey'` when this key is bound to one, absent when it is not.
     *
     * Absent rather than `'none'`, so a deployment where nobody opted in answers
     * exactly the list it always did, and so every consumer reads "unbound" the
     * same way it reads it off a sign-in response.
     */
    binding?: SessionBindingType;
    /**
     * When this key was last seen from two client addresses inside the
     * concurrent-use window, absent when that has never been observed.
     *
     * A signal for the owner, not a refusal: addresses change legitimately, so
     * nothing is blocked by it and a device list that shows it is telling someone
     * to look rather than telling them something happened. The addresses
     * themselves are never returned.
     *
     * Only meaningful where proxy-guard is configured. Without it every web
     * request carries the Next.js server's own address, so two browsers on two
     * continents share one and this never fires.
     */
    concurrentUseAtMillis?: number;
}

export interface ListKeysParams
{
    userId: number;
    /** Also return keys already revoked. Default false: only what can still sign. */
    includeRevoked?: boolean;
}

/** How much of the fingerprint the list returns. */
export const KEY_FINGERPRINT_PREFIX_LENGTH = 8;

/**
 * What a key is registered as when the caller names no algorithm.
 *
 * Named rather than repeated as a literal because it is a published fact: the
 * mobile contract states it for `StartDeviceAuthRequest.algorithm`, the one
 * optional algorithm on that surface, and a client that omits the field is
 * relying on this value being what it was told.
 */
export const DEFAULT_KEY_ALGORITHM: KeyAlgorithmType = 'ES256';

/**
 * What a registration settled on, for the caller that has to tell the browser.
 *
 * The sign-in paths put these two into their `LoginResult`, the Next.js proxy
 * copies them into the sealed cookie, and that is the whole carrier by which the
 * proxy learns a session is bound and when its key runs out. Returned rather than
 * looked up again: the row was just written (or just read), so a second query
 * would be a second answer to a question already settled.
 */
export interface RegisteredKeyBinding
{
    binding: SessionBindingType;
    /** null only for a key registered before expiry was stamped at all. */
    expiresAt: Date | null;
}

/**
 * Helper: Calculate key expiry date — hours for a bound key, KEY_TTL_DAYS otherwise
 *
 * The binding is the input because it is the whole difference: a bound key's
 * short life is the protection, and the only thing allowed to give it a new one
 * is a renewal carrying a fresh WebAuthn assertion.
 */
function getKeyExpiryDate(binding: SessionBindingType): Date
{
    if (binding === 'passkey')
    {
        return new Date(Date.now() + getBoundKeyTtlMs());
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + KEY_TTL_DAYS);

    return expiresAt;
}

/**
 * Helper: 만료 시각이 지났는지 (null이면 만료 없음)
 */
function isExpired(expiresAt: Date | null): boolean
{
    return expiresAt !== null && new Date() > expiresAt;
}

/**
 * Whether this registration is stopped and asked for a second factor (#95).
 *
 * The decision lives here, at the one chokepoint every registration path goes
 * through, rather than at each of the four that can be stopped: a path added
 * later then inherits the rule instead of having to remember it.
 *
 * Three terms. The account has a second factor, or there is nothing to ask for.
 * The registration is not a rotation — `replacesKeyId` means a device already
 * signed in is swapping its key, which is not an arrival and not a moment to
 * challenge. And the channel is one of the four where a single stolen
 * credential would be enough on its own; a device-code approval and a passkey
 * sign-in each already carried a second proof, and `register`, `signup-link`,
 * `invitation` and `renewal` cannot reach this at all — the first three create
 * the account, which is by construction unenrolled, and the fourth is a
 * rotation. The brand-new social account is covered by the same fact: a user row
 * `createOrLinkUser` has just written has no second factor to ask for.
 */
async function decideStepUp(params: RegisterPublicKeyParams): Promise<MfaChallengeChannel | null>
{
    const channel = MFA_CHALLENGE_CHANNELS.find(candidate => candidate === params.channel);

    if (!channel || params.replacesKeyId)
    {
        return null;
    }

    return await mfaEnrolledForUser(params.userId) ? channel : null;
}

/**
 * The answer for a keyId this account already holds.
 *
 * Two of the three cases are ordinary: an active key being re-registered is a
 * repeated login from one device, and a key still waiting on a second factor is
 * a retried registration — a native client reusing its keyId, or an OAuth state
 * replayed from the back button. Both get their own state back rather than a
 * 409, which would refuse a caller for holding a key that is theirs.
 *
 * Anything else — a revoked key of their own, somebody else's key — is the one
 * error, told the same way, so a caller cannot probe whether a keyId exists.
 *
 * @throws KeyIdAlreadyRegisteredError
 */
async function answerForExistingKey(
    existing: NonNullable<Awaited<ReturnType<typeof keysRepository.findByKeyId>>>,
    userId: number,
): Promise<RegisterPublicKeyResult>
{
    if (existing.userId === userId && existing.isActive)
    {
        return { pending: false, ...await reRegisterOwnActiveKey(existing, userId) };
    }

    const resumed = existing.userId === userId && existing.pendingMfaChallengeId
        ? await resumeStepUpChallengeService(userId, existing.keyId)
        : null;

    if (resumed)
    {
        return { pending: true, challenge: resumed };
    }

    throw new KeyIdAlreadyRegisteredError();
}

/**
 * Register a new public key for a user
 *
 * `keyId` is UNIQUE across all users, so the lookup must ignore `isActive` —
 * filtering on it misses a revoked row and the insert then fails on the unique
 * index, rolling the whole login transaction back into a 500. Reuse is refused
 * with a domain error instead, telling the client to generate a fresh keyId.
 *
 * An enrolled account arriving on a new device gets the key written **inactive**
 * and a challenge back (#95). Nothing else happens: no device event, no login
 * event, no `lastLoginAt` — those are what the challenge is holding, and they
 * fire at `POST /_auth/mfa/verify` or not at all.
 *
 * @throws KeyIdAlreadyRegisteredError keyId가 이미 쓰인 값일 때 (자기 폐기 키 재사용 · 남의 키)
 * @throws InvalidKeyFingerprintError fingerprint가 publicKey와 맞지 않을 때
 * @throws KeyAlgorithmMismatchError 키의 SPKI 타입이 선언된 algorithm과 다를 때
 */
export async function registerPublicKeyService(
    params: RegisterPublicKeyParams,
): Promise<RegisterPublicKeyResult>
{
    const { userId, keyId, publicKey, fingerprint, algorithm = DEFAULT_KEY_ALGORITHM, deviceName, platform } = params;
    const binding = params.binding ?? 'none';

    const existing = await keysRepository.findByKeyId(keyId);
    if (existing)
    {
        return await answerForExistingKey(existing, userId);
    }

    // Verify fingerprint matches public key
    const isValidFingerprint = verifyKeyFingerprint(publicKey, fingerprint);
    if (!isValidFingerprint)
    {
        throw new InvalidKeyFingerprintError();
    }

    // The defaulted algorithm is what gets stored, so it is the one the key has
    // to be: a key parked under an algorithm it cannot sign for would only fail
    // at proof verification, after the caller believes it is enrolled.
    assertKeyMatchesAlgorithm(publicKey, algorithm);

    // Decided before the insert, so `is_active` is right the moment the row
    // exists. Deciding afterwards would leave a window, however short, in which
    // the key an unproven second factor is meant to be holding back is live.
    const stepUp = await decideStepUp(params);

    // Store public key — hours for a bound key, 90 days otherwise
    const row = await keysRepository.create({
        userId,
        keyId,
        publicKey,
        algorithm,
        fingerprint,
        deviceName,
        platform,
        binding,
        registeredIp: params.ip ?? null,
        registeredUserAgent: params.userAgent ?? null,
        registeredUaFamily: params.userAgent ? uaFamily(params.userAgent) : null,
        isActive: stepUp === null,
        expiresAt: getKeyExpiryDate(binding),
    });

    if (stepUp)
    {
        return { pending: true, challenge: await openStepUpChallengeService({
            userId,
            keyId,
            channel: stepUp,
            keyEpoch: await usersRepository.currentKeyEpoch(userId),
            loginEvent: params.loginEvent,
        }) };
    }

    // A rotation replaces a device that is already signed in, so it is not the
    // arrival this event exists to announce. Every other return above is an
    // early return or a throw, so a row written here is always a new device.
    //
    // That same device under a new key id carries its second-factor verification
    // across instead: this is the one place every `oldKeyId` rotation passes
    // through, and without it the step-up window would expire silently every
    // time the web proxy rotated.
    if (params.replacesKeyId)
    {
        await carryStepUpVerification(userId, params.replacesKeyId, keyId);
    }
    else
    {
        await emitDeviceRegistered(row, params.channel);
    }

    return { pending: false, binding, expiresAt: row.expiresAt };
}

/**
 * The caller re-registering a key it already holds — a repeated login from one
 * device, which is an ordinary path and stays a no-op success.
 *
 * Expiry is the one thing looked at. Nothing flips `isActive` when a TTL runs
 * out, so returning quietly on an expired key would answer the login 200 while
 * `authenticate` refuses every request it makes afterwards: signed in, and
 * nothing works. The sign-in just proved the identity again, so the expiry moves.
 *
 * A bound key is the exception, and it is the feature. Its short life is what a
 * copied cookie cannot outlast, and extending it on a login — a login a copied
 * cookie can perform, since the password is what it asks for and not the
 * credential binding exists to require — would hand back the ninety days this
 * setting was turned on to withhold. It is left expired and `session/renew`,
 * which needs a fresh WebAuthn assertion, is the only way to a live key.
 */
async function reRegisterOwnActiveKey(
    existing: { keyId: string; binding: SessionBindingType; expiresAt: Date | null },
    userId: number,
): Promise<RegisteredKeyBinding>
{
    if (existing.binding !== 'passkey' && isExpired(existing.expiresAt))
    {
        const extended = getKeyExpiryDate('none');
        await keysRepository.extendExpiry(existing.keyId, userId, extended);

        return { binding: 'none', expiresAt: extended };
    }

    return { binding: existing.binding, expiresAt: existing.expiresAt };
}

/**
 * Rotate user's public key (revoke old, register new)
 *
 * @throws InvalidKeyFingerprintError fingerprint가 newPublicKey와 맞지 않을 때
 * @throws KeyAlgorithmMismatchError 새 키의 SPKI 타입이 선언된 algorithm과 다를 때
 */
export async function rotateKeyService(
    params: RotateKeyParams,
): Promise<RotateKeyResult>
{
    const { userId, oldKeyId, newKeyId, newPublicKey, fingerprint, algorithm = DEFAULT_KEY_ALGORITHM } = params;

    // Verify fingerprint matches public key
    const isValidFingerprint = verifyKeyFingerprint(newPublicKey, fingerprint);
    if (!isValidFingerprint)
    {
        throw new InvalidKeyFingerprintError();
    }

    assertKeyMatchesAlgorithm(newPublicKey, algorithm);

    // Rotation replaces a key on the same device, so its label carries over unless
    // the client renames it. Read before the revoke — the row survives either way,
    // but the intent is "what this device was called", not "what it is called now".
    const replaced = await keysRepository.findByKeyIdAndUserId(oldKeyId, userId);

    // Revoke old key
    await keysRepository.revokeByKeyIdAndUserId(
        oldKeyId,
        userId,
        'Replaced by key rotation',
    );

    // Store new public key. Rotation is a new key for the same device, so
    // everything the row said about that device carries over: the label, the
    // platform, where and what it registered from — and the binding, which is
    // the owner's setting rather than anything this request chose.
    //
    // A *bound* key's expiry carries over verbatim, rather than being recomputed.
    // A rotation is not a renewal: recomputing would hand a bound key another full
    // window every time the browser rotated, which is a way to hold a bound
    // session open forever without ever presenting the credential that binding
    // exists to ask for. `session/renew` is the only path that moves it.
    //
    // An unbound rotation resets the ninety days, exactly as it did before #97.
    // Inheriting there would mean an app that rotates at every login — the
    // documented reason `rotateKey` exists — rotating on day 89 into a key that
    // expires tomorrow, and signing every one of its users out on day 91.
    await keysRepository.create({
        userId,
        keyId: newKeyId,
        publicKey: newPublicKey,
        algorithm,
        fingerprint,
        deviceName: params.deviceName ?? replaced?.deviceName ?? undefined,
        platform: params.platform ?? replaced?.platform ?? undefined,
        binding: replaced?.binding ?? 'none',
        registeredIp: replaced?.registeredIp ?? null,
        registeredUserAgent: replaced?.registeredUserAgent ?? null,
        registeredUaFamily: replaced?.registeredUaFamily ?? null,
        isActive: true,
        expiresAt: replaced?.binding === 'passkey' ? replaced.expiresAt : getKeyExpiryDate('none'),
    });

    // A rotation is already proof of the same device, so the second-factor
    // verification follows the key rather than dying with it (#95).
    await carryStepUpVerification(userId, oldKeyId, newKeyId);

    return {
        success: true,
        keyId: newKeyId,
    };
}

/**
 * Revoke a user's public key.
 *
 * Returns false when this call revoked nothing: the key belongs to somebody
 * else, or it was already revoked, or there is no such key. A caller acting on
 * a key id from outside (the device list) can therefore answer "not found"
 * instead of reporting a revocation that never happened — and the login paths
 * can tell a device replacement from a brand-new device, which is what decides
 * whether the owner is told about it. The repository scopes the update by
 * userId, so someone else's key is never touched either way.
 */
export async function revokeKeyService(
    params: RevokeKeyParams,
): Promise<boolean>
{
    const { userId, keyId, reason } = params;

    const revoked = await keysRepository.revokeByKeyIdAndUserId(keyId, userId, reason);

    return revoked !== null;
}

/**
 * List the caller's active keys — one entry per device that can sign for them.
 *
 * `isExpired` is computed rather than stored: an expired key keeps `isActive`
 * true (nothing flips it), and `authenticate` refuses it at request time. A list
 * that showed it as simply "active" would be telling the user something the
 * server does not act on.
 *
 * The fingerprint is truncated. Its full value is what a native sign-in must
 * send as its nonce (issue #63), and an account page has no use for it beyond
 * telling two entries apart.
 */
export async function listKeysService(params: ListKeysParams): Promise<KeySummary[]>
{
    const rows = await keysRepository.listForUser(params.userId, params.includeRevoked);

    return rows.map(row => ({
        keyId: row.keyId,
        deviceName: row.deviceName ?? undefined,
        platform: row.platform ?? undefined,
        algorithm: row.algorithm,
        fingerprintPrefix: row.fingerprint.slice(0, KEY_FINGERPRINT_PREFIX_LENGTH),
        createdAtMillis: row.createdAt.getTime(),
        lastUsedAtMillis: row.lastUsedAt?.getTime(),
        expiresAtMillis: row.expiresAt?.getTime(),
        isExpired: isExpired(row.expiresAt),
        isActive: row.isActive,
        revokedAtMillis: row.revokedAt?.getTime(),
        registeredIp: row.registeredIp ?? undefined,
        registeredUserAgent: row.registeredUserAgent ?? undefined,
        binding: row.binding === 'passkey' ? row.binding : undefined,
        concurrentUseAtMillis: row.concurrentUseAt?.getTime(),
    }));
}

/**
 * Revoke every active key the user has, optionally sparing the current one.
 *
 * The caller's own key is spared by default, so "sign out my other devices"
 * does not also end the session making the request. Passing
 * `includeCurrent: true` is the full sign-out, which until now was reachable
 * only as a side effect of changing a password.
 *
 * Live device authorizations are refused as well, in both modes. A device
 * waiting on an approved code has no key yet, so it is never the caller's own
 * device and never the one being spared — but its next poll would register a
 * brand-new active key, which would undo the revocation seconds after it ran.
 * That is the whole point of the call: the user has decided nothing else is to
 * stay signed in.
 *
 * `revokedCount` counts keys only, since that is the number the caller's screen
 * means by "devices signed out"; a code nobody had collected was never a session.
 */
export async function revokeAllKeysService(
    params: RevokeAllKeysParams,
): Promise<RevokeAllKeysResult>
{
    const { userId, currentKeyId, includeCurrent = false, reason } = params;

    if (!includeCurrent && !currentKeyId)
    {
        throw new ValidationError({ message: 'currentKeyId is required unless includeCurrent is set' });
    }

    // Only when a device is making the call. The signed sign-out-everywhere
    // link has no key to name and no session at all — it proved itself by a
    // mailbox round trip, which is a credential this window cannot measure.
    if (currentKeyId)
    {
        await assertStepUp({ userId, keyId: currentKeyId });
    }

    const revoked = !includeCurrent && currentKeyId
        ? await keysRepository.revokeAllActiveByUserIdExcept(userId, currentKeyId, reason)
        : await keysRepository.revokeAllActiveByUserId(userId, reason);

    await deviceAuthorizationsRepository.denyAllActiveByUserId(userId);

    // Device links the account issued go with them, for the same reason: an
    // approved link nobody has collected would register a key after this.
    await deviceLinksRepository.expireAllLiveByUserId(userId);

    // A grant the user gave a CLI carries a refresh token, so a client holding
    // one signs itself back in within the hour — which is exactly the client a
    // global revocation is aimed at. Revoked alongside the device codes, and for
    // the reason they are.
    await revokeAllOAuth2GrantsForUser(userId);

    return { revokedCount: revoked.length, currentKeyRevoked: includeCurrent };
}
