/**
 * @spfn/notification - Channels
 */

export type { NotificationChannel, SendResult, SendErrorCode, ChannelProvider } from './types';

// Email
export {
    sendEmail,
    sendEmailBulk,
    registerEmailProvider,
    type SendEmailParams,
    type EmailAttachment,
    type EmailProvider,
    type BulkEmailResult,
    type BulkEmailOptions,
} from './email';
export { SES_MAX_MESSAGE_BYTES } from './email/providers/aws-ses';

// SMS
export {
    sendSMS,
    sendSMSBulk,
    registerSMSProvider,
    type SendSMSParams,
    type SMSProvider,
    type BulkSMSResult,
    type BulkSMSOptions,
} from './sms';

// Push
export {
    sendPush,
    sendPushBulk,
    registerPushProvider,
    createFcmProvider,
    buildFcmMessage,
    MAX_PUSH_PAYLOAD_BYTES,
    type SendPushParams,
    type PushTarget,
    type PushOptions,
    type PushMessage,
    type PushProvider,
    type PushProviderResult,
    type PushResult,
    type PushDeviceResult,
    type BulkPushResult,
    type FcmProviderConfig,
    type FcmCredentials,
} from './push';

// Slack
export {
    sendSlack,
    sendSlackBulk,
    registerSlackProvider,
    type SendSlackParams,
    type SlackProvider,
    type BulkSlackResult,
    type BulkSlackOptions,
} from './slack';
