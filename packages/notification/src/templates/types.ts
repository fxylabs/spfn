/**
 * @spfn/notification - Template Types
 */

import type { NotificationChannel } from '../channels/types';

/**
 * Email template content
 */
export interface EmailTemplateContent
{
    subject: string;
    html?: string;
    text?: string;
}

/**
 * SMS template content
 */
export interface SmsTemplateContent
{
    message: string;
}

/**
 * Slack template content
 */
export interface SlackTemplateContent
{
    text?: string;
    blocks?: unknown[];
}

/**
 * Content for one locale. A locale may cover only some channels; a channel it
 * lacks falls through to the next candidate locale.
 */
export interface LocaleTemplateContent
{
    email?: EmailTemplateContent;
    sms?: SmsTemplateContent;
    slack?: SlackTemplateContent;
}

/**
 * Template definition
 */
export interface TemplateDefinition
{
    name: string;
    channels: NotificationChannel[];
    /**
     * Content without a locale: the last fallback, and all a template that
     * has no `locales` needs.
     */
    email?: EmailTemplateContent;
    sms?: SmsTemplateContent;
    slack?: SlackTemplateContent;
    /**
     * Content per locale tag (`ko`, `en`, `ko-KR`). A send's `locale` picks
     * the exact tag, then its base language, then `defaultLocale`, then the
     * content above. Tags match case-insensitively.
     */
    locales?: Record<string, LocaleTemplateContent>;
    /**
     * Locale used when the send names none, or names one the template lacks.
     */
    defaultLocale?: string;
    /**
     * The rendered output carries a credential (OTP code, magic link, …).
     * Sends using a sensitive template keep content and template data out of
     * history rows. A per-send `sensitive` value overrides this.
     */
    sensitive?: boolean;
}

/**
 * Rendered template result
 */
export interface RenderedTemplate
{
    email?: EmailTemplateContent;
    sms?: SmsTemplateContent;
    slack?: SlackTemplateContent;
}

/**
 * Template data (variables for substitution)
 */
export type TemplateData = Record<string, unknown>;
