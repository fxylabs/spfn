/**
 * @spfn/notification - Server Exports
 *
 * Use this for server-side notification sending
 *
 * @example
 * ```typescript
 * import {
 *     sendEmail,
 *     sendSMS,
 *     registerTemplate,
 *     configureNotification
 * } from '@spfn/notification/server';
 *
 * // Configure
 * configureNotification({
 *     email: { from: 'noreply@example.com' },
 *     defaults: { appName: 'MyApp' }
 * });
 *
 * // Send
 * await sendEmail({
 *     to: 'user@example.com',
 *     template: 'verification-code',
 *     data: { code: '123456' }
 * });
 * ```
 */

// Configuration
export {
    configureNotification,
    getNotificationConfig,
    getEmailFrom,
    getEmailReplyTo,
    getSmsDefaultCountryCode,
    getAppName,
    type NotificationConfig,
} from './config';

// Channels
export {
    sendEmail,
    sendEmailBulk,
    registerEmailProvider,
    sendSMS,
    sendSMSBulk,
    registerSMSProvider,
    sendSlack,
    sendSlackBulk,
    registerSlackProvider,
    sendPush,
    sendPushBulk,
    registerPushProvider,
    createFcmProvider,
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
    type NotificationChannel,
    type SendResult,
    type SendEmailParams,
    type EmailProvider,
    type SendSMSParams,
    type SMSProvider,
    type SendSlackParams,
    type SlackProvider,
    type BulkEmailResult,
    type BulkEmailOptions,
    type BulkSMSResult,
    type BulkSMSOptions,
    type BulkSlackResult,
    type BulkSlackOptions,
} from './channels';

// Scheduling
export {
    scheduleEmail,
    scheduleSMS,
    schedulePush,
    type ScheduleOptions,
    type ScheduleResult,
} from './services/schedule.service';

// Templates
export {
    registerTemplate,
    getTemplate,
    hasTemplate,
    renderTemplate,
    getTemplateNames,
    registerFilter,
    registerBuiltinTemplates,
    type TemplateDefinition,
    type TemplateData,
    type EmailTemplateContent,
    type SmsTemplateContent,
    type SlackTemplateContent,
} from './templates';

// Entities
export {
    notifications,
    NOTIFICATION_CHANNELS,
    NOTIFICATION_STATUSES,
    type Notification,
    type NewNotification,
    type NotificationStatus,
    pushDevices,
    PUSH_PLATFORMS,
    type PushDevice,
    type PushPlatform,
    type PushInvalidationReason,
} from './entities';

// Services
export {
    createNotificationRecord,
    createScheduledNotification,
    updateNotificationJobId,
    markNotificationSent,
    markNotificationFailed,
    markNotificationPending,
    claimNotificationForJob,
    markNotificationCancelled,
    markNotificationSkipped,
    findNotificationByJobId,
    findNotifications,
    findScheduledNotifications,
    countNotifications,
    getNotificationStats,
    type FindNotificationsOptions,
    type NotificationStats,
} from './services/notification.service';

export {
    cancelNotification,
    cancelNotificationsByReference,
    type CancelResult,
} from './services/cancel.service';

export { MAX_IDEMPOTENCY_KEY_LENGTH } from './services/idempotency.service';

export {
    registerPushDevice,
    unregisterPushDevice,
    invalidatePushToken,
    listPushDevices,
    findPushDeviceByToken,
    type RegisterPushDeviceParams,
    type PushDeviceSelector,
} from './services/push-device.service';

export {
    registerSendGuard,
    type SendGuard,
    type SendGuardContext,
} from './services/send-guard.service';

// Jobs
export {
    sendScheduledEmailJob,
    sendScheduledSmsJob,
    sendScheduledPushJob,
    sendBulkEmailItemJob,
    sendBulkSmsItemJob,
    sendBulkSlackItemJob,
    notificationJobRouter,
} from './jobs';

// Integrations
// @deprecated — Use createMonitorErrorHandler() from @spfn/monitor/server instead
export {
    createErrorSlackNotifier,
    type ErrorSlackOptions,
} from './integrations/error-slack';

// Tracking
export { trackingRouter } from './tracking';
export { processTrackingHtml } from './tracking';
export {
    getTrackingStats,
    getEngagementStats,
    getClickDetails,
    type TrackingStats,
    type EngagementStats,
    type ClickDetail,
} from './tracking';
export {
    trackingEvents,
    TRACKING_EVENT_TYPES,
    type TrackingEvent,
    type TrackingEventType,
} from './entities';
export {
    isTrackingEnabled,
    getTrackingSecret,
    getTrackingBaseUrl,
} from './config';

// Privacy helpers (masking for application-side logging)
export {
    maskEmail,
    maskPhone,
    maskRecipient,
    maskRecipients,
    scrubProviderError,
    scrubSendResult,
} from './privacy';

// Auto-register built-in templates
import { registerBuiltinTemplates } from './templates';
registerBuiltinTemplates();
