/**
 * @spfn/notification - SMS Channel Types
 */

import type { SendResult, ChannelProvider } from '../types';

/**
 * Parameters for sending SMS
 */
export interface SendSMSParams
{
    /**
     * Phone number(s) in E.164 format (e.g., +821012345678)
     */
    to: string | string[];

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
     * Message content (if not using template)
     */
    message?: string;

    /**
     * Makes retries safe: a second send with the same key (per channel and
     * recipient) returns the first result instead of sending again. Derive it
     * from the business event (`invoice-8812:payment-failed`) or generate it
     * once and store it; a fresh UUID per attempt deduplicates nothing.
     * 1-255 characters. Requires notification history.
     */
    idempotencyKey?: string;

    /**
     * This send carries a credential (OTP, …): keep rendered content and
     * template data out of the history row. When undefined, falls back to
     * the template's own `sensitive` declaration.
     */
    sensitive?: boolean;
}

/**
 * SMS provider interface
 */
export interface SMSProvider extends ChannelProvider<InternalSendSMSParams, SendResult>
{
    name: 'aws-sns' | 'twilio' | string;
}

/**
 * Internal send SMS params (after template rendering)
 */
export interface InternalSendSMSParams
{
    to: string;
    message: string;
}
