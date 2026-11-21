/**
 * @spfn/notification - Error → Slack Integration
 *
 * Factory for creating an onError callback that sends error notifications to Slack.
 *
 * @example
 * ```typescript
 * import { createServer } from '@spfn/core/server';
 * import { createErrorSlackNotifier } from '@spfn/notification/server';
 *
 * await createServer({
 *     middleware: {
 *         onError: createErrorSlackNotifier({ minStatusCode: 500 }),
 *     },
 * });
 * ```
 */

import { hostname } from 'os';
import { describeError, type DatabaseErrorDescription, type ErrorDescription } from '@spfn/core/logger';
import { sendSlack } from '../channels/slack';

type Description = ErrorDescription | DatabaseErrorDescription;

interface ErrorContext
{
    statusCode: number;
    path: string;
    method: string;
    requestId?: string;
    timestamp: string;
    userId?: string;
    request: {
        headers: Record<string, string>;
        query: Record<string, string>;
    };
}

export interface ErrorSlackOptions
{
    /**
     * Minimum status code to trigger notification
     * @default 500
     */
    minStatusCode?: number;

    /**
     * Throttle window in milliseconds.
     * Duplicate errors (same name + statusCode + path) within this window are suppressed.
     * @default 60_000
     */
    throttleMs?: number;

    /**
     * Webhook URL override (defaults to env/config)
     */
    webhookUrl?: string;

    /**
     * Custom message formatter
     */
    formatMessage?: (err: Error, ctx: ErrorContext) => { text?: string; blocks?: unknown[] };
}

/**
 * Format headers as a code block string
 */
function formatHeaders(headers: Record<string, string>): string
{
    const entries = Object.entries(headers);

    if (entries.length === 0)
    {
        return '(none)';
    }

    return entries
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
}

/**
 * Format query params as a code block string
 */
function formatQuery(query: Record<string, string>): string
{
    const entries = Object.entries(query);

    if (entries.length === 0)
    {
        return '(none)';
    }

    return entries
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
}

/**
 * The top frames of the error's description — never its stack header,
 * which repeats the message
 */
function shortStack(description: Description, maxLines: number = 3): string
{
    if (!description.stack)
    {
        return '(no stack)';
    }

    return description.stack
        .split('\n')
        .slice(0, maxLines)
        .map(line => line.trim())
        .join('\n');
}

/**
 * The description's safe fields, one line per link of the cause chain: the
 * name, a database error's code, constraint and table, and the message the
 * description kept — never the error's own message, which for a failed
 * statement carries its SQL and bound values (#382)
 */
function errorSummary(description: Description): string
{
    const fields = description.kind === 'database'
        ? { code: description.code, constraint: description.constraint, table: description.table }
        : { code: description.code };
    const tags = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ` [${key}=${value}]`)
        .join('');
    const line = `${description.name}${tags}${description.message ? `: ${description.message}` : ''}`;

    return description.kind === 'error' && description.cause
        ? `${line}\n> ← ${errorSummary(description.cause)}`
        : line;
}

// ── Throttle ────────────────────────────────────────────────

interface ThrottleEntry
{
    lastSent: number;
    suppressed: number;
}

const throttleMap = new Map<string, ThrottleEntry>();

function throttleKey(err: Error, ctx: ErrorContext): string
{
    return `${err.name}:${ctx.statusCode}:${ctx.path}`;
}

// ── Formatting ──────────────────────────────────────────────

/**
 * Default Block Kit format for error notifications
 */
function getEnvLabel(): string
{
    const env = process.env.NODE_ENV || 'unknown';
    const host = hostname();
    const dbUrl = process.env.DATABASE_URL || '';
    const dbName = dbUrl.match(/\/([^/?]+)(\?|$)/)?.[1] || '(unknown)';

    return `${env} | ${host} | db:${dbName}`;
}

function defaultFormat(err: Error, ctx: ErrorContext, suppressed: number = 0): { text: string; blocks: unknown[] }
{
    const description = describeError(err);
    const envLabel = getEnvLabel();
    const emoji = ctx.statusCode >= 500 ? ':rotating_light:' : ':warning:';
    const title = `${emoji} *${err.name || 'Error'}* — ${ctx.statusCode} [${envLabel}]`;

    const fields = [
        { type: 'mrkdwn', text: `*Method*\n${ctx.method}` },
        { type: 'mrkdwn', text: `*Path*\n${ctx.path}` },
        { type: 'mrkdwn', text: `*User*\n${ctx.userId ?? '(anonymous)'}` },
        { type: 'mrkdwn', text: `*Request ID*\n${ctx.requestId ?? '(none)'}` },
    ];

    const blocks: unknown[] = [
        // Title
        {
            type: 'header',
            text: { type: 'plain_text', text: `${err.name || 'Error'} — ${ctx.statusCode}`, emoji: true },
        },
        // Error message
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `> ${errorSummary(description)}` },
        },
        // Fields: method, path, user, requestId
        {
            type: 'section',
            fields,
        },
        // Timestamp + suppressed count
        {
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: `*Time:* ${ctx.timestamp}` },
                ...(suppressed > 0
                    ? [{ type: 'mrkdwn' as const, text: `_+${suppressed} suppressed since last notification_` }]
                    : []),
            ],
        },
        { type: 'divider' },
        // Headers
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Request Headers*\n\`\`\`${formatHeaders(ctx.request.headers)}\`\`\`` },
        },
        // Query
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Query Params*\n\`\`\`${formatQuery(ctx.request.query)}\`\`\`` },
        },
        { type: 'divider' },
        // Stack trace
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Stack Trace*\n\`\`\`${shortStack(description)}\`\`\`` },
        },
    ];

    return { text: title, blocks };
}

/**
 * Create an onError callback that sends Slack notifications
 *
 * Returns a function matching ErrorHandler's onError signature.
 * Duplicate errors (same name + statusCode + path) within `throttleMs` are suppressed.
 *
 * @deprecated Use `createMonitorErrorHandler()` from `@spfn/monitor/server` instead.
 * It provides DB-backed error tracking with fingerprint deduplication,
 * state-based notifications (new/reopened), and an admin dashboard.
 *
 * Migration:
 * ```typescript
 * // Before
 * import { createErrorSlackNotifier } from '@spfn/notification/server';
 * middleware: { onError: createErrorSlackNotifier() }
 *
 * // After
 * import { createMonitorErrorHandler } from '@spfn/monitor/server';
 * middleware: { onError: createMonitorErrorHandler() }
 * ```
 */
export function createErrorSlackNotifier(options: ErrorSlackOptions = {})
{
    console.warn(
        '[@spfn/notification] createErrorSlackNotifier() is deprecated. ' +
        'Use createMonitorErrorHandler() from @spfn/monitor/server instead.',
    );

    const { minStatusCode = 500, throttleMs = 60_000 } = options;

    return async (err: Error, ctx: ErrorContext) =>
    {
        if (ctx.statusCode < minStatusCode)
        {
            return;
        }

        // Throttle: suppress duplicate errors within the window
        const key = throttleKey(err, ctx);
        const now = Date.now();
        const entry = throttleMap.get(key);

        if (entry && now - entry.lastSent < throttleMs)
        {
            entry.suppressed++;

            return;
        }

        const suppressed = entry?.suppressed ?? 0;

        // Reset entry
        throttleMap.set(key, { lastSent: now, suppressed: 0 });

        const message = options.formatMessage?.(err, ctx) ?? defaultFormat(err, ctx, suppressed);

        await sendSlack({
            ...message,
            webhookUrl: options.webhookUrl,
        });
    };
}
