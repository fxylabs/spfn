/**
 * @spfn/notification - Channel Types
 */

/**
 * Channel types
 */
export type NotificationChannel = 'email' | 'sms' | 'slack' | 'push';

/**
 * Send result
 */
export interface SendResult
{
    success: boolean;
    messageId?: string;
    error?: string;
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
