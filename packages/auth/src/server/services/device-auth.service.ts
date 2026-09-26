/**
 * @spfn/auth - Device Auth Service
 *
 * Device-code login: a device with no key on file yet shows a short code, the
 * account owner types that code on a device that is already signed in, and the
 * waiting device's key is registered on approval.
 *
 * There is no token to hand over. Every request in this system is signed by the
 * calling device's own key, so "logging a device in" means one thing — getting
 * its public key into `user_public_keys` under the right account. That is what
 * the poll does, and it is why the poll returns exactly what `loginService`
 * returns: from the client's side the two ways in are indistinguishable.
 *
 * | state ↓ op → | info | approve | deny | poll |
 * | --- | --- | --- | --- | --- |
 * | pending | device details | → approved | → denied | pending |
 * | approved | AlreadyHandled | AlreadyHandled | AlreadyHandled | key registered, → consumed |
 * | denied | AlreadyHandled | AlreadyHandled | AlreadyHandled | Denied |
 * | consumed | NotFound | NotFound | NotFound | NotFound |
 * | expired | Expired | Expired | Expired | Expired |
 * | unknown | NotFound | NotFound | NotFound | NotFound |
 *
 * A global revocation — revoke-all, a password change, a deletion request —
 * refuses the account's live records too, as `denied`, so they land in that row
 * of the table. See `denyAllActiveByUserId`; the three callers are the three
 * places that revoke every key at once.
 *
 * A poll may ask to wait (`waitMillis`). `waitForDeviceAuthAnswerService` then
 * holds a pending record's request — before the route's transaction opens — until
 * something answers it, the wait runs out, or the device hangs up, and only after
 * that is the table above applied. A long poll answers exactly what a short poll
 * sent at the same moment would, only sooner.
 */

import {
    AccountDisabledError,
    AccountPendingDeletionError,
    DeviceAuthNotFoundError,
    DeviceAuthExpiredError,
    DeviceAuthAlreadyHandledError,
    DeviceAuthDeniedError,
    InvalidKeyFingerprintError,
} from '@spfn/auth/errors';
import { onAfterCommit } from '@spfn/core/db';
import { getShutdownManager } from '@spfn/core/server';

import { deviceAuthorizationsRepository, usersRepository } from '../repositories';
import type { DeviceAuthorization, DeviceAuthStatus } from '../entities/device-authorizations';
import { type KeyAlgorithmType, type KeyPlatformType } from '../types';
import { getDeviceAuthConfig } from '../lib/device-auth-config';
import { holdDeviceAuthWait, waitForDeviceAuthAnswer, waitingOnDeviceAuth } from '../lib/device-auth-waiters';
import type { DeviceProvenance } from '../lib/device-provenance';
import { assertKeyMatchesAlgorithm, verifyKeyFingerprint } from '../helpers/jwt';
import {
    formatUserCode,
    generateDeviceCode,
    generateUserCode,
    hashDeviceCode,
    normalizeUserCode,
} from '../lib/device-code';
import {
    registerPublicKeyService,
    registeredBinding,
    DEFAULT_KEY_ALGORITHM,
    KEY_FINGERPRINT_PREFIX_LENGTH,
} from './key.service';
import { decideKeyBinding } from '../lib/key-policy';
import { updateLastLoginService } from './user.service';
import { getPendingDeletionInfo } from './account-deletion.service';
import { loginBindingFields, type LoginResult } from './auth.service';
import { mfaEnrolledForUser } from './mfa.service';
import { authLoginEvent } from '../events';

export interface StartDeviceAuthParams
{
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    /** Device label shown to the approver. Display only — nothing is authorized by it. */
    deviceName?: string;
    platform?: KeyPlatformType;
}

export interface StartDeviceAuthResult
{
    /** Returned once. The waiting device polls with it; the server stores only its hash. */
    deviceCode: string;

    /** `XXXX-XXXX`, for the waiting device's screen and nowhere else. */
    userCode: string;

    expiresAtMillis: number;

    /** Milliseconds the waiting device should wait between polls. */
    intervalMillis: number;
}

export interface DeviceAuthInfoParams
{
    userCode: string;
}

/** What the approver is shown about the device asking to be let in. */
export interface DeviceAuthInfoResult
{
    deviceName?: string;

    /** One of `KEY_PLATFORM`, which is what the route accepts and the column stores. */
    platform?: KeyPlatformType;

    /** First bytes of the pending key's fingerprint, as the device list truncates it. */
    fingerprintPrefix: string;

    requestedAtMillis: number;
    expiresAtMillis: number;
}

