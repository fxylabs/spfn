/**
 * @spfn/auth - Device Link Service
 *
 * Device link: the mirror image of device-code login. A device that is already
 * signed in (the issuer) asks for a short code and shows it; a new device with no
 * key on file reads it, redeems it with its public key, and shows a two-digit
 * match number; the issuer is shown the device and three numbers, and picks the
 * one on the new device's screen. The new device's next poll registers its key
 * under the issuer's account and answers exactly what `loginService` answers —
 * the same completion device-code login uses, so the two are indistinguishable.
 *
 * | state ↓ op → | redeem | status | confirm | deny | cancel | poll |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | issued | device parked, → redeemed | issued | NotRedeemed | NotRedeemed | → expired | — |
 * | redeemed | NotFound | device + choices | match: → approved; else → denied, WrongMatch | → denied | → expired | pending |
 * | approved | NotFound | approved | AlreadyHandled | AlreadyHandled | AlreadyHandled | key registered, → consumed |
 * | denied | NotFound | denied | AlreadyHandled | AlreadyHandled | AlreadyHandled | Denied |
 * | consumed | NotFound | consumed | AlreadyHandled | AlreadyHandled | AlreadyHandled | NotFound |
 * | dead | Expired | Expired | Expired | Expired | Expired | Expired |
 * | unknown | NotFound | NotFound | NotFound | NotFound | NotFound | NotFound |
 *
 * "Dead" is a link past its TTL, one its issuer cancelled or replaced or a global
 * revocation expired (status `expired`), and one whose issuing key has since been
 * revoked or run out — whatever state it was in. Expiry outranks state, with one
 * exception on the new device's side, for device-code login's reason: a spent
 * link answers redeem and poll as unknown even once its TTL has run out.
 *
 * Status, confirm, deny and cancel belong to the issuing key alone. A link
 * another key issued — another account's, or another device of the same
 * account's — answers NotFound to them before anything else is judged, so a
 * device that did not issue a link cannot learn it exists.
 *
 * Both parties can long-poll: the issuer's `status` while the link waits on the
 * new device (issued, or approved and not yet collected), the new device's `poll`
 * while it waits on the issuer (redeemed). The waits run before the routes'
 * transactions open, as device-code login's does, and every transition wakes
 * both after commit.
 *
 * Nothing here logs a user code, a device code, a match number or a key.
 */

import { randomUUID } from 'node:crypto';

import {
    DeviceLinkAlreadyHandledError,
    DeviceLinkDeniedError,
    DeviceLinkExpiredError,
    DeviceLinkNotFoundError,
    DeviceLinkNotRedeemedError,
    DeviceLinkWrongMatchError,
    InvalidKeyFingerprintError,
} from '@spfn/auth/errors';
import { getShutdownManager } from '@spfn/core/server';

import { deviceLinksRepository, type DeviceLinkRecord } from '../repositories';
import type { DeviceLink, DeviceLinkStatus } from '../entities/device-links';
import { type KeyAlgorithmType, type KeyPlatformType } from '../types';
import { getDeviceAuthConfig } from '../lib/device-auth-config';
import { getDeviceLinkConfig } from '../lib/device-link-config';
import { generateChoices, generateMatchNumber } from '../lib/device-link-match';
import { holdDeviceLinkWait, waitForDeviceLinkMove, waitingOnDeviceLink } from '../lib/device-link-waiters';
import type { DeviceProvenance } from '../lib/device-provenance';
import { assertKeyMatchesAlgorithm, verifyKeyFingerprint } from '../helpers/jwt';
import {
    formatUserCode,
    generateDeviceCode,
    generateUserCode,
    hashDeviceCode,
    normalizeUserCode,
} from '../lib/device-code';
import { DEFAULT_KEY_ALGORITHM, KEY_FINGERPRINT_PREFIX_LENGTH } from './key.service';
import { completeDeviceLogin, type ParkedDeviceKey, type PollDeviceAuthResult } from './device-auth.service';

/** The signed-in device a link belongs to, read from the request's principal. Never from a body. */
export interface DeviceLinkIssuer
{
    userId: number;
    /** The key that signed the request. */
    keyId: string;
}

export interface IssueDeviceLinkResult
{
    /** The issuer's handle on the link, for status, confirm, deny and cancel. */
    linkId: string;

    /** `XXXX-XXXX`, for the issuer's screen — as text and in the QR the client draws. */
    userCode: string;

    /** For the countdown on the issuer's screen. Display only; the server decides by its own clock. */
    expiresAtMillis: number;
}

