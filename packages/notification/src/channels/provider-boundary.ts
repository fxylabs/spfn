/**
 * @spfn/notification - The channel's provider boundary
 */

import type { SendResult } from './types';
import { scrubSendResult } from '../privacy';

/**
 * Call a provider and take its answer at the boundary — a refusal it returns
 * and one it throws alike.
 *
 * A provider's failure is free text that routinely quotes the recipient, and
 * a custom provider may throw it as readily as return it (`550 5.1.1
 * <user@example.com>: mailbox unavailable`). Both become a failed `SendResult`
 * with the scrubbed text, so the channel writes its masked "send failed" line
 * and closes the history row for either, and its caller gets a result, never
 * the raw error: `sendEmail`, `sendSMS` and `sendSlack` do not throw. The
 * thrown value itself goes no further — its stack repeats the message
 * unscrubbed.
 * `attachments` are the send's own, whose filenames are removed as well.
 */
export function sendThroughProvider(
    send: () => Promise<SendResult>,
    attachments: readonly { filename: string }[] | null = [],
): Promise<SendResult>
{
    return Promise.resolve()
        .then(send)
        .then(
            result => scrubSendResult(result, attachments),
            (thrown: unknown) => scrubSendResult({ success: false, error: thrownText(thrown) }, attachments),
        );
}

/**
 * The text of a thrown value: an Error's message, anything else as a string.
 * Reading that text is itself able to throw (`Object.create(null)`, a
 * `toString` that throws, an `Error` whose `message` getter throws) — a
 * second failure the boundary answers the same fixed way as an empty one.
 */
function thrownText(thrown: unknown): string
{
    try
    {
        return (thrown instanceof Error ? thrown.message : String(thrown)) || 'Unknown error';
    }
    catch
    {
        return 'Unknown error';
    }
}
