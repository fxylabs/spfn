/**
 * @spfn/notification - Idempotency Service
 *
 * A keyed send claims its history row before calling the provider. The row is
 * unique per (channel, idempotency key, recipient), so the claim is what makes
 * a retried send reach the provider at most once.
 */

import { getDatabase } from '@spfn/core/db';
import { and, eq, sql } from 'drizzle-orm';
import { notifications, type Notification, type NewNotification } from '../entities';
import { isHistoryEnabled } from '../config';
import type { SendResult } from '../channels/types';

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * History row a keyed send claims. The recipient is the stored value
 * (hashed when history hashing is on), which is also what the key is unique by.
 */
export type KeyedRow = Omit<NewNotification, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
    idempotencyKey: string;
};

export type KeyedClaim =
    | { claimed: true; id: number }
    | { claimed: false; existing: Notification | null; result: SendResult };

/**
 * Why a key cannot be used, or undefined when it can (or none was given).
 */
export function idempotencyKeyError(key: string | undefined): string | undefined
{
    if (key === undefined)
    {
        return undefined;
    }

    if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)
    {
        return `idempotencyKey must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`;
    }

    return isHistoryEnabled() ? undefined : 'idempotencyKey requires notification history';
}

/**
 * Insert the row, or take over a `failed` row with the same key. Any other
 * existing row (sent, pending, scheduled, cancelled, skipped) means the key is
 * spent and nothing may be sent.
 */
export async function claimKeyedSend(
    row: KeyedRow,
    status: 'pending' | 'scheduled' = 'pending',
): Promise<KeyedClaim>
{
    const [claimed] = await getDatabase('write')
        .insert(notifications)
        .values({ ...row, status })
        .onConflictDoUpdate({
            target: [notifications.channel, notifications.idempotencyKey, notifications.recipient],
            targetWhere: sql`${notifications.idempotencyKey} is not null`,
            set: {
                ...row,
                status,
                // A new owner: the job that failed this row must not send it again.
                claimToken: row.claimToken ?? null,
                errorMessage: null,
                providerMessageId: null,
                sentAt: null,
                jobId: null,
            },
            setWhere: eq(notifications.status, 'failed'),
        })
        .returning({ id: notifications.id });

    if (claimed)
    {
        return { claimed: true, id: claimed.id };
    }

    const existing = await findKeyedRow(row);

    return { claimed: false, existing, result: duplicateResult(existing) };
}

/**
 * Read from the write connection: a replica may not have the row yet.
 */
async function findKeyedRow(row: KeyedRow): Promise<Notification | null>
{
    const [existing] = await getDatabase('write')
        .select()
        .from(notifications)
        .where(and(
            eq(notifications.channel, row.channel),
            eq(notifications.idempotencyKey, row.idempotencyKey),
            eq(notifications.recipient, row.recipient),
        ))
        .limit(1);

    return existing ?? null;
}

function duplicateResult(existing: Notification | null): SendResult
{
    if (existing?.status === 'sent')
    {
        return { success: true, messageId: existing.providerMessageId ?? undefined, deduplicated: true };
    }

    const inProgress = !existing || existing.status === 'pending' || existing.status === 'scheduled';

    return {
        success: false,
        deduplicated: true,
        error: inProgress ? 'send in progress' : `already ${existing.status}`,
    };
}
