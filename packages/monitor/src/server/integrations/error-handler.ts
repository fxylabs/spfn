/**
 * @spfn/monitor - Error Handler Integration
 *
 * Drop-in replacement for createErrorSlackNotifier from @spfn/notification.
 * Uses DB-backed error tracking with state-based notifications instead of
 * in-memory time-based throttling.
 *
 * @example
 * ```typescript
 * import { createMonitorErrorHandler } from '@spfn/monitor/server';
 *
 * export default defineServerConfig()
 *     .middleware({ onError: createMonitorErrorHandler() })
 *     .build();
 * ```
 */

import { getMinStatusCode } from '@spfn/monitor/config';
import { trackError, type ErrorTrackingContext } from '../services';
import { monitorLogger } from '../logger';

// Headers/query params whose VALUES must never be persisted to the error store or
// posted to Slack. The upstream core error-handler masks a smaller set; the
// monitor re-redacts a broader denylist here because it durably stores and
// forwards this data (don't rely on the upstream mask).
const SENSITIVE_HEADERS = new Set([
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
    'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
    'x-spfn-proxy-signature', 'x-amz-security-token',
]);
const SENSITIVE_QUERY = new Set([
    'token', 'access_token', 'refresh_token', 'id_token', 'code',
    'secret', 'client_secret', 'password', 'passwd', 'pwd',
    'api_key', 'apikey', 'key', 'signature', 'sig', 'session', 'sessionid', 'auth',
]);

function redact(obj: Record<string, string>, deny: Set<string>): Record<string, string>
{
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj))
    {
        out[k] = deny.has(k.toLowerCase()) ? '***' : v;
    }

    return out;
}

const logger = monitorLogger.errorTracking;

export interface MonitorErrorHandlerOptions
{
    /**
     * Minimum status code to track
     * @default env.SPFN_MONITOR_MIN_STATUS_CODE or 500
     */
    minStatusCode?: number;

    /**
     * Environment label (e.g. 'production', 'staging', 'development')
     * Displayed in Slack notifications for easy identification.
     */
    environment?: string;

    /**
     * Extract custom metadata from error and context
     */
    extractMetadata?: (err: Error, ctx: ErrorTrackingContext) => Record<string, unknown>;
}

interface OnErrorContext
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

/**
 * Create an onError callback that tracks errors in DB and sends Slack notifications
 *
 * Returns a function matching ErrorHandler's onError signature.
 * Replaces createErrorSlackNotifier from @spfn/notification.
 */
export function createMonitorErrorHandler(options: MonitorErrorHandlerOptions = {})
{
    return async (err: Error, ctx: OnErrorContext) =>
    {
        const minStatus = options.minStatusCode ?? getMinStatusCode();

        if (ctx.statusCode < minStatus)
        {
            return;
        }

        const trackingCtx: ErrorTrackingContext = {
            statusCode: ctx.statusCode,
            path: ctx.path,
            method: ctx.method,
            requestId: ctx.requestId,
            userId: ctx.userId != null ? String(ctx.userId) : undefined,
            // Redact secrets before they are persisted (error_events.headers) and
            // forwarded to Slack (S-H3 / S-M2 / S-L3).
            headers: redact(ctx.request.headers, SENSITIVE_HEADERS),
            query: redact(ctx.request.query, SENSITIVE_QUERY),
            environment: options.environment,
        };

        const metadata = options.extractMetadata?.(err, trackingCtx);

        try
        {
            await trackError(err, trackingCtx, metadata);
        }
        catch (error)
        {
            logger.warn('Monitor error handler failed', { error });
        }
    };
}