export interface RedeemDeviceLinkParams
{
    userCode: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    /** Device label shown to the issuer. Display only — nothing is authorized by it. */
    deviceName?: string;
    platform?: KeyPlatformType;
}

export interface RedeemDeviceLinkResult
{
    /** Returned once. The new device polls with it; the server stores only its hash. */
    deviceCode: string;

    /** The number the new device shows, 10–99, for the issuer to pick out of three. */
    matchNumber: number;

    expiresAtMillis: number;

    /** Milliseconds the new device should wait between polls. */
    intervalMillis: number;
}

export interface DeviceLinkParams
{
    linkId: string;
    issuer: DeviceLinkIssuer;
}

export interface ConfirmDeviceLinkParams extends DeviceLinkParams
{
    /** The number the issuer picked. */
    choice: number;
}

/**
 * The issuer's view of its link, which every issuer operation answers with.
 *
 * The device fields appear once a device has redeemed the code; `choices` only
 * while the link waits on the issuer's pick (`redeemed`), since that is the only
 * moment a number means anything. `expired` is only ever cancel's answer: a
 * link that is dead when it is asked about answers `DeviceLinkExpiredError`.
 */
export interface DeviceLinkStatusResult
{
    status: DeviceLinkStatus;
    expiresAtMillis: number;
    deviceName?: string;
    platform?: KeyPlatformType;
    /** First bytes of the redeeming key's fingerprint, as the device list truncates it. */
    fingerprintPrefix?: string;
    redeemedAtMillis?: number;
    /** The match and two decoys, in the order drawn at redeem. */
    choices?: number[];
}

export interface PollDeviceLinkParams extends DeviceProvenance
{
    deviceCode: string;
    /** How long this request already waited on the server, from the long-poll middleware. */
    waitedMillis?: number;
}

export interface WaitForDeviceLinkStatusParams extends DeviceLinkParams
{
    /** Longest the issuer is willing to wait, in milliseconds. Capped at `deviceAuth.maxWaitMs`. */
    waitMillis: number;
    signal?: AbortSignal;
}

export interface WaitForDeviceLinkAnswerParams
{
    deviceCode: string;
    /** Longest the new device is willing to wait, in milliseconds. Capped at `deviceAuth.maxWaitMs`. */
    waitMillis: number;
    signal?: AbortSignal;
}

/** How many times a colliding user code is redrawn — see `device-auth.service.ts`. */
const USER_CODE_ATTEMPTS = 3;

/** How often a waiting request re-reads its link on its own — see `device-auth.service.ts`. */
const WAIT_RECHECK_MS = 1000;

/**
 * How many requests may wait on one link at once, the issuer's and the new
 * device's together: one each, and one more for a retry overlapping its own
 * timed-out request. Past this a request is answered at once instead of waiting.
 */
const MAX_WAITERS_PER_RECORD = 3;

/**
 * Whether a link can no longer be acted on, whatever its status says: past its
 * TTL, abandoned by its issuer, or issued by a key that can no longer sign.
 *
 * Judged on every call rather than written at the moment it happens — a revoked
 * key or a passed TTL expires every link it touches without anything having to
 * find those links first.
 */
function isDead(record: DeviceLinkRecord): boolean
{
    return record.status === 'expired'
        || record.expiresAt.getTime() <= Date.now()
        || !record.issuerKeyLive;
}

/**
 * The new device's gate, for redeem and poll: unknown and spent answer alike,
 * and before expiry, so a spent code never reads out that it was once real.
 */
function assertReachable(record: DeviceLinkRecord | null): DeviceLinkRecord
{
    if (!record || record.status === 'consumed')
    {
        throw new DeviceLinkNotFoundError();
    }

    if (isDead(record))
    {
        throw new DeviceLinkExpiredError();
    }

    return record;
}

/**
 * The issuer's gate, for status, confirm, deny and cancel: a link another key
 * issued is unknown to this caller, and that is decided before anything else.
 */
function assertIssuedBy(record: DeviceLinkRecord | null, issuer: DeviceLinkIssuer): DeviceLinkRecord
{
    if (!record || record.issuerUserId !== issuer.userId || record.issuerKeyId !== issuer.keyId)
    {
        throw new DeviceLinkNotFoundError();
    }

    if (isDead(record))
    {
        throw new DeviceLinkExpiredError();
    }

    return record;
}

/**
 * Explain a conditional transition that moved nothing, from the row still there
 * — `refuseMissedTransition` in `device-auth.service.ts`, with the issuing key
 * among the things the database may have refused on.
 *
 * @param moved the refusal owed when the link turns out to have moved on
 */
