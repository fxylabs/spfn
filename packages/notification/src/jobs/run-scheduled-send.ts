/**
 * @spfn/notification - Scheduled send runner
 *
 * Shared by the scheduled email and SMS jobs.
 */

import type { SendResult } from '../channels/types';
import {
    claimScheduledNotification,
    markNotificationSent,
    markNotificationFailed,
} from '../services/notification.service';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:scheduled');

/**
 * Send a scheduled notification unless its row was cancelled or already sent.
 *
 * A skipped row returns normally: throwing would make pg-boss retry a send
 * that must never happen. A failed send throws so pg-boss retries it.
 */
export async function runScheduledSend(
    notificationId: number,
    send: () => Promise<SendResult>,
): Promise<'sent' | 'skipped'>
{
    if (!(await claimScheduledNotification(notificationId)))
    {
        log.info('Scheduled notification skipped: no longer sendable', { notificationId });

        return 'skipped';
    }

    const result = await send();

    if (!result.success)
    {
        await markNotificationFailed(notificationId, result.error || 'Unknown error');
        throw new Error(result.error || 'Failed to send scheduled notification');
    }

    await markNotificationSent(notificationId, result.messageId);

    return 'sent';
}
