/**
 * @spfn/notification - Email Channel Types
 */

import type { SendResult, ChannelProvider } from '../types';

/**
 * Parameters for sending email
 */
export interface SendEmailParams
{
    /**
     * Recipient email address(es)
     */
    to: string | string[];

    /**
     * Email subject (required if not using template)
     */
    subject?: string;

    /**
     * Template name
     */
    template?: string;

    /**
     * Template data for variable substitution
     */
    data?: Record<string, unknown>;

    /**
     * Plain text content (if not using template)
     */
    text?: string;

    /**
     * HTML content (if not using template)
     */
    html?: string;

    /**
     * From address (overrides default)
     */
    from?: string;

    /**
     * Reply-to address
     */
    replyTo?: string;

    /**
     * Makes retries safe: a second send with the same key (per channel and
     * recipient) returns the first result instead of sending again. Derive it
     * from the business event (`invoice-8812:payment-failed`) or generate it
     * once and store it; a fresh UUID per attempt deduplicates nothing.
     * 1-255 characters. Requires notification history.
     */
    idempotencyKey?: string;

    /**
     * Enable/disable engagement tracking for this email.
     * When undefined, falls back to global tracking config.
     */
    tracking?: boolean;

    /**
     * This send carries a credential (magic link, OTP, …): keep rendered
     * content and template data out of the history row. When undefined,
     * falls back to the template's own `sensitive` declaration.
     */
    sensitive?: boolean;
}

/**
 * Email provider interface
 */
export interface EmailProvider extends ChannelProvider<InternalSendEmailParams, SendResult>
{
    name: 'aws-ses' | 'sendgrid' | 'smtp' | string;
}

/**
 * Internal send email params (after template rendering)
 */
export interface InternalSendEmailParams
{
    to: string[];
    from: string;
    replyTo?: string;
    subject: string;
    text?: string;
    html?: string;
}
