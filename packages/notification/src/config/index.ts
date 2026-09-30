/**
 * @spfn/notification - Configuration
 */

import { createEnvRegistry } from '@spfn/core/env';
import { notificationEnvSchema } from './schema';

export { notificationEnvSchema };

/**
 * The same schema under the name every `@spfn/*` package exports it by, so the
 * CLI finds it without knowing this package's own name for it.
 */
export { notificationEnvSchema as envSchema };

/**
 * Environment registry
 */
const registry = createEnvRegistry(notificationEnvSchema);
export const env = registry.validate();

/**
 * Notification configuration
 */
export interface NotificationConfig
{
    email?: {
        provider?: 'aws-ses' | 'sendgrid' | 'smtp';
        from?: string;
        replyTo?: string;
    };
    sms?: {
        provider?: 'aws-sns' | 'twilio';
        defaultCountryCode?: string;
    };
    slack?: {
        webhookUrl?: string;
    };
    defaults?: {
        appName?: string;
    };
    /**
     * Enable notification history tracking (requires database)
     * @default false
     */
    enableHistory?: boolean;
    /**
     * What a history row stores. The row itself is always created when history
     * is enabled — it anchors tracking, scheduling and bulk status — these
     * options only control which values land in it.
     */
    history?: {
        /**
         * Store the rendered content and template data (default: true).
         * Sends marked `sensitive` skip both regardless of this setting.
         */
        storeContent?: boolean;
        /**
         * How the recipient column is stored (default: 'raw').
         * 'hashed' stores an HMAC per recipient; exact-match history queries
         * keep working because filters are hashed the same way.
         */
        storeRecipient?: 'raw' | 'hashed';
        /**
         * Secret for the recipient HMAC (falls back to
         * SPFN_NOTIFICATION_HISTORY_HASH_SECRET). Required for 'hashed'.
         */
        hashSecret?: string;
    };
    /**
     * Email engagement tracking configuration
     */
    tracking?: {
        /** Enable tracking (default: false) */
        enabled?: boolean;
        /** HMAC secret key for token signing */
        secret?: string;
        /** Base URL for tracking endpoints */
        baseUrl?: string;
    };
}

let globalConfig: NotificationConfig = {};

/**
 * Configure notification settings
 */
export function configureNotification(config: NotificationConfig): void
{
    // `history` merges deep: a later partial call must not silently reset an
    // earlier privacy setting (e.g. drop storeRecipient: 'hashed' back to raw).
    const next: NotificationConfig = {
        ...globalConfig,
        ...config,
        history: config.history
            ? { ...globalConfig.history, ...config.history }
            : globalConfig.history,
    };

    // Fail at configure time, not at first send — and before assignment, so a
    // caught error cannot leave the config in the invalid state. A
    // hashed-recipient contract with no secret would otherwise surface only
    // as skipped history rows.
    if (next.history?.storeRecipient === 'hashed'
        && !(next.history.hashSecret ?? env.SPFN_NOTIFICATION_HISTORY_HASH_SECRET))
    {
        throw new Error(
            'history.storeRecipient is "hashed" but no hash secret is configured '
            + '(set history.hashSecret or SPFN_NOTIFICATION_HISTORY_HASH_SECRET)',
        );
    }

    globalConfig = next;
}

/**
 * Get current notification configuration
 */
export function getNotificationConfig(): NotificationConfig
{
    return { ...globalConfig };
}

/**
 * Get email from address
 */
export function getEmailFrom(): string
{
    return globalConfig.email?.from || env.SPFN_NOTIFICATION_EMAIL_FROM || 'noreply@example.com';
}

/**
 * Get email reply-to address
 */
export function getEmailReplyTo(): string | undefined
{
    return globalConfig.email?.replyTo;
}

/**
 * Get SMS default country code
 */
export function getSmsDefaultCountryCode(): string
{
    return globalConfig.sms?.defaultCountryCode || '+82';
}

/**
 * Get app name for templates
 */
export function getAppName(): string
{
    return globalConfig.defaults?.appName || 'SPFN';
}

/**
 * Check if history tracking is enabled
 */
export function isHistoryEnabled(): boolean
{
    return globalConfig.enableHistory ?? false;
}

/**
 * Whether history rows store rendered content and template data
 */
export function isHistoryContentStored(): boolean
{
    return globalConfig.history?.storeContent ?? true;
}

/**
 * How history rows store the recipient column
 */
export function getHistoryRecipientMode(): 'raw' | 'hashed'
{
    return globalConfig.history?.storeRecipient ?? 'raw';
}

/**
 * Secret for the history recipient HMAC (config → env)
 */
export function getHistoryHashSecret(): string | undefined
{
    return globalConfig.history?.hashSecret ?? env.SPFN_NOTIFICATION_HISTORY_HASH_SECRET;
}

/**
 * Check if tracking is enabled (config → env → false)
 */
export function isTrackingEnabled(): boolean
{
    if (globalConfig.tracking?.enabled != null)
    {
        return globalConfig.tracking.enabled;
    }

    return env.SPFN_NOTIFICATION_TRACKING_ENABLED === 'true';
}

/**
 * Get tracking HMAC secret
 */
export function getTrackingSecret(): string | undefined
{
    return globalConfig.tracking?.secret ?? env.SPFN_NOTIFICATION_TRACKING_SECRET;
}

/**
 * Get tracking base URL
 */
export function getTrackingBaseUrl(): string | undefined
{
    return globalConfig.tracking?.baseUrl ?? env.SPFN_NOTIFICATION_TRACKING_BASE_URL;
}
