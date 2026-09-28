/**
 * @spfn/notification - Push Channel (FCM)
 *
 * A push to an owner goes to every active device they registered, unless the
 * caller narrows it. Each device gets its own history row, its own
 * idempotency claim and its own locale.
 */

import type {
    SendPushParams,
    PushProvider,
    PushMessage,
    PushResult,
    PushDeviceResult,
    PushTarget,
    PushOptions,
    PushProviderResult,
} from './types';
import type { PushPlatform } from '../../entities';
import { fcmProvider } from './providers/fcm';
import { env, isHistoryContentStored } from '../../config';
import { renderTemplateChannel, getTemplate } from '../../templates';
import { historyRecipient, maskToken, scrubSendResult } from '../../privacy';
import { idempotencyKeyError } from '../../services/idempotency.service';
import { listPushDevices, invalidatePushToken } from '../../services/push-device.service';
import { openHistoryRow, closeHistoryRow } from '../history';
import { runWithConcurrency } from '../concurrency';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:push');

export type * from './types';
export { createFcmProvider, buildFcmMessage, type FcmProviderConfig, type FcmCredentials } from './providers/fcm';

/**
 * FCM's limit on a message's notification + data payload
 */
export const MAX_PUSH_PAYLOAD_BYTES = 4096;

const providers: Record<string, PushProvider> = {
    fcm: fcmProvider,
};

/**
 * Register a custom push provider (or replace `fcm`, e.g. in tests)
 */
export function registerPushProvider(provider: PushProvider): void
{
    providers[provider.name] = provider;
}

function getProvider(): PushProvider
{
    const name = env.SPFN_NOTIFICATION_PUSH_PROVIDER || 'fcm';
    const provider = providers[name];

    if (!provider)
    {
        throw new Error(`Push provider not found: ${name}`);
    }

    return provider;
}

/**
 * A device a push is addressed to
 */
interface PushTargetDevice
{
    token: string;
    platform?: PushPlatform;
    deviceId?: string;
    locale?: string;
}

/**
 * Send a push. Result per device, plus counts; `success` only when every
 * device succeeded. An owner with no active device is `success: false`,
 * `error: 'no_devices'`, and nothing is sent.
 */
export async function sendPush(params: SendPushParams): Promise<PushResult>
{
    const keyError = idempotencyKeyError(params.idempotencyKey);

    if (keyError)
    {
        return { ...summarize([], keyError), retryable: false };
    }

    const targets = await resolveTargets(params.to);

    if (targets.length === 0)
    {
        return { ...summarize([], 'no_devices'), retryable: false };
    }

    const provider = getProvider();
    const results = await runWithConcurrency(targets, target => sendToDevice(params, target, provider));

    return summarize(results);
}

async function resolveTargets(to: PushTarget): Promise<PushTargetDevice[]>
{
    if ('ownerId' in to)
    {
        const devices = await listPushDevices(to.ownerId, to.devices);

        return devices.map(device => ({
            token: device.token,
            platform: device.platform,
            deviceId: device.deviceId ?? undefined,
            locale: device.locale ?? undefined,
        }));
    }

    return ('token' in to ? [to.token] : to.tokens).map(token => ({ token }));
}

/**
 * Content for one device, or why it cannot be sent
 */
type DeviceContent =
    | { title?: string; body?: string; data?: Record<string, string>; locale?: string }
    | { error: string };

function contentFor(params: SendPushParams, target: PushTargetDevice): DeviceContent
{
    let content: DeviceContent = { title: params.title, body: params.body, data: params.data };

    if (params.template)
    {
        const rendered = renderTemplateChannel(params.template, params.templateData ?? {}, 'push', target.locale ?? params.locale);

        if ('error' in rendered)
        {
            return rendered;
        }

        content = rendered.content
            ? { ...rendered.content, data: { ...rendered.content.data, ...params.data }, locale: rendered.locale }
            : content;
    }

    return validateContent(content, params.options);
}

function validateContent(content: Exclude<DeviceContent, { error: string }>, options?: PushOptions): DeviceContent
{
    const hasData = content.data !== undefined && Object.keys(content.data).length > 0;

    if (!content.title && !content.body && !(options?.contentAvailable && hasData))
    {
        return { error: 'Push needs a title or body (or contentAvailable with data)' };
    }

    const nonString = Object.entries(content.data ?? {}).find(([, value]) => typeof value !== 'string');

    if (nonString)
    {
        return { error: `Push data values must be strings (${nonString[0]})` };
    }

    const size = Buffer.byteLength(JSON.stringify({ title: content.title, body: content.body, data: content.data }));

    return size > MAX_PUSH_PAYLOAD_BYTES
        ? { error: `Push payload is ${size} bytes; FCM allows ${MAX_PUSH_PAYLOAD_BYTES}` }
        : content;
}

