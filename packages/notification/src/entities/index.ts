/**
 * @spfn/notification - Entities
 */

export { notificationSchema } from './schema';

export {
    notifications,
    NOTIFICATION_CHANNELS,
    NOTIFICATION_STATUSES,
    type Notification,
    type NewNotification,
    type NotificationChannel,
    type NotificationStatus,
} from './notifications';

export {
    trackingEvents,
    TRACKING_EVENT_TYPES,
    type TrackingEvent,
    type NewTrackingEvent,
    type TrackingEventType,
} from './tracking-events';

export {
    pushDevices,
    PUSH_PLATFORMS,
    PUSH_INVALIDATION_REASONS,
    type PushDevice,
    type NewPushDevice,
    type PushPlatform,
    type PushInvalidationReason,
} from './push-devices';
