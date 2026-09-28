/**
 * @spfn/notification - Scheduled send runner
 *
 * Shared by the scheduled email and SMS jobs.
 */

import type { SendResult } from '../channels/types';
import {
    claimNotificationForJob,
    markNotificationSent,
    markNotificationFailed,
} from '../services/notification.service';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:scheduled');

/**
 * Send a scheduled notification unless its row was cancelled, already sent,
 * or taken over by a keyed send.
 *
 * A skipped row returns normally: throwing would make pg-boss retry a send
 * that must never happen. A failed send throws so pg-boss retries it.
 */
export async function runScheduledSend(
    notificationId: number,
    claimToken: string | undefined,
    send: () => Promise<SendResult>,
): Promise<'sent' | 'skipped'>
{
    if (!(await claimNotificationForJob(notificationId, claimToken)))
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

/**
 * Send one item of a distributed bulk send. With history off there is no row
 * (`notificationId` 0), so there is nothing to claim or record.
 */
export async function runBulkItemSend(
    notificationId: number,
    claimToken: string | undefined,
    send: () => Promise<SendResult>,
): Promise<void>
{
    if (notificationId > 0)
    {
        await runScheduledSend(notificationId, claimToken, send);

        return;
    }

    const result = await send();

    if (!result.success)
    {
        throw new Error(result.error || 'Failed to send bulk item');
    }
}
