/**
 * @spfn/notification - Email Channel
 */

import type { SendEmailParams, EmailProvider, InternalSendEmailParams } from './types';
import type { SendResult } from '../types';
import { awsSesProvider } from './providers/aws-ses';
import { getEmailFrom, getEmailReplyTo, env, isHistoryContentStored, isTrackingEnabled, getTrackingBaseUrl } from '../../config';
import { processTrackingHtml } from '../../tracking/processor';
import { renderTemplate, hasTemplate, getTemplate } from '../../templates';
import { maskRecipients, historyRecipient, scrubSendResult } from '../../privacy';
import {
    markManySent,
    markManyFailed,
} from '../../services/notification.service';
import { idempotencyKeyError } from '../../services/idempotency.service';
import { openHistoryRow, closeHistoryRow, openBulkHistoryRows, splitStopped, type HistoryRowData } from '../history';
import { runWithConcurrency } from '../concurrency';
import { sendBulkEmailItemJob } from '../../jobs/send-bulk-email-item';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:email');

export type { SendEmailParams, EmailProvider, InternalSendEmailParams };

/**
 * Available email providers
 */
const providers: Record<string, EmailProvider> = {
    'aws-ses': awsSesProvider,
};

/**
 * Register custom email provider
 */
export function registerEmailProvider(provider: EmailProvider): void
{
    providers[provider.name] = provider;
}

/**
 * Get current email provider
 */
function getProvider(): EmailProvider
{
    const providerName = env.SPFN_NOTIFICATION_EMAIL_PROVIDER || 'aws-ses';
    const provider = providers[providerName];

    if (!provider)
    {
        throw new Error(`Email provider not found: ${providerName}`);
    }

    return provider;
}

/**
 * Whether this send's rendered content must stay out of the history row:
 * per-send flag first, then the template's own declaration.
 */
function resolveSensitive(params: Pick<SendEmailParams, 'sensitive' | 'template'>): boolean
{
    if (params.sensitive != null)
    {
        return params.sensitive;
    }

    return (params.template ? getTemplate(params.template)?.sensitive : undefined) ?? false;
}

/**
 * Log context for a send result: the subject normally, the template name for
 * a sensitive send (whose subject can carry the credential), nothing when a
 * sensitive send has no template.
 */
function sendLogContext(sensitive: boolean, template: string | undefined, subject: string | undefined): Record<string, unknown>
{
    if (!sensitive)
    {
        return { subject };
    }

    return template ? { template } : {};
}

/**
 * Send email
 */
export async function sendEmail(params: SendEmailParams): Promise<SendResult>
{
    return deliverEmail(params);
}

/**
 * Send an email. `scheduledRowId` is the history row a scheduled job already
 * owns: no row is opened or closed here, and the job records the outcome.
 *
 * @internal
 */
export async function deliverEmail(params: SendEmailParams, scheduledRowId?: number): Promise<SendResult>
{
    const keyError = scheduledRowId ? undefined : idempotencyKeyError(params.idempotencyKey);

    if (keyError)
    {
        return { success: false, error: keyError };
    }

    // Prepare recipients
    const recipients = Array.isArray(params.to) ? params.to : [params.to];

    // Prepare content
    let subject = params.subject;
    let text = params.text;
    let html = params.html;

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

        const rendered = renderTemplate(params.template, params.data || {}, 'email');

        if (rendered.email)
        {
            subject = rendered.email.subject;
            text = rendered.email.text;
            html = rendered.email.html;
        }
    }

    // A sensitive send keeps its rendered values out of history AND out of
    // logs — a verification subject line carries the code itself.
    const sensitive = resolveSensitive(params);

    // Validate required fields
    if (!subject)
    {
        log.warn('Email subject is required', { to: maskRecipients(recipients) });

        return {
            success: false,
            error: 'Email subject is required',
        };
    }

    if (!text && !html)
    {
        log.warn('Email content (text or html) is required', { to: maskRecipients(recipients), ...sendLogContext(sensitive, params.template, subject) });

        return {
            success: false,
            error: 'Email content (text or html) is required',
        };
    }

    // Build internal params
    const internalParams: InternalSendEmailParams = {
        to: recipients,
        from: params.from || getEmailFrom(),
        replyTo: params.replyTo || getEmailReplyTo(),
        subject,
        text,
        html,
    };

    // Get provider
    const provider = getProvider();

    const opened = scheduledRowId
        ? { historyId: scheduledRowId }
        : await openHistoryRow(() => emailHistoryRow(params, recipients, subject, text, sensitive, provider.name), params.idempotencyKey, log);

    if (opened.stop)
    {
        return opened.stop;
    }

    const historyId = opened.historyId;

    // Apply tracking if enabled
    const shouldTrack = params.tracking ?? isTrackingEnabled();
    const trackingBaseUrl = getTrackingBaseUrl();

    if (shouldTrack && historyId && internalParams.html && trackingBaseUrl)
    {
        try
        {
            const { html: trackedHtml } = processTrackingHtml(internalParams.html, {
                notificationId: historyId,
                baseUrl: trackingBaseUrl,
            });
            internalParams.html = trackedHtml;
        }
        catch (error)
        {
            log.warn('Failed to apply tracking to email HTML', error as Error);
        }
    }

    // Send via provider
    const result = scrubSendResult(await provider.send(internalParams));

    if (result.success)
    {
        log.info('Email sent', { to: maskRecipients(recipients), ...sendLogContext(sensitive, params.template, subject), messageId: result.messageId });
    }
    else
    {
        log.error('Email send failed', { to: maskRecipients(recipients), ...sendLogContext(sensitive, params.template, subject), error: result.error });
    }

    // A scheduled job records the outcome on its own row.
    if (!scheduledRowId)
    {
        await closeHistoryRow(historyId, result, params.idempotencyKey !== undefined, log);
    }

    return result;
}

