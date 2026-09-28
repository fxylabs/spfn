/**
 * @spfn/notification - Schedule Service
 *
 * Schedule notifications for later delivery
 */

import type { SendEmailParams } from '../channels/email/types';
import type { SendSMSParams } from '../channels/sms/types';
import { renderTemplateChannel, getTemplate } from '../templates';
import { historyRecipient } from '../privacy';
import { isHistoryContentStored } from '../config';
import {
    createScheduledNotification,
    updateNotificationJobId,
} from './notification.service';
import { claimKeyedSend, idempotencyKeyError } from './idempotency.service';
import { hasSendGuard } from './send-guard.service';
import type { HistoryRowData } from '../channels/history';
import { sendScheduledEmailJob } from '../jobs/send-scheduled-email';
import { sendScheduledSmsJob } from '../jobs/send-scheduled-sms';
import { normalizePhoneNumber } from '../channels/sms/utils';

/**
 * Schedule options
 */
export interface ScheduleOptions
{
    /**
     * When to send
     */
    scheduledAt: Date;

    /**
     * Reference to related entity
     */
    referenceType?: string;
    referenceId?: string;

    /**
     * Name of a guard registered with `registerSendGuard`. When the job runs
     * it calls the guard (after checking the row was not cancelled); `false`
     * marks the row `skipped` and sends nothing.
     */
    guard?: string;
}

/**
 * Why these options cannot be scheduled, or undefined.
 */
function scheduleOptionsError(options: ScheduleOptions): string | undefined
{
    return options.guard !== undefined && !hasSendGuard(options.guard)
        ? `Send guard not registered: ${options.guard}`
        : undefined;
}

/**
 * Result of scheduling
 */
export interface ScheduleResult
{
    success: boolean;
    notificationId?: number;
    jobId?: string;
    error?: string;
    /**
     * The idempotency key was already used: nothing new was scheduled, and
     * `notificationId`/`jobId` are the first schedule's.
     */
    deduplicated?: boolean;
}

/**
 * Create the scheduled row, or — for a keyed schedule — claim it. A spent key
 * returns the first schedule instead of a new row.
 */
async function openScheduledRow(
    row: HistoryRowData & { scheduledAt: Date },
    idempotencyKey: string | undefined,
): Promise<{ id: number } | { duplicate: ScheduleResult }>
{
    if (idempotencyKey === undefined)
    {
        return { id: (await createScheduledNotification(row)).id };
    }

    const claim = await claimKeyedSend({ ...row, idempotencyKey }, 'scheduled');

    if (claim.claimed)
    {
        return { id: claim.id };
    }

    const spent = claim.existing?.status === 'scheduled' || claim.existing?.status === 'sent';

    return {
        duplicate: {
            success: spent,
            notificationId: claim.existing?.id,
            jobId: claim.existing?.jobId ?? undefined,
            deduplicated: true,
            error: spent ? undefined : claim.result.error,
        },
    };
}

/**
 * Schedule email for later delivery
 */
