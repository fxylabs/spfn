/**
 * @spfn/notification
 *
 * Multi-channel notification system for SPFN
 *
 * @example
 * ```typescript
 * import { sendEmail, sendSMS } from '@spfn/notification/server';
 *
 * // Send email with template
 * await sendEmail({
 *     to: 'user@example.com',
 *     template: 'verification-code',
 *     data: { code: '123456' }
 * });
 *
 * // Send SMS
 * await sendSMS({
 *     to: '+821012345678',
 *     template: 'verification-code',
 *     data: { code: '123456' }
 * });
 * ```
 */

// Types only (for client-side imports)
export type { NotificationChannel, SendResult } from './channels/types';
export type { SendEmailParams } from './channels/email/types';
export type { SendSMSParams } from './channels/sms/types';
export type { SendSlackParams } from './channels/slack/types';
export type { SendPushParams, PushTarget, PushOptions, PushResult } from './channels/push/types';
export type {
    TemplateDefinition,
    TemplateData,
    EmailTemplateContent,
    SmsTemplateContent,
    SlackTemplateContent,
} from './templates/types';