function emailHistoryRow(
    params: SendEmailParams,
    recipients: string[],
    subject: string,
    text: string | undefined,
    sensitive: boolean,
    providerName: string,
): HistoryRowData
{
    const storePayload = !sensitive && isHistoryContentStored();

    return {
        channel: 'email',
        recipient: historyRecipient(recipients),
        templateName: params.template,
        templateData: storePayload ? params.data : undefined,
        subject: sensitive ? undefined : subject,
        content: storePayload ? text : undefined,
        providerName,
    };
}

/**
 * Bulk email result
 */
export interface BulkEmailResult
{
    results: SendResult[];
    successCount: number;
    failureCount: number;
    batchId: string;
}

/**
 * Prepared email item (after template rendering + validation)
 */
interface PreparedEmail
{
    index: number;
    params: InternalSendEmailParams;
    recipients: string[];
    template?: string;
    data?: Record<string, unknown>;
    subject: string;
    text?: string;
    tracking?: boolean;
    sensitive: boolean;
    idempotencyKey?: string;
}

/**
 * Bulk email options
 */
export interface BulkEmailOptions
{
    /**
     * Max parallel sends when processing in-process (default: 10)
     */
    concurrency?: number;

    /**
     * When true, enqueue to pg-boss for distributed processing across instances.
     * Returns immediately with pending results — actual sending happens in background.
     * Requires notificationJobRouter to be registered.
     * @default false
     */
    distributed?: boolean;
}

/**
 * Validate and prepare all email items.
 * Shared between in-process and distributed modes.
 */
function prepareEmailItems(items: SendEmailParams[]): {
    prepared: PreparedEmail[];
    earlyFailures: { index: number; result: SendResult }[];
}
{
    const prepared: PreparedEmail[] = [];
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

        let subject = item.subject;
        let text = item.text;
        let html = item.html;

        if (item.template)
        {
            if (!hasTemplate(item.template))
            {
                earlyFailures.push({ index: i, result: { success: false, error: `Template not found: ${item.template}` } });
                continue;
            }

            const rendered = renderTemplate(item.template, item.data || {}, 'email');

            if (rendered.email)
            {
                subject = rendered.email.subject;
                text = rendered.email.text;
                html = rendered.email.html;
            }
        }

        if (!subject)
        {
            earlyFailures.push({ index: i, result: { success: false, error: 'Email subject is required' } });
            continue;
        }

        if (!text && !html)
        {
            earlyFailures.push({ index: i, result: { success: false, error: 'Email content (text or html) is required' } });
            continue;
        }

        prepared.push({
            index: i,
            params: {
                to: recipients,
                from: item.from || getEmailFrom(),
                replyTo: item.replyTo || getEmailReplyTo(),
                subject,
                text,
                html,
            },
            recipients,
            template: item.template,
            data: item.data,
            subject,
            text,
            tracking: item.tracking,
            sensitive: resolveSensitive(item),
            idempotencyKey: item.idempotencyKey,
        });
    }

    return { prepared, earlyFailures };
}