export interface ApproveDeviceAuthParams
{
    userCode: string;

    /** The approver, read from their session. Never from a request body. */
    userId: number;
}

export interface DenyDeviceAuthParams
{
    userCode: string;
}

export interface PollDeviceAuthParams
{
    deviceCode: string;
    /** Client address of the request, from `deviceProvenance` at the route. */
    ip?: string;
    /** `user-agent` of the request, already truncated at the route. */
    userAgent?: string;
    /**
     * Whether proxy-guard recognised the trusted Next.js proxy, from the same
     * helper. A waiting device polls the backend itself, so this is false there
     * and the key it collects is unbound — which is what a device with no browser
     * to run a WebAuthn ceremony in needs.
     */
    webProxy?: boolean;
    /**
     * How long this request already waited on the server, from the long-poll
     * middleware. A pending answer subtracts it from the interval: the device
     * has done that much of its waiting here.
     */
    waitedMillis?: number;
}

export interface WaitForDeviceAuthAnswerParams
{
    deviceCode: string;
    /** Longest the device is willing to wait, in milliseconds. Capped at `maxWaitMs`. */
    waitMillis: number;
    /** Aborts when the device hangs up, so a wait nobody is listening to ends. */
    signal?: AbortSignal;
}

/** Nobody has answered yet. Not an error — the waiting device waits. */
export interface DeviceAuthPendingResult
{
    status: 'pending';
    /**
     * How long to wait before polling again, less what the request already
     * waited on the server — 0 once a long poll has waited at least the interval,
     * so the device asks again at once.
     */
    intervalMillis: number;
}

/**
 * Approved and spent: the key is registered and this is the login it produced.
 *
 * `LoginResult`'s login fields are optional because a sign-in may answer a
 * second-factor challenge instead of a session (#95). This branch never can —
 * the owner already said yes on a device that is signed in, which is itself the
 * second factor — so the three it always carries are narrowed back to required
 * and a consumer of the approved branch reads exactly what it always read.
 */
export type DeviceAuthApprovedResult = { status: 'approved' } & LoginResult & {
    userId: string;
    publicId: string;
    passwordChangeRequired: boolean;
};

/** The login an approval produced, before `status` is put in front of it. */
export type DeviceAuthLogin = Omit<DeviceAuthApprovedResult, 'status'>;

export type PollDeviceAuthResult = DeviceAuthPendingResult | DeviceAuthApprovedResult;

/**
 * How many times a colliding user code is redrawn before the request fails.
 *
 * A collision needs two live rows out of 31^8 codes to land on the same one, so
 * three attempts is already far past the point of coincidence. Failing loudly
 * after that is deliberate: a run of collisions means the generator or the index
 * is not what this code thinks it is, and quietly looping would hide that.
 */
const USER_CODE_ATTEMPTS = 3;

/**
 * How often a waiting poll re-reads its record on its own.
 *
 * The wake an answer sends reaches only polls parked in the same process, so a
 * poll parked on another instance learns of an approval from this re-read. One
 * second bounds that delay; the read is one indexed lookup per waiting device.
 */
const WAIT_RECHECK_MS = 1000;

/**
 * How many polls may wait on one record at once. A device has one poll in
 * flight; a few more cover a retry that overlaps its own timed-out request.
 * Past this the poll is answered at once instead of waiting — the record's
 * answer is the same, and a caller cannot turn one code into many open waits.
 */
const MAX_WAITERS_PER_RECORD = 3;

/**
 * Refuse any record that cannot be acted on, whatever the operation.
 *
 * The two checks are in this order deliberately, and it is the one case where
 * the state matters more than the clock. A spent record answers as unknown, and
 * it has to keep answering that way after its TTL runs out — which it always
 * eventually does. Testing expiry first would mean a consumed code says
 * "expired" while a code that was never issued says "not found", which is the
 * enumeration oracle this error exists to close, just delayed ten minutes.
 *
 * Expiry outranks every other state: an approved record nobody collected in time
 * is expired, not approved, and registers nothing.
 *
 * Every timestamp compared here is server-side. The client's clock never enters
 * the decision, so a device with a wrong clock is not a device that can be let in
 * early or locked out late.
 */
function assertActionable(record: DeviceAuthorization | null): DeviceAuthorization
{
    if (!record || record.status === 'consumed')
    {
        throw new DeviceAuthNotFoundError();
    }

    if (record.expiresAt.getTime() < Date.now())
    {
        throw new DeviceAuthExpiredError();
    }

    return record;
}

