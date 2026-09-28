/**
 * @spfn/notification - Push Channel Types
 */

import type { SendResult } from '../types';
import type { PushPlatform, PushInvalidationReason } from '../../entities';
import type { PushDeviceSelector } from '../../services/push-device.service';

/**
 * Delivery options, mapped onto each platform's FCM block.
 */
export interface PushOptions
{
    /**
     * `high` wakes the device; `normal` may be batched. Default `high` for a
     * visible push, `normal` for a silent one.
     */
    priority?: 'high' | 'normal';
    /**
     * Drop the push if it cannot be delivered within this many seconds
     */
    ttlSeconds?: number;
    /**
     * Pushes with the same key replace each other on the device
     */
    collapseKey?: string;
    badge?: number;
    sound?: string;
    /**
     * Silent push: no title/body is shown; the app is woken with `data`
     */
    contentAvailable?: boolean;
}

/**
 * Who a push goes to. `ownerId` fans out to the owner's active devices
 * (all of them unless `devices` narrows it); `token`/`tokens` address
 * devices directly.
 */
export type PushTarget =
    | { ownerId: string; devices?: PushDeviceSelector }
    | { token: string }
    | { tokens: string[] };

export interface SendPushParams
{
    to: PushTarget;
    title?: string;
    body?: string;
    /**
     * Delivered to the app; FCM requires string values
     */
    data?: Record<string, string>;
    template?: string;
    /**
     * Template variables (rendered into title, body and data)
     */
    templateData?: Record<string, unknown>;
    /**
     * Locale for a template with `locales`. A registered device's own locale
     * wins; this applies to devices without one.
     */
    locale?: string;
    options?: PushOptions;
    /**
     * Raw FCM `message` fields merged over the generated ones (escape hatch)
     */
    fcm?: Record<string, unknown>;
    /**
     * Keep title/body/data out of history rows
     */
    sensitive?: boolean;
    /**
     * Per device: a retry with the same key reaches each device at most once.
     * See the idempotency section of the README.
     */
    idempotencyKey?: string;
}

/**
 * One device's message, as a provider sends it
 */
export interface PushMessage
{
    token: string;
    platform?: PushPlatform;
    title?: string;
    body?: string;
    data?: Record<string, string>;
    options?: PushOptions;
    fcm?: Record<string, unknown>;
}

export interface PushProviderResult extends SendResult
{
    /**
     * The provider says this token will never work again
     */
    invalidToken?: PushInvalidationReason;
    /**
     * A transient failure (rate limit, provider outage)
     */
    retryable?: boolean;
}

export interface PushProvider
{
    name: string;
    send(message: PushMessage): Promise<PushProviderResult>;
}

export interface PushDeviceResult extends SendResult
{
    /**
     * A failure the provider called transient
     */
    retryable?: boolean;
    deviceId?: string;
    platform?: PushPlatform;
    /**
     * Masked token, safe to log
     */
    token: string;
}

export interface PushResult extends SendResult
{
    /**
     * On failure: whether a retry could help (some device failed transiently)
     */
    retryable?: boolean;
    results: PushDeviceResult[];
    successCount: number;
    failureCount: number;
}