/**
 * Send bulk emails with batch DB insert and concurrent sending.
 *
 * @param items - Email items to send
 * @param options - concurrency, distributed
 */
export async function sendEmailBulk(
    items: SendEmailParams[],
    options?: BulkEmailOptions,
): Promise<BulkEmailResult>
{
    if (items.length === 0)
    {
        return { results: [], successCount: 0, failureCount: 0, batchId: '' };
    }

    const batchId = crypto.randomUUID();
    const provider = getProvider();

    // 1. Validate and prepare all items
    const { prepared, earlyFailures } = prepareEmailItems(items);

    // 2. Open history rows; a spent idempotency key stops its item here
    const storeContent = isHistoryContentStored();
    const opened = await openBulkHistoryRows(prepared.map(p =>
    {
        const storePayload = !p.sensitive && storeContent;

        return {
            buildRow: () => ({
                channel: 'email' as const,
                recipient: historyRecipient(p.recipients),
                templateName: p.template,
                templateData: storePayload ? p.data : undefined,
                subject: p.sensitive ? undefined : p.subject,
                content: storePayload ? p.text : undefined,
                providerName: provider.name,
                batchId,
            }),
            idempotencyKey: p.idempotencyKey,
        };
    }), log);
    const { sendable, historyIds, stopped } = splitStopped(prepared, opened);
    const settled = [...earlyFailures, ...stopped];
    const settledSuccesses = stopped.filter(s => s.result.success).length;

    // 3. Apply tracking per email
    const shouldTrackGlobal = isTrackingEnabled();
    const trackingBaseUrl = getTrackingBaseUrl();

    for (let i = 0; i < sendable.length; i++)
    {
        const p = sendable[i];
        const historyId = historyIds[i];
        const shouldTrack = p.tracking ?? shouldTrackGlobal;

        if (shouldTrack && historyId && p.params.html && trackingBaseUrl)
        {
            try
            {
                const { html } = processTrackingHtml(p.params.html, {
                    notificationId: historyId,
                    baseUrl: trackingBaseUrl,
                });
                p.params.html = html;
            }
            catch (error)
            {
                log.warn('Failed to apply tracking to email HTML', error as Error);
            }
        }
    }

    // 4. Distributed mode: enqueue to pg-boss and return immediately
    if (options?.distributed)
    {
        const jobInputs = sendable.map((p, i) => ({
            notificationId: historyIds[i] ?? 0,
            to: p.params.to,
            from: p.params.from,
            replyTo: p.params.replyTo,
            subject: p.params.subject,
            text: p.params.text,
            html: p.params.html,
        }));

        await sendBulkEmailItemJob.sendBatch(jobInputs);

        log.info('Bulk email enqueued for distributed processing', {
            batchId,
            total: items.length,
            enqueued: sendable.length,
            earlyFailures: earlyFailures.length,
            deduplicated: stopped.length,
        });

        // Return pending results — actual send happens via pg-boss workers
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

    // 5. In-process mode: send with concurrency control
    const concurrency = options?.concurrency ?? 10;

    const sendResults = await runWithConcurrency(
        sendable,
        (p) => provider.send(p.params).then(scrubSendResult),
        concurrency,
    );

    // 6. Build results + update history records
    const results: SendResult[] = new Array(items.length);
    let successCount = settledSuccesses;
    let failureCount = settled.length - settledSuccesses;

    for (const { index, result } of settled)
    {
        results[index] = result;
    }

    // Group history updates by outcome → two batched UPDATEs instead of N
    // concurrent single-row UPDATEs.
    const sentItems: Array<{ id: number; providerMessageId?: string }> = [];
    const failedItems: Array<{ id: number; errorMessage: string }> = [];

    for (let i = 0; i < sendable.length; i++)
    {
        const { index, recipients, subject, sensitive, template } = sendable[i];
        const result = sendResults[i];
        results[index] = result;
        const logContext = sendLogContext(sensitive, template, subject);

        if (result.success)
        {
            successCount++;
            log.info('Email sent', { to: maskRecipients(recipients), ...logContext, messageId: result.messageId });
        }
        else
        {
            failureCount++;
            log.error('Email send failed', { to: maskRecipients(recipients), ...logContext, error: result.error });
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