/**
 * Explain a conditional transition that moved nothing, from the row still there.
 *
 * The UPDATE constrains two things and only two: the state it is allowed to move
 * from, and a TTL the database judges. So a miss is one of those two, and the
 * re-read says which — a record still sitting in the state it was asked to leave
 * was refused by the clock, and one that has moved on was answered by somebody
 * else. Deciding "expired" this way rather than by comparing timestamps again
 * keeps the answer the database's, which is whose opinion the UPDATE asked for.
 *
 * The order is `assertActionable`'s, and for its reason: a spent record answers
 * as unknown, and it has to keep answering that way once its TTL runs out too.
 *
 * @param moved the refusal owed when the record turns out to have moved on
 */
function refuseMissedTransition(
    record: DeviceAuthorization | null,
    from: DeviceAuthStatus,
    moved: () => Error,
): never
{
    if (!record || record.status === 'consumed')
    {
        throw new DeviceAuthNotFoundError();
    }

    if (record.status === from)
    {
        throw new DeviceAuthExpiredError();
    }

    throw moved();
}

/** The approver's view of a record, shared by info and by the approval answer. */
function describeDevice(record: DeviceAuthorization): DeviceAuthInfoResult
{
    return {
        deviceName: record.deviceName ?? undefined,
        platform: record.platform ?? undefined,
        fingerprintPrefix: record.fingerprint.slice(0, KEY_FINGERPRINT_PREFIX_LENGTH),
        requestedAtMillis: record.createdAt.getTime(),
        expiresAtMillis: record.expiresAt.getTime(),
    };
}

/**
 * Park a new device's key and hand back the codes it needs.
 *
 * The caller is unauthenticated by definition — this is what a device does before
 * it has any way to prove anything — so nothing here is attributed to an account.
 * The record gains an owner only when someone approves it.
 */
export async function startDeviceAuthService(
    params: StartDeviceAuthParams,
): Promise<StartDeviceAuthResult>
{
    // Checked here rather than left to the key registration the poll performs.
    // The fingerprint prefix is what the approver is shown to recognise the
    // device by, so an unverified one is decoration; and a device whose key
    // material does not hold together should be refused now, not after a person
    // has already approved it.
    if (!verifyKeyFingerprint(params.publicKey, params.fingerprint))
    {
        throw new InvalidKeyFingerprintError();
    }

    // The algorithm the poll will register the key under is decided here, by the
    // same default, so the key has to match it here — not once a person has
    // approved a device whose key could never sign for what it declared.
    assertKeyMatchesAlgorithm(params.publicKey, params.algorithm ?? DEFAULT_KEY_ALGORITHM);

    const { ttlMs, intervalMs } = getDeviceAuthConfig();
    const expiresAt = new Date(Date.now() + ttlMs);

    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt++)
    {
        const deviceCode = generateDeviceCode();
        const userCode = generateUserCode();

        const record = await deviceAuthorizationsRepository.create({
            deviceCodeHash: hashDeviceCode(deviceCode),
            userCode,
            publicKey: params.publicKey,
            keyId: params.keyId,
            fingerprint: params.fingerprint,
            algorithm: params.algorithm,
            deviceName: params.deviceName,
            platform: params.platform,
            expiresAt,
        });

        // null means one of the two codes was already taken — redraw both and
        // retry. Returning the row is what proves this call owns these codes.
        if (record)
        {
            return {
                deviceCode,
                userCode: formatUserCode(userCode),
                expiresAtMillis: expiresAt.getTime(),
                intervalMillis: intervalMs,
            };
        }
    }

    throw new Error(
        `Could not allocate a unique device user code in ${USER_CODE_ATTEMPTS} attempts. `
        + 'Check the code generator and the user_code unique index.',
    );
}

/**
 * What the approver sees before deciding.
 *
 * This is the whole defence against being talked into approving someone else's
 * device: the answer names the device that is waiting, so the person holding the
 * phone can see that it is not theirs. An approval screen that showed only the
 * code would be asking them to confirm a number they were just told.
 */
export async function getDeviceAuthInfoService(
    params: DeviceAuthInfoParams,
): Promise<DeviceAuthInfoResult>
{
    const record = assertActionable(
        await deviceAuthorizationsRepository.findByUserCode(normalizeUserCode(params.userCode)),
    );

    if (record.status !== 'pending')
    {
        throw new DeviceAuthAlreadyHandledError();
    }

    return describeDevice(record);
}

/**
 * Bind the record to the approving account.
 *
 * The key is not registered here. The waiting device may never come back, and a
 * key registered for a device that stopped listening is a signing credential
 * nobody asked for — so approval records the decision and the poll acts on it.
 *
 * Answers with the same device description `info` returns, so a client that let
 * a user approve without looking first can still show them what they just let
 * in — which is the moment someone talked into approving an attacker's device
 * has to notice and revoke it.
 */