export async function scheduleEmail(
    params: SendEmailParams,
    options: ScheduleOptions,
): Promise<ScheduleResult>
{
    const optionsError = idempotencyKeyError(params.idempotencyKey) ?? scheduleOptionsError(options);

    if (optionsError)
    {
        return { success: false, error: optionsError };
    }

    // Prepare recipients
    const recipients = Array.isArray(params.to) ? params.to : [params.to];

    // Prepare content
    let subject = params.subject;
    let text = params.text;
    let html = params.html;

    let usedLocale: string | undefined;

    // Render template if specified
    if (params.template)
    {
        const rendered = renderTemplateChannel(params.template, params.data || {}, 'email', params.locale);

        if ('error' in rendered)
        {
            return {
                success: false,
                error: rendered.error,
            };
        }

        if (rendered.content)
        {
            subject = rendered.content.subject;
            text = rendered.content.text;
            html = rendered.content.html;
        }

        usedLocale = rendered.locale;
    }

    // Validate required fields
    if (!subject)
    {
        return {
            success: false,
            error: 'Email subject is required',
        };
    }

    if (!text && !html)
    {
        return {
            success: false,
            error: 'Email content (text or html) is required',
        };
    }

    try
    {
        const sensitive = params.sensitive
            ?? (params.template ? getTemplate(params.template)?.sensitive : undefined)
            ?? false;
        const storePayload = !sensitive && isHistoryContentStored();

        // Create scheduled notification record. The pg-boss job payload below
        // still carries the raw recipient and content — it has to, that is what
        // gets sent later — so scheduled sends inherently persist the payload
        // until pg-boss archives the job.
        const claimToken = crypto.randomUUID();
        const opened = await openScheduledRow({
            channel: 'email',
            locale: usedLocale,
            claimToken,
            recipient: historyRecipient(recipients),
            templateName: params.template,
            templateData: storePayload ? params.data : undefined,
            subject: sensitive ? undefined : subject,
            content: storePayload ? text : undefined,
            providerName: 'pending', // Will be set when job runs
            scheduledAt: options.scheduledAt,
            referenceType: options.referenceType,
            referenceId: options.referenceId,
        }, params.idempotencyKey);

        if ('duplicate' in opened)
        {
            return opened.duplicate;
        }

        const notification = opened;

        // Schedule job with pg-boss
        const jobId = await sendScheduledEmailJob.send(
            {
                notificationId: notification.id,
                to: params.to,
                subject: params.subject,
                template: params.template,
                data: params.data,
                text: params.text,
                html: params.html,
                from: params.from,
                replyTo: params.replyTo,
                sensitive: params.sensitive,
                locale: params.locale,
                claimToken,
                guard: options.guard,
                referenceType: options.referenceType,
                referenceId: options.referenceId,
            },
            { startAfter: options.scheduledAt },
        );

        // Update notification with job ID
        if (jobId)
        {
            await updateNotificationJobId(notification.id, jobId);
        }

        return {
            success: true,
            notificationId: notification.id,
            jobId: jobId || undefined,
        };
    }
    catch (error)
    {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to schedule email',
        };
    }
}

/**
 * Schedule SMS for later delivery
 */
export async function scheduleSMS(
    params: SendSMSParams,
    options: ScheduleOptions,
): Promise<ScheduleResult>
{
    const optionsError = idempotencyKeyError(params.idempotencyKey) ?? scheduleOptionsError(options);

    if (optionsError)
    {
        return { success: false, error: optionsError };
    }

    // Prepare recipients
    const recipients = Array.isArray(params.to) ? params.to : [params.to];

    // Prepare content
    let message = params.message;

    let usedLocale: string | undefined;

    // Render template if specified
    if (params.template)
    {
        const rendered = renderTemplateChannel(params.template, params.data || {}, 'sms', params.locale);

        if ('error' in rendered)
        {
            return {
                success: false,
                error: rendered.error,
            };
        }

        if (rendered.content)
        {
            message = rendered.content.message;
        }

        usedLocale = rendered.locale;
    }

    // Validate required fields
    if (!message)
    {
        return {
            success: false,
            error: 'SMS message is required',
        };
    }

    try
    {
        // Normalize phone numbers
        const normalizedRecipients = recipients.map(r => normalizePhoneNumber(r));

        const sensitive = params.sensitive
            ?? (params.template ? getTemplate(params.template)?.sensitive : undefined)
            ?? false;
        const storePayload = !sensitive && isHistoryContentStored();

        // Create scheduled notification record (see the email note above about
        // the pg-boss payload).
        const claimToken = crypto.randomUUID();
        const opened = await openScheduledRow({
            channel: 'sms',
            locale: usedLocale,
            claimToken,
            recipient: historyRecipient(normalizedRecipients),
            templateName: params.template,
            templateData: storePayload ? params.data : undefined,
            content: storePayload ? message : undefined,
            providerName: 'pending', // Will be set when job runs
            scheduledAt: options.scheduledAt,
            referenceType: options.referenceType,
            referenceId: options.referenceId,
        }, params.idempotencyKey);

        if ('duplicate' in opened)
        {
            return opened.duplicate;
        }

        const notification = opened;

        // Schedule job with pg-boss
        const jobId = await sendScheduledSmsJob.send(
            {
                notificationId: notification.id,
                to: params.to,
                message: params.message,
                template: params.template,
                data: params.data,
                sensitive: params.sensitive,
                locale: params.locale,
                claimToken,
                guard: options.guard,
                referenceType: options.referenceType,
                referenceId: options.referenceId,
            },
            { startAfter: options.scheduledAt },
        );

        // Update notification with job ID
        if (jobId)
        {
            await updateNotificationJobId(notification.id, jobId);
        }

        return {
            success: true,
            notificationId: notification.id,
            jobId: jobId || undefined,
        };
    }
    catch (error)
    {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to schedule SMS',
        };
    }
}
