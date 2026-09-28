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
    markNotificationSkipped,
} from '../services/notification.service';
import { getSendGuard, type SendGuard, type SendGuardContext } from '../services/send-guard.service';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:scheduled');

/**
 * The guard a scheduled send names, and what it is called with.
 */
export interface ScheduledGuard
{
    name: string;
    context: Omit<SendGuardContext, 'notificationId'>;
}

export type ScheduledOutcome = 'sent' | 'skipped' | 'not-sendable' | 'guard-missing' | 'failed';

/**
 * Send a scheduled notification unless its row was cancelled, already sent,
 * or taken over by a keyed send — and, when it names a guard, unless the
 * guard says no.
 *
 * Outcomes that must not be retried return normally: throwing would make
 * pg-boss run them again. A failed send or a throwing guard throws so pg-boss
 * retries it.
 */
export async function runScheduledSend(
    notificationId: number,
    claimToken: string | undefined,
    send: () => Promise<SendResult & { retryable?: boolean }>,
    guard?: ScheduledGuard,
): Promise<ScheduledOutcome>
{
    if (!(await claimNotificationForJob(notificationId, claimToken)))
    {
        log.info('Scheduled notification skipped: no longer sendable', { notificationId });

        return 'not-sendable';
    }

    const verdict = guard ? await checkGuard(notificationId, guard) : 'send';

    if (verdict !== 'send')
    {
        return verdict;
    }

    const result = await send();

    if (!result.success)
    {
        await markNotificationFailed(notificationId, result.error || 'Unknown error');

        // A send that says a retry cannot help ends here instead of burning retries.
        if (result.retryable === false)
        {
            return 'failed';
        }

        throw new Error(result.error || 'Failed to send scheduled notification');
    }

    await markNotificationSent(notificationId, result.messageId);

    return 'sent';
}

async function checkGuard(
    notificationId: number,
    { name, context }: ScheduledGuard,
): Promise<'send' | 'skipped' | 'guard-missing'>
{
    const guard = getSendGuard(name);

    if (!guard)
    {
        // Configuration, not a transient failure: a retry would find it missing too.
        log.error('Scheduled notification not sent: send guard not registered', { notificationId, guard: name });
        await markNotificationFailed(notificationId, `Send guard not registered: ${name}`);

        return 'guard-missing';
    }

    const outcome = await callGuard(guard, { ...context, notificationId });

    if ('error' in outcome)
    {
        await markNotificationFailed(notificationId, `Send guard ${name} failed: ${outcome.error.message}`);
        throw outcome.error;
    }

    if (!outcome.allowed)
    {
        log.info('Scheduled notification skipped by its send guard', { notificationId, guard: name });
        await markNotificationSkipped(notificationId);

        return 'skipped';
    }

    return 'send';
}

async function callGuard(
    guard: SendGuard,
    context: SendGuardContext,
): Promise<{ allowed: boolean } | { error: Error }>
{
    try
    {
        return { allowed: await guard(context) };
    }
    catch (error)
    {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }
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