function refuseMissedTransition(record: DeviceLinkRecord | null, from: DeviceLinkStatus, moved: () => Error): never
{
    if (!record || record.status === 'consumed')
    {
        throw new DeviceLinkNotFoundError();
    }

    if (record.status === from || isDead(record))
    {
        throw new DeviceLinkExpiredError();
    }

    throw moved();
}

/** Confirm, deny and cancel refuse a link the issuer has already decided, the same way. */
function assertAwaitingDecision(record: DeviceLinkRecord): void
{
    if (record.status === 'issued')
    {
        throw new DeviceLinkNotRedeemedError();
    }

    if (record.status !== 'redeemed')
    {
        throw new DeviceLinkAlreadyHandledError();
    }
}

function describeLink(record: DeviceLink): DeviceLinkStatusResult
{
    return {
        status: record.status,
        expiresAtMillis: record.expiresAt.getTime(),
        ...describeDevice(record),
        ...(record.status === 'redeemed' && record.choices ? { choices: record.choices } : {}),
    };
}

function describeDevice(record: DeviceLink): Partial<DeviceLinkStatusResult>
{
    if (!record.redeemedAt || !record.fingerprint)
    {
        return {};
    }

    return {
        deviceName: record.deviceName ?? undefined,
        platform: record.platform ?? undefined,
        fingerprintPrefix: record.fingerprint.slice(0, KEY_FINGERPRINT_PREFIX_LENGTH),
        redeemedAtMillis: record.redeemedAt.getTime(),
    };
}

/**
 * Issue a link from the signed-in device that asked, replacing any link that
 * device still has in play — one live link per issuing key, so a screen that was
 * closed without cancelling leaves nothing behind that a later redeem could use.
 */
export async function issueDeviceLinkService(issuer: DeviceLinkIssuer): Promise<IssueDeviceLinkResult>
{
    // The route's transaction holds this lock through the insert below: a second
    // issue from the same key waits here, then expires the link this one inserts.
    await deviceLinksRepository.lockIssuerKey(issuer.keyId);
    await deviceLinksRepository.expireLiveByIssuerKey(issuer.keyId);

    const expiresAt = new Date(Date.now() + getDeviceLinkConfig().ttlMs);

    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt++)
    {
        const record = await deviceLinksRepository.create({
            linkId: randomUUID(),
            userCode: generateUserCode(),
            issuerUserId: issuer.userId,
            issuerKeyId: issuer.keyId,
            expiresAt,
        });

        // null means the user code was already taken — redraw and retry.
        if (record)
        {
            return {
                linkId: record.linkId,
                userCode: formatUserCode(record.userCode),
                expiresAtMillis: expiresAt.getTime(),
            };
        }
    }

    throw new Error(
        `Could not allocate a unique device link code in ${USER_CODE_ATTEMPTS} attempts. `
        + 'Check the code generator and the user_code unique index.',
    );
}

/**
 * Park a new device's key on the link its code names, and hand back what that
 * device shows and polls with.
 *
 * Public by definition: the caller has no key yet. The code is the only thing it
 * holds, so every refusal that could tell a guesser the code was real — someone
 * redeemed it first, it was already used — is the same NotFound as a code never
 * issued. Only a code that died of age answers Expired, as the state table asks.
 */
export async function redeemDeviceLinkService(params: RedeemDeviceLinkParams): Promise<RedeemDeviceLinkResult>
{
    // Checked now, as `startDeviceAuthService` does: the fingerprint prefix is
    // what the issuer recognises the device by, and a key that cannot sign for
    // its declared algorithm must not reach the issuer's screen at all.
    if (!verifyKeyFingerprint(params.publicKey, params.fingerprint))
    {
        throw new InvalidKeyFingerprintError();
    }

    const algorithm = params.algorithm ?? DEFAULT_KEY_ALGORITHM;

    assertKeyMatchesAlgorithm(params.publicKey, algorithm);

    const userCode = normalizeUserCode(params.userCode);
    const record = assertReachable(await deviceLinksRepository.findByUserCode(userCode));

    if (record.status !== 'issued')
    {
        throw new DeviceLinkNotFoundError();
    }

    const deviceCode = generateDeviceCode();
    const matchNumber = generateMatchNumber();

    // From `issued` only, with the TTL and the issuing key in the statement: of
    // two devices redeeming one code, exactly one parks its key.
    const redeemed = await deviceLinksRepository.redeem(record.id, {
        deviceCodeHash: hashDeviceCode(deviceCode),
        publicKey: params.publicKey,
        keyId: params.keyId,
        fingerprint: params.fingerprint,
        algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
        matchNumber,
        choices: generateChoices(matchNumber),
    });

    if (!redeemed)
    {
        refuseMissedTransition(
            await deviceLinksRepository.findByUserCode(userCode),
            'issued',
            () => new DeviceLinkNotFoundError(),
        );
    }

    return {
        deviceCode,
        matchNumber,
        expiresAtMillis: redeemed.expiresAt.getTime(),
        intervalMillis: getDeviceAuthConfig().intervalMs,
    };
}

