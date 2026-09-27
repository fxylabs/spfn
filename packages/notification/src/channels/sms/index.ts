/**
 * @spfn/notification - SMS Channel
 */

import type { SendSMSParams, SMSProvider, InternalSendSMSParams } from './types';
import type { SendResult } from '../types';
import { awsSnsProvider } from './providers/aws-sns';
import { env, isHistoryContentStored } from '../../config';
import { renderTemplate, hasTemplate, getTemplate } from '../../templates';
import { maskRecipients, maskPhone, historyRecipient, scrubSendResult } from '../../privacy';
import {
    markManySent,
    markManyFailed,
} from '../../services/notification.service';
import { idempotencyKeyError } from '../../services/idempotency.service';
import { openHistoryRow, closeHistoryRow, openBulkHistoryRows, splitStopped, type HistoryRowData } from '../history';
import { runWithConcurrency } from '../concurrency';
import { sendBulkSmsItemJob } from '../../jobs/send-bulk-sms-item';
import { normalizePhoneNumber } from './utils';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:sms');

export type { SendSMSParams, SMSProvider, InternalSendSMSParams };
export { normalizePhoneNumber };

/**
 * Available SMS providers
 */
const providers: Record<string, SMSProvider> = {
    'aws-sns': awsSnsProvider,
};

/**
 * Register custom SMS provider
 */
export function registerSMSProvider(provider: SMSProvider): void
{
    providers[provider.name] = provider;
}

/**
 * Get current SMS provider
 */
function getProvider(): SMSProvider
{
    const providerName = env.SPFN_NOTIFICATION_SMS_PROVIDER || 'aws-sns';
    const provider = providers[providerName];

    if (!provider)
    {
        throw new Error(`SMS provider not found: ${providerName}`);
    }

    return provider;
}

/**
 * Send SMS
 */
export async function sendSMS(params: SendSMSParams): Promise<SendResult>
{
    return deliverSMS(params);
}

/**
 * Send an SMS. `scheduledRowId` is the history row a scheduled job already
 * owns: no per-recipient rows are opened or closed, and the job records the
 * outcome.
 *
 * @internal
 */
export async function deliverSMS(params: SendSMSParams, scheduledRowId?: number): Promise<SendResult>
{
    const keyError = scheduledRowId ? undefined : idempotencyKeyError(params.idempotencyKey);

    if (keyError)
    {
        return { success: false, error: keyError };
    }

    // Prepare recipients
    const recipients = Array.isArray(params.to) ? params.to : [params.to];

    // Prepare content
    let message = params.message;

    // Render template if specified
    if (params.template)
    {
        if (!hasTemplate(params.template))
        {
            log.warn(`Template not found: ${params.template}`);

            return {
                success: false,
                error: `Template not found: ${params.template}`,
            };
        }

        const rendered = renderTemplate(params.template, params.data || {}, 'sms');

        if (rendered.sms)
        {
            message = rendered.sms.message;
        }
    }

    // Validate required fields
    if (!message)
    {
        log.warn('SMS message is required', { to: maskRecipients(recipients) });

        return {
            success: false,
            error: 'SMS message is required',
        };
    }

    // Send to each recipient
    const provider = getProvider();
    // Send one recipient: open its history row (the idempotency claim when keyed), send, record.
    const sendOne = async (recipient: string): Promise<SendResult> =>
    {
        const normalizedPhone = normalizePhoneNumber(recipient);

        const internalParams: InternalSendSMSParams = {
            to: normalizedPhone,
            message,
        };

        const opened = scheduledRowId
            ? {}
            : await openHistoryRow(() => smsHistoryRow(params, normalizedPhone, message, provider.name), params.idempotencyKey, log);

        if (opened.stop)
        {
            return opened.stop;
        }

        const result = scrubSendResult(await provider.send(internalParams));

        if (result.success)
        {
            log.info('SMS sent', { to: maskPhone(normalizedPhone), messageId: result.messageId });
        }
        else
        {
            log.error('SMS send failed', { to: maskPhone(normalizedPhone), error: result.error });
        }

        await closeHistoryRow(opened.historyId, result, params.idempotencyKey !== undefined, log);

        return result;
    };

    // Process recipients concurrently (was a fully sequential for-of loop).
    const results: SendResult[] = await runWithConcurrency(recipients, sendOne);

    // Return aggregated result
    const allSuccess = results.every(r => r.success);
    const messageIds = results
        .filter(r => r.messageId)
        .map(r => r.messageId)
        .join(',');
    const errors = results
        .filter(r => r.error)
        .map(r => r.error)
        .join('; ');

    return {
        success: allSuccess,
        messageId: messageIds || undefined,
        error: errors || undefined,
        deduplicated: results.some(r => r.deduplicated) || undefined,
    };
}

