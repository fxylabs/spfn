/**
 * @spfn/notification - Scheduled Email Job
 */

import { job } from '@spfn/core/job';
import { Type } from '@sinclair/typebox';
import { deliverEmail } from '../channels/email';
import { runScheduledSend } from './run-scheduled-send';

/**
 * Job input schema
 */
const SendScheduledEmailInput = Type.Object({
    notificationId: Type.Number(),
    to: Type.Union([Type.String(), Type.Array(Type.String())]),
    subject: Type.Optional(Type.String()),
    template: Type.Optional(Type.String()),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    text: Type.Optional(Type.String()),
    html: Type.Optional(Type.String()),
    from: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    claimToken: Type.Optional(Type.String()),
    guard: Type.Optional(Type.String()),
    referenceType: Type.Optional(Type.String()),
    referenceId: Type.Optional(Type.String()),
});

/**
 * Scheduled email sending job
 */
export const sendScheduledEmailJob = job('notification.send-scheduled-email')
    .input(SendScheduledEmailInput)
    .options({
        retryLimit: 3,
        retryDelay: 5000,
    })
    .handler(async (input) =>
    {
        const { notificationId, claimToken, guard, referenceType, referenceId, ...emailParams } = input;
        const context = { channel: 'email' as const, referenceType, referenceId, data: emailParams.data };

        await runScheduledSend(
            notificationId,
            claimToken,
            () => deliverEmail(emailParams, notificationId),
            guard ? { name: guard, context } : undefined,
        );
    });