/** The issuer asking where its link stands. */
export async function getDeviceLinkStatusService(params: DeviceLinkParams): Promise<DeviceLinkStatusResult>
{
    return describeLink(assertIssuedBy(await deviceLinksRepository.findByLinkId(params.linkId), params.issuer));
}

/**
 * The issuer picked a number.
 *
 * The right one approves the link; any other denies it on the spot, and the
 * refusal is committed before the error answers — there is no second pick. The
 * route is not wrapped in `Transactional()` for exactly that reason: a rollback
 * would undo the denial and hand the issuer another guess.
 *
 * The match number is fixed once a link is redeemed, so comparing against the
 * value read is safe; the transitions still name `redeemed`, so a deny or a
 * cancel landing in between wins or loses cleanly.
 */
export async function confirmDeviceLinkService(params: ConfirmDeviceLinkParams): Promise<DeviceLinkStatusResult>
{
    const record = assertIssuedBy(await deviceLinksRepository.findByLinkId(params.linkId), params.issuer);

    assertAwaitingDecision(record);

    if (params.choice !== record.matchNumber)
    {
        await refuse(record);

        throw new DeviceLinkWrongMatchError();
    }

    // The issuing key is judged again in the statement, under a share lock on its
    // row: an issuer signed out between the read above and now approves nothing.
    const approved = await deviceLinksRepository.approve(record.id);

    if (!approved)
    {
        refuseMissedTransition(
            await deviceLinksRepository.findByLinkId(params.linkId),
            'redeemed',
            () => new DeviceLinkAlreadyHandledError(),
        );
    }

    return describeLink(approved);
}

/** The issuer refused the device, so it is told no instead of timing out. */
export async function denyDeviceLinkService(params: DeviceLinkParams): Promise<DeviceLinkStatusResult>
{
    const record = assertIssuedBy(await deviceLinksRepository.findByLinkId(params.linkId), params.issuer);

    assertAwaitingDecision(record);

    return describeLink(await refuse(record));
}

async function refuse(record: DeviceLinkRecord): Promise<DeviceLink>
{
    const denied = await deviceLinksRepository.deny(record.id);

    if (!denied)
    {
        refuseMissedTransition(
            await deviceLinksRepository.findByLinkId(record.linkId),
            'redeemed',
            () => new DeviceLinkAlreadyHandledError(),
        );
    }

    return denied;
}

/**
 * The issuer closed its screen before letting anyone in. The link is expired, so
 * a device holding its code — or already showing a match number — is told so.
 */
export async function cancelDeviceLinkService(params: DeviceLinkParams): Promise<DeviceLinkStatusResult>
{
    const record = assertIssuedBy(await deviceLinksRepository.findByLinkId(params.linkId), params.issuer);

    if (record.status !== 'issued' && record.status !== 'redeemed')
    {
        throw new DeviceLinkAlreadyHandledError();
    }

    const cancelled = await deviceLinksRepository.cancel(record.id);

    if (!cancelled)
    {
        refuseMissedTransition(
            await deviceLinksRepository.findByLinkId(params.linkId),
            record.status,
            () => new DeviceLinkAlreadyHandledError(),
        );
    }

    return describeLink(cancelled);
}

/**
 * The new device asking whether the issuer has answered.
 *
 * Approved is the one branch with a side effect, and it is device-code login's
 * one-shot: the link is spent by a conditional update naming `approved` — and the
 * issuing key, so a link whose issuer signed out after confirming registers
 * nothing — and of two polls arriving together exactly one registers the key.
 */
export async function pollDeviceLinkService(params: PollDeviceLinkParams): Promise<PollDeviceAuthResult>
{
    const deviceCodeHash = hashDeviceCode(params.deviceCode);
    const record = assertReachable(await deviceLinksRepository.findByDeviceCodeHash(deviceCodeHash));

    if (record.status === 'denied')
    {
        throw new DeviceLinkDeniedError();
    }

    if (record.status === 'redeemed')
    {
        return {
            status: 'pending',
            intervalMillis: Math.max(0, getDeviceAuthConfig().intervalMs - (params.waitedMillis ?? 0)),
        };
    }

    const consumed = await deviceLinksRepository.consumeApproved(deviceCodeHash);

    if (!consumed)
    {
        refuseMissedTransition(
            await deviceLinksRepository.findByDeviceCodeHash(deviceCodeHash),
            'approved',
            () => new DeviceLinkNotFoundError(),
        );
    }

    return {
        status: 'approved',
        ...await completeDeviceLogin({
            userId: consumed.issuerUserId,
            key: parkedKey(consumed),
            channel: 'device-link',
            provenance: params,
            missingAccount: () => new DeviceLinkNotFoundError(),
        }),
    };
}

