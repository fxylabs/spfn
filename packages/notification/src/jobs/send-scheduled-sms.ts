/**
 * @spfn/notification - Scheduled SMS Job
 */

import { job } from '@spfn/core/job';
import { Type } from '@sinclair/typebox';
import { deliverSMS } from '../channels/sms';
import { runScheduledSend } from './run-scheduled-send';

/**
 * Job input schema
 */
const SendScheduledSmsInput = Type.Object({
    notificationId: Type.Number(),
    to: Type.Union([Type.String(), Type.Array(Type.String())]),
    message: Type.Optional(Type.String()),
    template: Type.Optional(Type.String()),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    sensitive: Type.Optional(Type.Boolean()),
    locale: Type.Optional(Type.String()),
    claimToken: Type.Optional(Type.String()),
    guard: Type.Optional(Type.String()),
    referenceType: Type.Optional(Type.String()),
    referenceId: Type.Optional(Type.String()),
});

/**
 * Scheduled SMS sending job
 */
export const sendScheduledSmsJob = job('notification.send-scheduled-sms')
    .input(SendScheduledSmsInput)
    .options({
        retryLimit: 3,
        retryDelay: 5000,
    })
    .handler(async (input) =>
    {
        const { notificationId, claimToken, guard, referenceType, referenceId, ...smsParams } = input;
        const context = { channel: 'sms' as const, referenceType, referenceId, data: smsParams.data };

        await runScheduledSend(
            notificationId,
            claimToken,
            () => deliverSMS(smsParams, notificationId),
            guard ? { name: guard, context } : undefined,
        );
    });
