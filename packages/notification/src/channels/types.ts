/**
 * @spfn/notification - Channel Types
 */

/**
 * Channel types
 */
export type NotificationChannel = 'email' | 'sms' | 'slack' | 'push';

/**
 * Why a send failed, for the failures an app has to tell apart from the rest.
 * `error` stays the human-readable text; this is what to branch on.
 *
 * - `attachment_invalid`: an attachment broke the contract (empty filename,
 *   control characters in `filename`, a malformed `contentType`, no bytes).
 * - `attachments_unsupported`: the provider does not declare
 *   `supportsAttachments`, so it would have dropped them.
 * - `attachments_not_deferrable`: a scheduled or distributed send carried
 *   attachments; those payloads are stored as JSON jobs.
 * - `message_too_large`: over the provider's message size limit, refused
 *   before the call or reported by the provider.
 */
export type SendErrorCode =
    | 'attachment_invalid'
    | 'attachments_unsupported'
    | 'attachments_not_deferrable'
    | 'message_too_large';

/**
 * Send result
 */
export interface SendResult
{
    success: boolean;
    messageId?: string;
    error?: string;
    /**
     * Set on the failures listed under `SendErrorCode`; a provider may set it
     * too (`message_too_large` when its service rejects the size).
     */
    errorCode?: SendErrorCode;
    /**
     * The idempotency key was already used: the provider was not called, and
     * this reports the first send (`success: true` once it was sent).
     */
    deduplicated?: boolean;
}

/**
 * Channel provider interface
 */
export interface ChannelProvider<TSendParams, TResult = SendResult>
{
    name: string;
    send(params: TSendParams): Promise<TResult>;
}