/**
 * The key a consumed link parked. Every column is set by the redeem that any
 * consumed link went through, but they are nullable, so the impossible case is
 * refused rather than coerced.
 */
function parkedKey(link: DeviceLink): ParkedDeviceKey
{
    const { keyId, publicKey, fingerprint, algorithm } = link;

    if (!keyId || !publicKey || !fingerprint || !algorithm)
    {
        throw new DeviceLinkNotFoundError();
    }

    return { keyId, publicKey, fingerprint, algorithm, deviceName: link.deviceName, platform: link.platform };
}

/**
 * Hold the issuer's `status` while its link waits on the other device: until a
 * device redeems the code, or until the redeeming device collects its approval.
 *
 * Called by the status route's long-poll middleware. A link another key issued
 * is not waited on — the judgement that follows refuses it.
 *
 * @returns milliseconds the request waited; 0 when it did not wait at all
 */
export async function waitForDeviceLinkStatusService(params: WaitForDeviceLinkStatusParams): Promise<number>
{
    return holdWhileUnmoved(
        () => deviceLinksRepository.findByLinkId(params.linkId),
        record => isIssuedBy(record, params.issuer) && (record.status === 'issued' || record.status === 'approved'),
        params.waitMillis,
        params.signal,
    );
}

/**
 * Hold the new device's `poll` while its link waits on the issuer's pick.
 *
 * Called by the poll route's long-poll middleware; see
 * `waitForDeviceAuthAnswerService`, which this mirrors.
 *
 * @returns milliseconds the request waited; 0 when it did not wait at all
 */
export async function waitForDeviceLinkAnswerService(params: WaitForDeviceLinkAnswerParams): Promise<number>
{
    const deviceCodeHash = hashDeviceCode(params.deviceCode);

    return holdWhileUnmoved(
        () => deviceLinksRepository.findByDeviceCodeHash(deviceCodeHash),
        record => record.status === 'redeemed',
        params.waitMillis,
        params.signal,
    );
}

function isIssuedBy(record: DeviceLinkRecord, issuer: DeviceLinkIssuer): boolean
{
    return record.issuerUserId === issuer.userId && record.issuerKeyId === issuer.keyId;
}

/**
 * Hold a request while its link stays alive and in the state it was found in.
 *
 * The reads here only decide whether to keep waiting, never the answer — the
 * route judges the link again once the wait ends. Every way out hands the request
 * on to be judged and none throws: the TTL, the wait running out, the caller
 * hanging up, shutdown (so the answer is the current one rather than a cut
 * connection), and a failed read, whose error the judgement repeats inside the
 * route where it becomes an answer a client can read.
 */
async function holdWhileUnmoved(
    read: () => Promise<DeviceLinkRecord | null>,
    waitable: (record: DeviceLinkRecord) => boolean,
    waitMillis: number,
    signal?: AbortSignal,
): Promise<number>
{
    const requested = Math.min(waitMillis, getDeviceAuthConfig().maxWaitMs);
    const record = requested > 0 ? await read().catch(() => null) : null;

    if (!record || isDead(record) || !waitable(record) || waitingOnDeviceLink(record.id) >= MAX_WAITERS_PER_RECORD)
    {
        return 0;
    }

    const startedAt = Date.now();
    const deadline = Math.min(startedAt + requested, record.expiresAt.getTime());
    const unmoved = async () =>
    {
        const current = await read().catch(() => null);

        return current !== null && !isDead(current) && current.status === record.status;
    };

    await holdDeviceLinkWait(record.id, () => waitUntil(record.id, deadline, unmoved, signal));

    return Date.now() - startedAt;
}

/** Park, re-read, repeat — until the link moves, the deadline passes, or the wait has to end. */
async function waitUntil(id: number, deadline: number, unmoved: () => Promise<boolean>, signal?: AbortSignal): Promise<void>
{
    while (!signal?.aborted && !getShutdownManager().isShuttingDown())
    {
        const remaining = deadline - Date.now();

        if (remaining <= 0)
        {
            return;
        }

        await waitForDeviceLinkMove(id, Math.min(remaining, WAIT_RECHECK_MS), signal);

        if (!await unmoved())
        {
            return;
        }
    }
}