function smsHistoryRow(params: SendSMSParams, phone: string, message: string, providerName: string): HistoryRowData
{
    const sensitive = params.sensitive
        ?? (params.template ? getTemplate(params.template)?.sensitive : undefined)
        ?? false;
    const storePayload = !sensitive && isHistoryContentStored();

    return {
        channel: 'sms',
        recipient: historyRecipient([phone]),
        templateName: params.template,
        templateData: storePayload ? params.data : undefined,
        content: storePayload ? message : undefined,
        providerName,
    };
}

/**
 * Bulk SMS result
 */
export interface BulkSMSResult
{
    results: SendResult[];
    successCount: number;
    failureCount: number;
    batchId: string;
}

/**
 * Prepared SMS item (after template rendering + validation + recipient expansion)
 */
interface PreparedSMS
{
    index: number;
    phone: string;
    message: string;
    template?: string;
    data?: Record<string, unknown>;
    sensitive: boolean;
    idempotencyKey?: string;
}

/**
 * Bulk SMS options
 */
export interface BulkSMSOptions
{
    concurrency?: number;
    distributed?: boolean;
}

/**
 * Send bulk SMS with batch DB insert and concurrent sending.
 *
 * @param items - SMS items to send
 * @param options - concurrency, distributed
 */
export async function sendSMSBulk(
    items: SendSMSParams[],
    options?: BulkSMSOptions,
): Promise<BulkSMSResult>
{
    if (items.length === 0)
    {
        return { results: [], successCount: 0, failureCount: 0, batchId: '' };
    }

    const batchId = crypto.randomUUID();
    const provider = getProvider();

    // 1. Validate, render templates, expand recipients
    const prepared: PreparedSMS[] = [];
    const earlyFailures: { index: number; result: SendResult }[] = [];

    for (let i = 0; i < items.length; i++)
    {
        const item = items[i];
        const recipients = Array.isArray(item.to) ? item.to : [item.to];
        const keyError = idempotencyKeyError(item.idempotencyKey);

        if (keyError)
        {
            earlyFailures.push({ index: i, result: { success: false, error: keyError } });
            continue;
        }

        let message = item.message;

        if (item.template)
        {
            if (!hasTemplate(item.template))
            {
                earlyFailures.push({ index: i, result: { success: false, error: `Template not found: ${item.template}` } });
                continue;
            }

            const rendered = renderTemplate(item.template, item.data || {}, 'sms');

            if (rendered.sms)
            {
                message = rendered.sms.message;
            }
        }

        if (!message)
        {
            earlyFailures.push({ index: i, result: { success: false, error: 'SMS message is required' } });
            continue;
        }

        const sensitive = item.sensitive
            ?? (item.template ? getTemplate(item.template)?.sensitive : undefined)
            ?? false;

        for (const recipient of recipients)
        {
            prepared.push({
                index: i,
                phone: normalizePhoneNumber(recipient),
                message,
                template: item.template,
                data: item.data,
                sensitive,
                idempotencyKey: item.idempotencyKey,
            });
        }
    }

    // 2. Open history rows (one per recipient); a spent key stops that recipient
    const storeContent = isHistoryContentStored();
    const opened = await openBulkHistoryRows(prepared.map(p =>
    {
        const storePayload = !p.sensitive && storeContent;

        return {
            buildRow: () => ({
                channel: 'sms' as const,
                recipient: historyRecipient([p.phone]),
                templateName: p.template,
                templateData: storePayload ? p.data : undefined,
                content: storePayload ? p.message : undefined,
                providerName: provider.name,
                batchId,
            }),
            idempotencyKey: p.idempotencyKey,
        };
    }), log);
    const { sendable, historyIds, stopped } = splitStopped(prepared, opened);

    // 3. Distributed mode: enqueue to pg-boss
    if (options?.distributed)
    {
        const jobInputs = sendable.map((p, i) => ({
            notificationId: historyIds[i] ?? 0,
            to: p.phone,
            message: p.message,
        }));

        await sendBulkSmsItemJob.sendBatch(jobInputs);

        log.info('Bulk SMS enqueued for distributed processing', {
            batchId,
            total: items.length,
            enqueued: sendable.length,
            earlyFailures: earlyFailures.length,
            deduplicated: stopped.length,
        });

        const pending = sendable.map(p => ({ index: p.index, result: { success: true, messageId: `pending:${batchId}` } }));

        return { ...aggregateSmsResults(items.length, earlyFailures, [...stopped, ...pending]), batchId };
    }

    // 4. In-process mode: send with concurrency control
    const concurrency = options?.concurrency ?? 10;

    const sendResults = await runWithConcurrency(
        sendable,
        (p) => provider.send({ to: p.phone, message: p.message }).then(scrubSendResult),
        concurrency,
    );

    // 5. Log + update history
    const sentItems: Array<{ id: number; providerMessageId?: string }> = [];
    const failedItems: Array<{ id: number; errorMessage: string }> = [];

    for (let i = 0; i < sendable.length; i++)
    {
        const { phone } = sendable[i];
        const result = sendResults[i];

        if (result.success)
        {
            log.info('SMS sent', { to: maskPhone(phone), messageId: result.messageId });
        }
        else
        {
            log.error('SMS send failed', { to: maskPhone(phone), error: result.error });
        }

        const historyId = historyIds[i];

        if (historyId)
        {
            if (result.success)
            {
                sentItems.push({ id: historyId, providerMessageId: result.messageId });
            }
            else
            {
                failedItems.push({ id: historyId, errorMessage: result.error || 'Unknown error' });
            }
        }
    }

    await Promise.all([
        markManySent(sentItems).catch(err => log.warn('Failed to update notification history', err)),
        markManyFailed(failedItems).catch(err => log.warn('Failed to update notification history', err)),
    ]);

    // 6. Aggregate results per original item
    const sent = sendable.map((p, i) => ({ index: p.index, result: sendResults[i] }));

    return { ...aggregateSmsResults(items.length, earlyFailures, [...stopped, ...sent]), batchId };
}

/**
 * Fold per-recipient results into one result per original item.
 */
function aggregateSmsResults(
    itemCount: number,
    earlyFailures: { index: number; result: SendResult }[],
    perRecipient: { index: number; result: SendResult }[],
): Omit<BulkSMSResult, 'batchId'>
{
    const results: SendResult[] = new Array(itemCount);
    const byItem = new Map<number, SendResult[]>();

    for (const { index, result } of earlyFailures)
    {
        results[index] = result;
    }

    for (const { index, result } of perRecipient)
    {
        byItem.set(index, [...(byItem.get(index) ?? []), result]);
    }

    for (const [index, itemResults] of byItem)
    {
        const messageIds = itemResults.filter(r => r.messageId).map(r => r.messageId).join(',');
        const errors = itemResults.filter(r => r.error).map(r => r.error).join('; ');

        results[index] = {
            success: itemResults.every(r => r.success),
            messageId: messageIds || undefined,
            error: errors || undefined,
            deduplicated: itemResults.some(r => r.deduplicated) || undefined,
        };
    }

    const successCount = results.filter(r => r?.success).length;

    return { results, successCount, failureCount: results.filter(Boolean).length - successCount };
}
