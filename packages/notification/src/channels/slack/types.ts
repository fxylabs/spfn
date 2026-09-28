/**
 * @spfn/notification - Slack Channel Types
 */

import type { ChannelProvider } from '../types';

/**
 * Parameters for sending Slack message
 */
export interface SendSlackParams
{
    /**
     * Webhook URL (overrides env/config default)
     */
    webhookUrl?: string;

    /**
     * Plain text message
     */
    text?: string;

    /**
     * Slack Block Kit blocks
     */
    blocks?: unknown[];

    /**
     * Template name
     */
    template?: string;

    /**
     * Template data for variable substitution
     */
    data?: Record<string, unknown>;

    /**
     * Locale tag for a template with `locales` (`ko`, `en-US`). Falls back
     * to the base language, then the template's `defaultLocale`.
     */
    locale?: string;

    /**
     * Makes retries safe: a second send with the same key (per channel and
     * recipient) returns the first result instead of sending again. Derive it
     * from the business event (`invoice-8812:payment-failed`) or generate it
     * once and store it; a fresh UUID per attempt deduplicates nothing.
     * 1-255 characters. Requires notification history.
     */
    idempotencyKey?: string;
}

/**
 * Slack provider interface
 */
export interface SlackProvider extends ChannelProvider<InternalSendSlackParams>
{
    name: 'webhook' | string;
}

/**
 * Internal send Slack params (after template rendering)
 */
export interface InternalSendSlackParams
{
    webhookUrl: string;
    text?: string;
    blocks?: unknown[];
}
