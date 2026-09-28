/**
 * @spfn/notification - Notification Service
 *
 * Core service for tracking notification history
 */

import { create, createMany, findOne, findMany, updateOne, count, getDatabase } from '@spfn/core/db';
import { desc, eq, and, gte, lte, inArray, isNotNull, sql, count as drizzleCount } from 'drizzle-orm';
import {
    notifications,
    type Notification,
    type NewNotification,
    type NotificationChannel,
    type NotificationStatus,
} from '../entities';
import { historyRecipientFilter, scrubProviderError } from '../privacy';

/**
 * Create notification record (pending status)
 */
export async function createNotificationRecord(
    data: Omit<NewNotification, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Notification>
{
    return await create(notifications, {
        ...data,
        status: 'pending',
    });
}

/**
 * Bulk create notification records (pending status)
 */
export async function createNotificationRecords(
    data: Omit<NewNotification, 'id' | 'createdAt' | 'updatedAt'>[],
): Promise<Notification[]>
{
    return await createMany(notifications, data.map((d) => ({
        ...d,
        status: 'pending' as const,
    })));
}

/**
 * Create scheduled notification record
 */
export async function createScheduledNotification(
    data: Omit<NewNotification, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
        scheduledAt: Date;
    },
): Promise<Notification>
{
    return await create(notifications, {
        ...data,
        status: 'scheduled',
    });
}

/**
 * Update job ID for scheduled notification
 */
export async function updateNotificationJobId(
    id: number,
    jobId: string,
): Promise<Notification | null>
{
    return await updateOne(notifications, { id }, { jobId });
}

/**
 * Mark notification as sent
 */
export async function markNotificationSent(
    id: number,
    providerMessageId?: string,
): Promise<Notification | null>
{
    return await updateOne(
        notifications,
        { id },
        {
            status: 'sent',
            sentAt: new Date(),
            providerMessageId,
        },
    );
}

/**
 * Mark notification as failed.
 *
 * The message is scrubbed here as well as at the channel boundary: this is the
 * only place the value reaches the column, so a caller that assembled the text
 * itself cannot write a raw address into a row whose recipient is hashed.
 */
export async function markNotificationFailed(
    id: number,
    errorMessage: string,
): Promise<Notification | null>
{
    return await updateOne(
        notifications,
        { id },
        {
            status: 'failed',
            errorMessage: scrubProviderError(errorMessage),
        },
    );
}

/**
 * Mark many notifications as sent in a SINGLE UPDATE, preserving each row's
 * providerMessageId via a CASE (a bulk send used to fan out N concurrent
 * single-row UPDATEs). drizzle handles column names/escaping; values are bound.
 */
export async function markManySent(
    items: Array<{ id: number; providerMessageId?: string }>,
): Promise<void>
{
    if (items.length === 0)
    {
        return;
    }

    const cases = sql.join(
        items.map(it => sql`when ${it.id} then ${it.providerMessageId ?? null}`),
        sql` `,
    );

    await getDatabase('write')
        .update(notifications)
        .set({
            status: 'sent',
            sentAt: new Date(),
            // ELSE keeps the existing value and anchors the CASE result type to text.
            providerMessageId: sql`case ${notifications.id} ${cases} else ${notifications.providerMessageId} end`,
        })
        .where(inArray(notifications.id, items.map(it => it.id)));
}

/**
 * Mark many notifications as failed in a SINGLE UPDATE, preserving each row's
 * errorMessage via a CASE.
 */
export async function markManyFailed(
    items: Array<{ id: number; errorMessage: string }>,
): Promise<void>
{
    if (items.length === 0)
    {
        return;
    }

    // Scrubbed the same way as the single-row path; still a plain bound value.
    const cases = sql.join(
        items.map(it => sql`when ${it.id} then ${scrubProviderError(it.errorMessage)}`),
        sql` `,
    );

    await getDatabase('write')
        .update(notifications)
        .set({
            status: 'failed',
            errorMessage: sql`case ${notifications.id} ${cases} else ${notifications.errorMessage} end`,
        })
        .where(inArray(notifications.id, items.map(it => it.id)));
}

/**
 * Mark scheduled notification as pending (job started)
 */
export async function markNotificationPending(
    id: number,
): Promise<Notification | null>
{
    return await updateOne(
        notifications,
        { id },
        { status: 'pending' },
    );
}

/**
 * Statuses a job may claim a row from. `pending` and `failed` are pg-boss
 * retries (a worker that died mid-send, a failed attempt); `cancelled` and
 * `sent` are never claimed.
 */
const CLAIMABLE_STATUSES: NotificationStatus[] = ['scheduled', 'pending', 'failed'];

/**
 * Move a row a queued job is about to send to `pending`, if it may still be
 * sent and still belongs to that job.
 *
 * One guarded UPDATE: a concurrent cancel either lands first (this returns
 * false and nothing is sent) or loses (the cancel sees `pending` and
 * refuses). `claimToken` is the token the job was enqueued with; a keyed
 * send that took the row over replaced it, so the old job stands down.
 */
export async function claimNotificationForJob(id: number, claimToken?: string): Promise<boolean>
{
    const rows = await getDatabase('write')
        .update(notifications)
        .set({ status: 'pending' })
        .where(and(
            eq(notifications.id, id),
            inArray(notifications.status, CLAIMABLE_STATUSES),
            sql`${notifications.claimToken} is not distinct from ${claimToken ?? null}`,
        ))
        .returning({ id: notifications.id });

    return rows.length > 0;
}

