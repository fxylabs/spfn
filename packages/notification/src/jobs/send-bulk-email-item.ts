/**
 * @spfn/notification - Bulk Email Item Job
 *
 * Processes a single email item from a distributed bulk send.
 * Notification record and tracking are already applied by sendEmailBulk().
 * This job just sends via provider and updates history.
 *
 * Uses batchSize so pg-boss workers fetch multiple items at once
 * and process them in parallel across instances.
 */

import { job } from '@spfn/core/job';
import { Type } from '@sinclair/typebox';
import { awsSesProvider } from '../channels/email/providers/aws-ses';
import { runBulkItemSend } from './run-scheduled-send';

const SendBulkEmailItemInput = Type.Object({
    notificationId: Type.Number(),
    claimToken: Type.Optional(Type.String()),
    to: Type.Array(Type.String()),
    from: Type.String(),
    replyTo: Type.Optional(Type.String()),
    subject: Type.String(),
    text: Type.Optional(Type.String()),
    html: Type.Optional(Type.String()),
});

export const sendBulkEmailItemJob = job('notification.send-bulk-email-item')
    .input(SendBulkEmailItemInput)
    .options({
        retryLimit: 3,
        retryDelay: 5000,
        batchSize: 50,
    })
    .handler(async (input) =>
    {
        const { notificationId, claimToken, ...emailParams } = input;

        await runBulkItemSend(notificationId, claimToken, () => awsSesProvider.send(emailParams));
    });