async function sendToDevice(
    params: SendPushParams,
    target: PushTargetDevice,
    provider: PushProvider,
): Promise<PushDeviceResult>
{
    const identity = { token: maskToken(target.token), deviceId: target.deviceId, platform: target.platform };
    const content = contentFor(params, target);

    if ('error' in content)
    {
        return { ...identity, success: false, error: content.error };
    }

    const opened = await openHistoryRow(() => pushHistoryRow(params, target, content, provider.name), params.idempotencyKey, log);

    if (opened.stop)
    {
        return { ...identity, ...opened.stop };
    }

    const message: PushMessage = { ...content, token: target.token, platform: target.platform, options: params.options, fcm: params.fcm };
    const answer = await sendSafely(provider, message);
    const result = scrubSendResult({ success: answer.success, messageId: answer.messageId, error: answer.error });

    logOutcome(identity.token, result, answer.invalidToken);

    if (answer.invalidToken)
    {
        await invalidatePushToken(target.token, answer.invalidToken)
            .catch(error => log.warn('Failed to invalidate push token', error as Error));
    }

    await closeHistoryRow(opened.historyId, result, params.idempotencyKey !== undefined, log);

    return { ...identity, ...result, retryable: answer.retryable };
}

/**
 * A provider that throws (network error, credentials) is a failed, retryable
 * send — never a rejected sendPush. The history row then closes as `failed`,
 * so a retry with the same idempotency key can take it over. The thrown text
 * is not passed on: credential errors can quote the secret.
 */
async function sendSafely(provider: PushProvider, message: PushMessage): Promise<PushProviderResult>
{
    try
    {
        return await provider.send(message);
    }
    catch (error)
    {
        log.error('Push provider threw', { provider: provider.name, error: (error as Error).name });

        return { success: false, error: `${provider.name} request failed (${(error as Error).name})`, retryable: true };
    }
}

function pushHistoryRow(
    params: SendPushParams,
    target: PushTargetDevice,
    content: { title?: string; body?: string; data?: Record<string, string>; locale?: string },
    providerName: string,
)
{
    const sensitive = params.sensitive
        ?? (params.template ? getTemplate(params.template)?.sensitive : undefined)
        ?? false;
    const storePayload = !sensitive && isHistoryContentStored();

    return {
        channel: 'push' as const,
        recipient: historyRecipient([target.token]),
        templateName: params.template,
        templateData: storePayload ? { ...params.templateData, data: content.data } : undefined,
        subject: sensitive ? undefined : content.title,
        content: storePayload ? content.body : undefined,
        providerName,
        locale: content.locale,
    };
}

function logOutcome(token: string, result: { success: boolean; messageId?: string; error?: string }, invalid?: string): void
{
    if (result.success)
    {
        log.info('Push sent', { token, messageId: result.messageId });

        return;
    }

    log.error('Push send failed', { token, error: result.error, invalidated: invalid });
}

function summarize(results: PushDeviceResult[], error?: string): PushResult
{
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;
    const errors = results.filter(r => r.error).map(r => `${r.token}: ${r.error}`);

    return {
        success: error === undefined && failureCount === 0,
        error: error ?? (errors.join('; ') || undefined),
        deduplicated: results.some(r => r.deduplicated) || undefined,
        // Worth retrying only when some failed device might succeed next time.
        retryable: failureCount > 0 ? results.some(r => !r.success && r.retryable) : undefined,
        results,
        successCount,
        failureCount,
    };
}

export interface BulkPushResult
{
    results: PushResult[];
    successCount: number;
    failureCount: number;
}

/**
 * Send several pushes, `concurrency` at a time (default 10). An item counts
 * as a success when every one of its devices succeeded.
 */
export async function sendPushBulk(
    items: SendPushParams[],
    options?: { concurrency?: number },
): Promise<BulkPushResult>
{
    const results = await runWithConcurrency(items, sendPush, options?.concurrency ?? 10);
    const successCount = results.filter(r => r.success).length;

    return { results, successCount, failureCount: results.length - successCount };
}