/**
 * Mark a claimed row `skipped`: its send guard said the send is no longer
 * wanted.
 */
export async function markNotificationSkipped(id: number): Promise<void>
{
    await getDatabase('write')
        .update(notifications)
        .set({ status: 'skipped' })
        .where(and(eq(notifications.id, id), eq(notifications.status, 'pending')));
}

/**
 * Mark a scheduled row `cancelled` while it is waiting: `scheduled`, or
 * `failed` between pg-boss retries.
 *
 * Only updates the record — it does not touch the queued job. The scheduled
 * job skips any row this has cancelled, so the record is what stops the send.
 * Use `cancelNotification` to also remove the queued job.
 */
export async function markNotificationCancelled(id: number): Promise<boolean>
{
    const rows = await getDatabase('write')
        .update(notifications)
        .set({ status: 'cancelled' })
        .where(and(
            eq(notifications.id, id),
            isNotNull(notifications.scheduledAt),
            inArray(notifications.status, ['scheduled', 'failed']),
        ))
        .returning({ id: notifications.id });

    return rows.length > 0;
}

/**
 * Find notification by job ID
 */
export async function findNotificationByJobId(
    jobId: string,
): Promise<Notification | null>
{
    return await findOne(notifications, { jobId });
}

/**
 * Query options for finding notifications
 */
export interface FindNotificationsOptions
{
    channel?: NotificationChannel;
    status?: NotificationStatus;
    recipient?: string;
    referenceType?: string;
    referenceId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
}

/**
 * Find notifications with filters
 */
export async function findNotifications(
    options: FindNotificationsOptions = {},
): Promise<Notification[]>
{
    const conditions = [];

    if (options.channel)
    {
        conditions.push(eq(notifications.channel, options.channel));
    }
    if (options.status)
    {
        conditions.push(eq(notifications.status, options.status));
    }
    if (options.recipient)
    {
        // Filters go through the same transform stored values did, so lookups
        // work whether recipients are stored raw or hashed.
        conditions.push(eq(notifications.recipient, historyRecipientFilter(options.recipient)));
    }
    if (options.referenceType)
    {
        conditions.push(eq(notifications.referenceType, options.referenceType));
    }
    if (options.referenceId)
    {
        conditions.push(eq(notifications.referenceId, options.referenceId));
    }
    if (options.from)
    {
        conditions.push(gte(notifications.createdAt, options.from));
    }
    if (options.to)
    {
        conditions.push(lte(notifications.createdAt, options.to));
    }

    return await findMany(notifications, {
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(notifications.createdAt),
        limit: options.limit,
        offset: options.offset,
    });
}

/**
 * Count notifications with filters
 */
export async function countNotifications(
    options: Omit<FindNotificationsOptions, 'limit' | 'offset'> = {},
): Promise<number>
{
    const conditions = [];

    if (options.channel)
    {
        conditions.push(eq(notifications.channel, options.channel));
    }
    if (options.status)
    {
        conditions.push(eq(notifications.status, options.status));
    }
    if (options.recipient)
    {
        conditions.push(eq(notifications.recipient, historyRecipientFilter(options.recipient)));
    }

    if (conditions.length > 0)
    {
        return await count(notifications, and(...conditions));
    }

    return await count(notifications);
}

/**
 * Get notification statistics
 */
export interface NotificationStats
{
    total: number;
    scheduled: number;
    pending: number;
    sent: number;
    failed: number;
    cancelled: number;
    skipped: number;
}

export async function getNotificationStats(
    options: { channel?: NotificationChannel; from?: Date; to?: Date } = {},
): Promise<NotificationStats>
{
    // One GROUP BY instead of six separate COUNT(*) scans. Also honours from/to
    // (the previous per-status countNotifications path ignored the date range).
    const conditions = [];
    if (options.channel)
    {
        conditions.push(eq(notifications.channel, options.channel));
    }
    if (options.from)
    {
        conditions.push(gte(notifications.createdAt, options.from));
    }
    if (options.to)
    {
        conditions.push(lte(notifications.createdAt, options.to));
    }

    const rows = await getDatabase('read')
        .select({ status: notifications.status, count: drizzleCount() })
        .from(notifications)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(notifications.status);

    const stats: NotificationStats = {
        total: 0, scheduled: 0, pending: 0, sent: 0, failed: 0, cancelled: 0, skipped: 0,
    };

    for (const row of rows)
    {
        const n = Number(row.count);
        stats.total += n;
        if (row.status && row.status in stats)
        {
            stats[row.status as keyof Omit<NotificationStats, 'total'>] = n;
        }
    }

    return stats;
}

/**
 * Find scheduled notifications (for dashboard)
 */
export async function findScheduledNotifications(
    options: {
        channel?: NotificationChannel;
        from?: Date;
        to?: Date;
        limit?: number;
        offset?: number;
    } = {},
): Promise<Notification[]>
{
    const conditions = [eq(notifications.status, 'scheduled')];

    if (options.channel)
    {
        conditions.push(eq(notifications.channel, options.channel));
    }
    if (options.from)
    {
        conditions.push(gte(notifications.scheduledAt, options.from));
    }
    if (options.to)
    {
        conditions.push(lte(notifications.scheduledAt, options.to));
    }

    return await findMany(notifications, {
        where: and(...conditions),
        orderBy: desc(notifications.scheduledAt),
        limit: options.limit,
        offset: options.offset,
    });
}
