/**
 * @spfn/notification - Slack Channel
 */

import type { SendSlackParams, SlackProvider, InternalSendSlackParams } from './types';
import type { SendResult } from '../types';
import { webhookProvider } from './providers/webhook';
import { env } from '../../config';
import { renderTemplateChannel } from '../../templates';
import { idempotencyKeyError } from '../../services/idempotency.service';
import { openHistoryRow, closeHistoryRow, openBulkHistoryRows, splitStopped } from '../history';
import {
    markManySent,
    markManyFailed,
} from '../../services/notification.service';
import { scrubSendResult } from '../../privacy';
import { runWithConcurrency } from '../concurrency';
import { sendBulkSlackItemJob } from '../../jobs/send-bulk-slack-item';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:slack');

export type { SendSlackParams, SlackProvider, InternalSendSlackParams };

/**
 * Available Slack providers
 */
const providers: Record<string, SlackProvider> = {
    'webhook': webhookProvider,
};

/**
 * Register custom Slack provider
 */
export function registerSlackProvider(provider: SlackProvider): void
{
    providers[provider.name] = provider;
}

/**
 * Get current Slack provider
 */
function getProvider(): SlackProvider
{
    return providers['webhook'];
}

/**
 * Resolve webhook URL from params → config → env
 */
function resolveWebhookUrl(params: SendSlackParams): string | undefined
{
    return params.webhookUrl
        || env.SPFN_NOTIFICATION_SLACK_WEBHOOK_URL;
}

/**
 * Send Slack message
 */
export async function sendSlack(params: SendSlackParams): Promise<SendResult>
{
    const keyError = idempotencyKeyError(params.idempotencyKey);

    if (keyError)
    {
        return { success: false, error: keyError };
    }

    const webhookUrl = resolveWebhookUrl(params);

    if (!webhookUrl)
    {
        log.warn('Slack webhook URL is required');

        return {
            success: false,
            error: 'Slack webhook URL is required. Set SPFN_NOTIFICATION_SLACK_WEBHOOK_URL or pass webhookUrl.',
        };
    }

    // Prepare content
    let text = params.text;
    let blocks = params.blocks;

    let usedLocale: string | undefined;

    // Render template if specified
    if (params.template)
    {
        const rendered = renderTemplateChannel(params.template, params.data || {}, 'slack', params.locale);

        if ('error' in rendered)
        {
            log.warn(rendered.error);

            return {
                success: false,
                error: rendered.error,
            };
        }

        if (rendered.content)
        {
            text = rendered.content.text;
            blocks = rendered.content.blocks;
        }

        usedLocale = rendered.locale;
    }

    // Validate required fields
    if (!text && !blocks)
    {
        log.warn('Slack message requires text or blocks');

        return {
            success: false,
            error: 'Slack message requires text or blocks',
        };
    }

    // Build internal params
    const internalParams: InternalSendSlackParams = {
        webhookUrl,
        text,
        blocks,
    };

    // Get provider
    const provider = getProvider();

    const opened = await openHistoryRow(() => ({
        channel: 'slack',
        locale: usedLocale,
        recipient: webhookUrl,
        templateName: params.template,
        templateData: params.data,
        content: text,
        providerName: provider.name,
    }), params.idempotencyKey, log);

    if (opened.stop)
    {
        return opened.stop;
    }

    // Send via provider
    const result = scrubSendResult(await provider.send(internalParams));

    if (result.success)
    {
        log.info('Slack message sent');
    }
    else
    {
        log.error('Slack send failed', { error: result.error });
    }

    await closeHistoryRow(opened.historyId, result, params.idempotencyKey !== undefined, log);

    return result;
}

/**
 * Bulk Slack result
 */
export interface BulkSlackResult
{
    results: SendResult[];
    successCount: number;
    failureCount: number;
    batchId: string;
}

/**
 * Prepared Slack item (after template rendering + validation)
 */
interface PreparedSlack
{
    index: number;
    params: InternalSendSlackParams;
    webhookUrl: string;
    template?: string;
    data?: Record<string, unknown>;
    text?: string;
    idempotencyKey?: string;
    locale?: string;
    /** Distributed mode: the token the item's job claims its row with. */
    claimToken?: string;
}

/**
 * Bulk Slack options
 */
export interface BulkSlackOptions
{
    concurrency?: number;
    distributed?: boolean;
}

/**
 * Send bulk Slack messages with batch DB insert and concurrent sending.
 *
 * @param items - Slack items to send
 * @param options - concurrency, distributed
 */
