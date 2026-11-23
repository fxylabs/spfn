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
     * Locale tag for a template with `locales` (`ko`, `en-US`). Falls back
     * to the base language, then the template's `defaultLocale`.
     */
    locale?: string;

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
     * Files sent with the mail. Sent immediately only: `scheduleEmail` and a
     * distributed `sendEmailBulk` refuse them (`attachments_not_deferrable`).
     * The bytes never reach the history row. A plain-JS caller's `null`
     * means none, as `undefined` does; any other value that is not an array
     * is refused (`attachment_invalid`).
     */
    attachments?: EmailAttachment[];

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
 * A file sent with an email
 */
export interface EmailAttachment
{
    /**
     * Name the recipient sees. Not empty; no control characters and no line
     * breaks — CR, LF, NEL, U+2028, U+2029 — which would reach the MIME header
     * the provider writes it into.
     *
     * The package itself writes it nowhere but to the provider. A provider
     * error that quotes it has it replaced by `[attachment N]`, as written
     * and percent-encoded (`encodeURIComponent`, or `+` for a space); any
     * other encoding a provider might invent is not recognised. Where it
     * runs into an address or phone number in that error, the address or
     * number is masked and the rest of the name stays; where it runs into
     * text shaped like the scrub's own output (`[attachment N]`, a masked
     * address or phone number), the name stays whole.
     */
    filename: string;

    /**
     * MIME type, `type/subtype` with optional `; name=value` parameters
     */
    contentType: string;

    /**
     * The file's bytes, at least one
     */
    content: Uint8Array;
}

/**
 * Email provider interface
 */
export interface EmailProvider extends ChannelProvider<InternalSendEmailParams, SendResult>
{
    name: 'aws-ses' | 'sendgrid' | 'smtp' | string;

    /**
     * The provider sends `params.attachments`. Without it a send that has
     * attachments is refused (`attachments_unsupported`) before the provider
     * is called, so a provider written before attachments existed cannot
     * drop them silently.
     */
    supportsAttachments?: boolean;

    /**
     * The provider's message size limit in bytes, as its service measures it
     * (encoded). A send whose encoded size is certainly over it is refused
     * (`message_too_large`) before the provider is called.
     */
    maxMessageBytes?: number;
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
    attachments?: EmailAttachment[];
}
