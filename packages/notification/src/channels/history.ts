/**
 * @spfn/notification - Send history lifecycle shared by the channels
 */

import type { SendResult } from './types';
import type { NewNotification } from '../entities';
import { isHistoryEnabled } from '../config';
import { runWithConcurrency } from './concurrency';
import {
    createNotificationRecord,
    createNotificationRecords,
    markNotificationSent,
    markNotificationFailed,
} from '../services/notification.service';
import { claimKeyedSend } from '../services/idempotency.service';
import type { logger } from '@spfn/core/logger';

type Log = ReturnType<typeof logger.child>;

export type HistoryRowData = Omit<NewNotification, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

/**
 * `stop` is set when the send must not reach the provider.
 */
export interface OpenedHistory
{
    historyId?: number;
    stop?: SendResult;
}

/**
 * Builds a row lazily: building can throw (hashed recipients without a
 * secret), and must not run at all when history is off.
 */
export type HistoryRowBuilder = () => HistoryRowData;

/**
 * Open the history row for one send.
 *
 * Unkeyed: best effort — a failed build or insert is logged and the send goes
 * ahead. Keyed: the row is the idempotency claim, so any failure stops the send.
 */
export async function openHistoryRow(
    buildRow: HistoryRowBuilder,
    idempotencyKey: string | undefined,
    log: Log,
): Promise<OpenedHistory>
{
    if (idempotencyKey !== undefined)
    {
        return claimRow(buildRow, idempotencyKey, log);
    }

    if (!isHistoryEnabled())
    {
        return {};
    }

    try
    {
        return { historyId: (await createNotificationRecord(buildRow())).id };
    }
    catch (error)
    {
        log.warn('Failed to create notification history record', error as Error);

        return {};
    }
}

async function claimRow(buildRow: HistoryRowBuilder, idempotencyKey: string, log: Log): Promise<OpenedHistory>
{
    try
    {
        const claim = await claimKeyedSend({ ...buildRow(), idempotencyKey });

        return claim.claimed ? { historyId: claim.id } : { stop: claim.result };
    }
    catch (error)
    {
        log.warn('Failed to claim idempotency key; nothing was sent', error as Error);

        return { stop: { success: false, error: 'Failed to record the idempotency key; nothing was sent' } };
    }
}

export interface BulkHistoryItem
{
    buildRow: HistoryRowBuilder;
    idempotencyKey?: string;
}

/**
 * Open history rows for a bulk send, aligned with `items`. Unkeyed rows are
 * one batched INSERT (best effort, as for a single send); keyed rows are
 * claimed one by one, and a spent key comes back as `stop`.
 */
export async function openBulkHistoryRows(items: BulkHistoryItem[], log: Log): Promise<OpenedHistory[]>
{
    const opened: OpenedHistory[] = items.map(() => ({}));
    const positions = items.map((item, index) => ({ item, index }));
    const unkeyed = positions.filter(({ item }) => item.idempotencyKey === undefined);
    const keyed = positions.filter(({ item }) => item.idempotencyKey !== undefined);

    if (isHistoryEnabled() && unkeyed.length > 0)
    {
        try
        {
            const records = await createNotificationRecords(unkeyed.map(({ item }) => item.buildRow()));

            records.forEach((record, i) =>
            {
                opened[unkeyed[i].index] = { historyId: record.id };
            });
        }
        catch (error)
        {
            log.warn('Failed to batch create notification history records', error as Error);
        }
    }

    const claims = await runWithConcurrency(keyed, ({ item }) => claimRow(item.buildRow, item.idempotencyKey!, log));

    claims.forEach((claim, i) =>
    {
        opened[keyed[i].index] = claim;
    });

    return opened;
}

/**
 * Split bulk items into those to send (with their history ids) and those a
 * spent idempotency key stopped.
 */
export function splitStopped<T extends { index: number }>(
    prepared: T[],
    opened: OpenedHistory[],
): { sendable: T[]; historyIds: (number | undefined)[]; stopped: { index: number; result: SendResult }[] }
{
    const sendable: T[] = [];
    const historyIds: (number | undefined)[] = [];
    const stopped: { index: number; result: SendResult }[] = [];

    prepared.forEach((item, i) =>
    {
        const { stop, historyId } = opened[i];

        if (stop)
        {
            stopped.push({ index: item.index, result: stop });
        }
        else
        {
            sendable.push(item);
            historyIds.push(historyId);
        }
    });

    return { sendable, historyIds, stopped };
}

/**
 * Record the provider's answer on the row.
 *
 * Unkeyed sends leave this off the send path (fire-and-forget). A keyed send
 * awaits it, so a retry right after a success finds `sent`, not `pending`.
 */
export async function closeHistoryRow(
    historyId: number | undefined,
    result: SendResult,
    keyed: boolean,
    log: Log,
): Promise<void>
{
    if (!historyId)
    {
        return;
    }

    const update = (result.success
        ? markNotificationSent(historyId, result.messageId)
        : markNotificationFailed(historyId, result.error || 'Unknown error'))
        .then(() => undefined, error => log.warn('Failed to update notification history record', error as Error));

    if (keyed)
    {
        await update;
    }
}