export async function sendSlackBulk(
    items: SendSlackParams[],
    options?: BulkSlackOptions,
): Promise<BulkSlackResult>
{
    if (items.length === 0)
    {
        return { results: [], successCount: 0, failureCount: 0, batchId: '' };
    }

    const batchId = crypto.randomUUID();
    const provider = getProvider();

    // 1. Validate and prepare all items
    const prepared: PreparedSlack[] = [];
    const earlyFailures: { index: number; result: SendResult }[] = [];

    for (let i = 0; i < items.length; i++)
    {
        const item = items[i];
        const webhookUrl = resolveWebhookUrl(item);
        const keyError = idempotencyKeyError(item.idempotencyKey);

        if (keyError)
        {
            earlyFailures.push({ index: i, result: { success: false, error: keyError } });
            continue;
        }

        if (!webhookUrl)
        {
            earlyFailures.push({ index: i, result: { success: false, error: 'Slack webhook URL is required. Set SPFN_NOTIFICATION_SLACK_WEBHOOK_URL or pass webhookUrl.' } });
            continue;
        }

        let text = item.text;
        let blocks = item.blocks;

        let usedLocale: string | undefined;

        if (item.template)
        {
            const rendered = renderTemplateChannel(item.template, item.data || {}, 'slack', item.locale);

            if ('error' in rendered)
            {
                earlyFailures.push({ index: i, result: { success: false, error: rendered.error } });
                continue;
            }

            if (rendered.content)
            {
                text = rendered.content.text;
                blocks = rendered.content.blocks;
            }

            usedLocale = rendered.locale;
        }

        if (!text && !blocks)
        {
            earlyFailures.push({ index: i, result: { success: false, error: 'Slack message requires text or blocks' } });
            continue;
        }

        prepared.push({
            index: i,
            params: { webhookUrl, text, blocks },
            webhookUrl,
            template: item.template,
            data: item.data,
            text,
            idempotencyKey: item.idempotencyKey,
            locale: usedLocale,
        });
    }

    // A queued item may only send the row it was enqueued for (see claimNotificationForJob).
    if (options?.distributed)
    {
        for (const p of prepared)
        {
            p.claimToken = crypto.randomUUID();
        }
    }

    // 2. Open history rows; a spent idempotency key stops its item here
    const opened = await openBulkHistoryRows(prepared.map(p => ({
        buildRow: () => ({
            channel: 'slack' as const,
            locale: p.locale,
            recipient: p.webhookUrl,
            templateName: p.template,
            templateData: p.data,
            content: p.text,
            providerName: provider.name,
            batchId,
            claimToken: p.claimToken,
        }),
        idempotencyKey: p.idempotencyKey,
    })), log);
    const { sendable, historyIds, stopped } = splitStopped(prepared, opened);
    const settled = [...earlyFailures, ...stopped];
    const settledSuccesses = stopped.filter(s => s.result.success).length;

    // 3. Distributed mode: enqueue to pg-boss
    if (options?.distributed)
    {
        const jobInputs = sendable.map((p, i) => ({
            notificationId: historyIds[i] ?? 0,
            claimToken: p.claimToken,
            webhookUrl: p.webhookUrl,
            text: p.text,
            blocks: p.params.blocks,
        }));

        await sendBulkSlackItemJob.sendBatch(jobInputs);

        log.info('Bulk Slack enqueued for distributed processing', {
            batchId,
            total: items.length,
            enqueued: sendable.length,
            earlyFailures: earlyFailures.length,
            deduplicated: stopped.length,
        });

        const results: SendResult[] = new Array(items.length);

        for (const { index, result } of settled)
        {
            results[index] = result;
        }

        for (const p of sendable)
        {
            results[p.index] = { success: true, messageId: `pending:${batchId}` };
        }

        return {
            results,
            successCount: sendable.length + settledSuccesses,
            failureCount: settled.length - settledSuccesses,
            batchId,
        };
    }

    // 4. In-process mode: send with concurrency control
    const concurrency = options?.concurrency ?? 10;

    const sendResults = await runWithConcurrency(
        sendable,
        (p) => provider.send(p.params).then(scrubSendResult),
        concurrency,
    );

    // 5. Build results + update history records
    const results: SendResult[] = new Array(items.length);
    let successCount = settledSuccesses;
    let failureCount = settled.length - settledSuccesses;

    for (const { index, result } of settled)
    {
        results[index] = result;
    }

    const sentItems: Array<{ id: number; providerMessageId?: string }> = [];
    const failedItems: Array<{ id: number; errorMessage: string }> = [];

    for (let i = 0; i < sendable.length; i++)
    {
        const { index } = sendable[i];
        const result = sendResults[i];
        results[index] = result;

        if (result.success)
        {
            successCount++;
            log.info('Slack message sent');
        }
        else
        {
            failureCount++;
            log.error('Slack send failed', { error: result.error });
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

    return { results, successCount, failureCount, batchId };
}
