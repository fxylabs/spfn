/**
 * @spfn/monitor - Slack Notifier
 *
 * Formats and sends error notifications to Slack using Block Kit.
 * Notifications are only sent for new errors and reopened errors.
 */

import { sendSlack } from '@spfn/notification/server';
import type { DatabaseErrorDescription, ErrorDescription } from '@spfn/core/logger';
import { getSlackWebhookUrl } from '@spfn/monitor/config';
import { monitorLogger } from '../logger';
import type { ErrorGroup, ErrorEvent } from '../entities';

const logger = monitorLogger.notification;

type NotifyReason = 'new' | 'reopened';

/**
 * Send error notification to Slack
 *
 * The text is the group's summary and the top frames of the error's
 * description — never the error's message or stack, which for a failed
 * statement carry its bound values (#382).
 */
export async function notifyErrorToSlack(
    group: ErrorGroup,
    event: ErrorEvent,
    description: ErrorDescription | DatabaseErrorDescription,
    reason: NotifyReason,
    environment?: string,
): Promise<void>
{
    const webhookUrl = getSlackWebhookUrl();
    if (!webhookUrl)
    {
        logger.warn('Slack webhook URL not configured, skipping notification');

        return;
    }

    const { text, blocks } = formatSlackMessage(group, event, description.stack, reason, environment);

    const result = await sendSlack({ webhookUrl, text, blocks });
    if (!result.success)
    {
        logger.warn('Failed to send Slack notification', { error: result.error });
    }
}

/**
 * Format Slack Block Kit message
 */
function formatSlackMessage(
    group: ErrorGroup,
    event: ErrorEvent,
    frames: string | undefined,
    reason: NotifyReason,
    environment?: string,
): { text: string; blocks: unknown[] }
{
    const isNew = reason === 'new';
    const emoji = isNew ? ':rotating_light:' : ':warning:';
    const label = isNew ? 'New Error' : 'Re-opened Error';
    const envTag = environment ? ` [${environment}]` : '';
    const title = `${emoji}${envTag} ${label} — ${group.statusCode}`;

    const blocks: unknown[] = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `${envTag ? envTag.trim() + ' ' : ''}${label} — ${group.statusCode}`,
                emoji: true,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*${group.name}*\n> ${group.message}`,
            },
        },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Method*\n${group.method}` },
                { type: 'mrkdwn', text: `*Path*\n${group.path}` },
                { type: 'mrkdwn', text: `*User*\n${event.userId ?? '(anonymous)'}` },
                { type: 'mrkdwn', text: `*Request ID*\n${event.requestId ?? '(none)'}` },
            ],
        },
        {
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: `*Count:* ${group.count}` },
                { type: 'mrkdwn', text: `*First seen:* ${formatTime(group.firstSeenAt)}` },
                { type: 'mrkdwn', text: `*Last seen:* ${formatTime(group.lastSeenAt)}` },
            ],
        },
    ];

    // Stack trace (abbreviated)
    if (frames)
    {
        const shortStack = frames
            .split('\n')
            .slice(0, 3)
            .map(l => l.trim())
            .join('\n');

        blocks.push(
            { type: 'divider' },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Stack Trace*\n\`\`\`${shortStack}\`\`\``,
                },
            },
        );
    }

    // Headers
    if (event.headers && Object.keys(event.headers).length > 0)
    {
        const headerStr = Object.entries(event.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');

        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*Request Headers*\n\`\`\`${headerStr}\`\`\``,
            },
        });
    }

    return { text: title, blocks };
}

function formatTime(date: Date | null): string
{
    if (!date)
    {
        return '(unknown)';
    }

    return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
