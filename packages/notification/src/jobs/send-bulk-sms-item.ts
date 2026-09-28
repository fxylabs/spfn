/**
 * @spfn/notification - Bulk SMS Item Job
 *
 * Processes a single SMS item from a distributed bulk send.
 */

import { job } from '@spfn/core/job';
import { Type } from '@sinclair/typebox';
import { awsSnsProvider } from '../channels/sms/providers/aws-sns';
import { runBulkItemSend } from './run-scheduled-send';

const SendBulkSmsItemInput = Type.Object({
    notificationId: Type.Number(),
    claimToken: Type.Optional(Type.String()),
    to: Type.String(),
    message: Type.String(),
});

export const sendBulkSmsItemJob = job('notification.send-bulk-sms-item')
    .input(SendBulkSmsItemInput)
    .options({
        retryLimit: 3,
        retryDelay: 5000,
        batchSize: 50,
    })
    .handler(async (input) =>
    {
        const { notificationId, claimToken, ...smsParams } = input;

        await runBulkItemSend(notificationId, claimToken, () => awsSnsProvider.send(smsParams));
    });