export async function approveDeviceAuthService(
    params: ApproveDeviceAuthParams,
): Promise<DeviceAuthInfoResult>
{
    const userCode = normalizeUserCode(params.userCode);
    const record = assertActionable(
        await deviceAuthorizationsRepository.findByUserCode(userCode),
    );

    // The transition names `pending` and the TTL itself, so the read above is for
    // the refusal message only. A record that moved between the two — a second
    // approver, a deny from another device — or one that passed its expiry in the
    // same gap fails the transition rather than overwriting it.
    const approved = await deviceAuthorizationsRepository.approve(record.id, params.userId);

    if (!approved)
    {
        refuseMissedTransition(
            await deviceAuthorizationsRepository.findByUserCode(userCode),
            'pending',
            () => new DeviceAuthAlreadyHandledError(),
        );
    }

    return describeDevice(approved);
}

/**
 * Refuse the record, so the waiting device is told no instead of timing out.
 *
 * Denying binds no user: the point of refusing is that the account owner wants
 * nothing to do with the request.
 */
export async function denyDeviceAuthService(params: DenyDeviceAuthParams): Promise<void>
{
    const userCode = normalizeUserCode(params.userCode);
    const record = assertActionable(
        await deviceAuthorizationsRepository.findByUserCode(userCode),
    );

    const denied = await deviceAuthorizationsRepository.deny(record.id);

    if (!denied)
    {
        refuseMissedTransition(
            await deviceAuthorizationsRepository.findByUserCode(userCode),
            'pending',
            () => new DeviceAuthAlreadyHandledError(),
        );
    }
}

/**
 * Hold a long poll while its record is still pending.
 *
 * Called by the poll route's long-poll middleware, before `Transactional()`
 * opens: a transaction held open for the wait would pin a pooled connection per
 * waiting device. The reads here only decide whether to keep waiting and never
 * the answer — `pollDeviceAuthService` reads the record again inside the route's
 * transaction, and that read is the one the answer is built from. They go to
 * the primary, so a wake is not wasted on a replica that has not caught up.
 *
 * Every way out of the wait hands the request on to be judged, and none of them
 * throws. The wait ends at `expiresAt` (the judgement answers Expired), when the
 * server starts shutting down (so the device gets a pending answer instead of a
 * connection cut by the drain timeout), and when a read fails — the judgement
 * inside `Transactional()` runs the same read, and that is where a database
 * error is turned into the answer a client can read.
 *
 * @returns milliseconds the request waited; 0 when it did not wait at all
 */
export async function waitForDeviceAuthAnswerService(params: WaitForDeviceAuthAnswerParams): Promise<number>
{
    const requested = Math.min(params.waitMillis, getDeviceAuthConfig().maxWaitMs);
    const deviceCodeHash = hashDeviceCode(params.deviceCode);
    const record = requested > 0 ? await readWaitable(deviceCodeHash) : null;

    if (!record || waitingOnDeviceAuth(record.id) >= MAX_WAITERS_PER_RECORD)
    {
        return 0;
    }

    const startedAt = Date.now();
    const deadline = Math.min(startedAt + requested, record.expiresAt.getTime());

    await holdDeviceAuthWait(record.id, () => waitUntil(record.id, deviceCodeHash, deadline, params.signal));

    return Date.now() - startedAt;
}

/** Park, re-read, repeat — until the record moves, the deadline passes, or the wait has to end. */
async function waitUntil(id: number, deviceCodeHash: string, deadline: number, signal?: AbortSignal): Promise<void>
{
    while (!signal?.aborted && !getShutdownManager().isShuttingDown())
    {
        const remaining = deadline - Date.now();

        if (remaining <= 0)
        {
            return;
        }

        await waitForDeviceAuthAnswer(id, Math.min(remaining, WAIT_RECHECK_MS), signal);

        if (!await readWaitable(deviceCodeHash))
        {
            return;
        }
    }
}

/**
 * The record, if it is one a poll should keep waiting on. A failed read is "stop
 * waiting", not an error: the judgement repeats it inside `Transactional()`.
 */
async function readWaitable(deviceCodeHash: string): Promise<DeviceAuthorization | null>
{
    const record = await deviceAuthorizationsRepository
        .findByDeviceCodeHashOnPrimary(deviceCodeHash)
        .catch(() => null);

    return isWaitable(record) ? record : null;
}

