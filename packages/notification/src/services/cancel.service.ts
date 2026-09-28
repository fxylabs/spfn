/**
 * @spfn/notification - Cancel Service
 *
 * Cancel scheduled notifications
 */

import { getBoss } from '@spfn/core/job';
import { findOne } from '@spfn/core/db';
import { logger } from '@spfn/core/logger';
import { notifications, type Notification } from '../entities';
import { markNotificationCancelled } from './notification.service';
import { sendScheduledEmailJob } from '../jobs/send-scheduled-email';
import { sendScheduledSmsJob } from '../jobs/send-scheduled-sms';

const log = logger.child('@spfn/notification:cancel');

export interface CancelResult
{
    success: boolean;
    /**
     * Whether the queued pg-boss job was also removed. `false` does not mean
     * the notification may still go out: the job skips a cancelled row.
     */
    jobCancelled?: boolean;
    error?: string;
}

const SCHEDULED_QUEUES: Partial<Record<Notification['channel'], string>> = {
    email: sendScheduledEmailJob.name,
    sms: sendScheduledSmsJob.name,
};

/**
 * Cancel a scheduled notification by ID.
 *
 * `success: true` means the notification will not be sent: the row moved from
 * `scheduled` to `cancelled` in one guarded update, and the scheduled job
 * skips cancelled rows. Removing the queued job afterwards is cleanup only.
 */
export async function cancelNotification(notificationId: number): Promise<CancelResult>
{
    try
    {
        if (!(await markNotificationCancelled(notificationId)))
        {
            return refusal(notificationId);
        }

        const notification = await findOne(notifications, { id: notificationId });

        return { success: true, jobCancelled: await cancelQueuedJob(notification) };
    }
    catch (error)
    {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to cancel notification',
        };
    }
}

async function refusal(notificationId: number): Promise<CancelResult>
{
    const notification = await findOne(notifications, { id: notificationId });

    return {
        success: false,
        error: notification
            ? `Cannot cancel notification with status: ${notification.status}`
            : 'Notification not found',
    };
}

/**
 * Best-effort removal of the queued job. Never fails the cancel: the row is
 * already cancelled, which is what stops the send.
 */
async function cancelQueuedJob(notification: Notification | null): Promise<boolean>
{
    const queueName = notification ? SCHEDULED_QUEUES[notification.channel] : undefined;
    const boss = getBoss();

    if (!notification?.jobId || !queueName || !boss)
    {
        return false;
    }

    try
    {
        await boss.cancel(queueName, notification.jobId);

        return true;
    }
    catch (error)
    {
        log.warn('Failed to cancel queued job; the job will skip the cancelled row', error as Error);

        return false;
    }
}

/**
 * Cancel all scheduled notifications for a reference
 */
export async function cancelNotificationsByReference(
    referenceType: string,
    referenceId: string,
): Promise<{ cancelled: number; errors: number }>
{
    const { findMany } = await import('@spfn/core/db');
    const { eq, and, inArray, isNotNull } = await import('drizzle-orm');

    // Same rows markNotificationCancelled accepts: waiting to send, or
    // failed and waiting for a pg-boss retry.
    const scheduledNotifications = await findMany(notifications, {
        where: and(
            eq(notifications.referenceType, referenceType),
            eq(notifications.referenceId, referenceId),
            isNotNull(notifications.scheduledAt),
            inArray(notifications.status, ['scheduled', 'failed']),
        ),
    });

    let cancelled = 0;
    let errors = 0;

    for (const notification of scheduledNotifications)
    {
        const result = await cancelNotification(notification.id);

        if (result.success)
        {
            cancelled++;
        }
        else
        {
            errors++;
        }
    }

    return { cancelled, errors };
}
