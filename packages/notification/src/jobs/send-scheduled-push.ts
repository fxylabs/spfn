/**
 * @spfn/notification - Scheduled Push Job
 */

import { job } from '@spfn/core/job';
import { Type } from '@sinclair/typebox';
import type { SendResult } from '../channels/types';
import type { SendPushParams } from '../channels/push/types';
import { sendPush } from '../channels/push';
import { isHistoryEnabled } from '../config';
import { runScheduledSend } from './run-scheduled-send';

const SendScheduledPushInput = Type.Object({
    notificationId: Type.Number(),
    claimToken: Type.Optional(Type.String()),
    guard: Type.Optional(Type.String()),
    referenceType: Type.Optional(Type.String()),
    referenceId: Type.Optional(Type.String()),
    /**
     * The SendPushParams given to schedulePush. Devices are resolved when the
     * job runs, so a device registered after scheduling is included.
     */
    params: Type.Unknown(),
});

/**
 * Scheduled push sending job
 */
export const sendScheduledPushJob = job('notification.send-scheduled-push')
    .input(SendScheduledPushInput)
    .options({
        retryLimit: 3,
        retryDelay: 5000,
    })
    .handler(async (input) =>
    {
        const { notificationId, claimToken, guard, referenceType, referenceId } = input;
        const params = input.params as SendPushParams;
        const context = { channel: 'push' as const, referenceType, referenceId, data: params.templateData ?? params.data };

        await runScheduledSend(
            notificationId,
            claimToken,
            () => sendScheduledPush(notificationId, params),
            guard ? { name: guard, context } : undefined,
        );
    });

/**
 * Send to the owner's devices. Each device is keyed by this schedule, so a
 * pg-boss retry after a partial failure reaches only the devices that did
 * not get it.
 */
async function sendScheduledPush(notificationId: number, params: SendPushParams): Promise<SendResult & { retryable?: boolean }>
{
    const result = await sendPush({
        ...params,
        idempotencyKey: isHistoryEnabled() ? `scheduled-push:${notificationId}` : undefined,
    });
    const messageIds = result.results.filter(r => r.messageId).map(r => r.messageId).join(',');

    return { success: result.success, messageId: messageIds || undefined, error: result.error, retryable: result.retryable };
}