/** Still nobody's answer, and still alive: the only record a poll waits on. */
function isWaitable(record: DeviceAuthorization | null): boolean
{
    return record?.status === 'pending' && record.expiresAt.getTime() > Date.now();
}

/**
 * The waiting device asking whether anyone has answered.
 *
 * Approved is the one branch with a side effect, and it is a one-shot: the record
 * is spent by a conditional update that names `approved`, so of two polls that
 * arrive together exactly one registers the key. The loser matches nothing and is
 * answered as if the code were unknown — which by then it is.
 */
export async function pollDeviceAuthService(
    params: PollDeviceAuthParams,
): Promise<PollDeviceAuthResult>
{
    const deviceCodeHash = hashDeviceCode(params.deviceCode);
    const record = assertActionable(
        await deviceAuthorizationsRepository.findByDeviceCodeHash(deviceCodeHash),
    );

    if (record.status === 'denied')
    {
        throw new DeviceAuthDeniedError();
    }

    if (record.status === 'pending')
    {
        return {
            status: 'pending',
            intervalMillis: Math.max(0, getDeviceAuthConfig().intervalMs - (params.waitedMillis ?? 0)),
        };
    }

    const consumed = await deviceAuthorizationsRepository.consumeApproved(deviceCodeHash);

    if (!consumed)
    {
        // Still approved means the TTL, not another poll, is what refused this
        // one — the record passed its expiry between the read above and the
        // statement that would have spent it.
        refuseMissedTransition(
            await deviceAuthorizationsRepository.findByDeviceCodeHash(deviceCodeHash),
            'approved',
            () => new DeviceAuthNotFoundError(),
        );
    }

    return { status: 'approved', ...await completeDeviceLogin(consumed, params) };
}

/**
 * Turn a spent authorization into a login: register the parked key, stamp the
 * sign-in, and answer with exactly what password login answers with.
 *
 * `userId` is non-null on any record that reached `approved` — the transition
 * that sets the status sets it in the same statement — but it is a nullable
 * column, so the impossible case is refused rather than coerced.
 *
 * The account is judged here and not only at approve time, with the same gate
 * and the same errors `loginService` uses, because approval and collection are
 * separate moments and the account can change between them. A user who approves
 * a device and then asks for their account to be deleted must not be handed a
 * fresh signing key by the next poll: that key would be created after the
 * deletion's own revoke-all swept the old ones, so cancelling the deletion later
 * would bring it back to life. Registering a key is registering a key, whichever
 * door it came through.
 */
async function completeDeviceLogin(
    record: DeviceAuthorization,
    provenance: DeviceProvenance,
): Promise<DeviceAuthLogin>
{
    if (record.userId === null)
    {
        throw new DeviceAuthNotFoundError();
    }

    const user = await usersRepository.findById(record.userId);

    if (!user)
    {
        throw new DeviceAuthNotFoundError();
    }

    if (user.status !== 'active')
    {
        if (user.status === 'pending_deletion')
        {
            const pending = await getPendingDeletionInfo(user.id);

            throw new AccountPendingDeletionError({
                purgeScheduledAt: pending?.purgeScheduledAt.toISOString(),
            });
        }

        throw new AccountDisabledError({ status: user.status });
    }

    // The provenance is the polling device's, not the approving one's: this is
    // the request that turns a parked key into a registered one, and the device
    // the owner sees in their list is the device that will be signing.
    const registered = await registerPublicKeyService({
        userId: user.id,
        keyId: record.keyId,
        publicKey: record.publicKey,
        fingerprint: record.fingerprint,
        algorithm: record.algorithm,
        deviceName: record.deviceName ?? undefined,
        platform: record.platform ?? undefined,
        channel: 'device-code',
        ip: provenance.ip,
        userAgent: provenance.userAgent,
        binding: decideKeyBinding(user.sessionBinding, provenance.webProxy),
    });

    await updateLastLoginService(user.id);

    const result: DeviceAuthLogin = {
        // A device-code approval is itself a second factor: the owner read the
        // code on a device that is already signed in and said yes, so this
        // channel never steps up (#95).
        mfaRequired: false,
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
        ...loginBindingFields(registeredBinding(registered)),
    };

    // After commit, not inline: the poll route is transactional, and a login
    // event emitted from inside it would announce a sign-in that a rollback then
    // erased — the key would not exist and the subscriber would already have
    // acted on it.
    const mfaEnrolled = await mfaEnrolledForUser(user.id);

    onAfterCommit(() => authLoginEvent.emit({
        userId: String(user.id),
        provider: 'device',
        email: result.email,
        phone: result.phone,
        mfaEnrolled,
    }));

    return result;
}
