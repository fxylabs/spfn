/**
 * @spfn/notification - FCM HTTP v1 provider
 *
 * One request per device to
 * `POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`.
 * Credentials come from `google-auth-library` (optional peer dependency):
 * a service-account JSON in SPFN_NOTIFICATION_FCM_SERVICE_ACCOUNT, or
 * Application Default Credentials when it is unset.
 */

import type { PushMessage, PushProvider, PushProviderResult, PushOptions } from '../types';
import type { PushInvalidationReason } from '../../../entities';
import { env } from '../../../config';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmCredentials
{
    projectId: string;
    getAccessToken(): Promise<string>;
}

export interface FcmProviderConfig
{
    /**
     * Resolves the project and an access token. Defaults to
     * google-auth-library with the env configuration.
     */
    credentials?: () => Promise<FcmCredentials>;
    fetch?: typeof fetch;
}

/**
 * FCM error codes that mean the token is dead
 */
const INVALIDATING: Record<string, PushInvalidationReason> = {
    UNREGISTERED: 'unregistered',
    SENDER_ID_MISMATCH: 'sender_mismatch',
};

const WEBPUSH_TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

const RETRYABLE = new Set(['QUOTA_EXCEEDED', 'UNAVAILABLE', 'INTERNAL']);

export function createFcmProvider(config: FcmProviderConfig = {}): PushProvider
{
    const loadCredentials = memoize(config.credentials ?? googleAuthCredentials);
    const doFetch = config.fetch ?? fetch;

    return {
        name: 'fcm',
        async send(message: PushMessage): Promise<PushProviderResult>
        {
            const credentials = await loadCredentials();
            const response = await doFetch(
                `https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`,
                {
                    method: 'POST',
                    headers: {
                        'authorization': `Bearer ${await credentials.getAccessToken()}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({ message: buildFcmMessage(message) }),
                },
            );

            return response.ok
                ? { success: true, messageId: ((await response.json()) as { name?: string }).name }
                : failure(response.status, (await response.json().catch(() => ({}))) as FcmErrorBody);
        },
    };
}

/**
 * The FCM `message` for one device: notification, data, and each platform's
 * block, with the raw `fcm` override merged last.
 */
export function buildFcmMessage(message: PushMessage): Record<string, unknown>
{
    const options = message.options ?? {};
    const silent = options.contentAvailable === true;
    const high = (options.priority ?? (silent ? 'normal' : 'high')) === 'high';

    const built: Record<string, unknown> = {
        token: message.token,
        ...(!silent && (message.title || message.body) ? { notification: { title: message.title, body: message.body } } : {}),
        ...(message.data ? { data: message.data } : {}),
        android: androidBlock(options, high),
        apns: apnsBlock(options, high, silent),
        webpush: webpushBlock(options, high),
    };

    return deepMerge(built, message.fcm ?? {});
}

function androidBlock(options: PushOptions, high: boolean): Record<string, unknown>
{
    return prune({
        priority: high ? 'HIGH' : 'NORMAL',
        ttl: options.ttlSeconds !== undefined ? `${options.ttlSeconds}s` : undefined,
        collapse_key: options.collapseKey,
        notification: options.sound ? { sound: options.sound } : undefined,
    });
}

function apnsBlock(options: PushOptions, high: boolean, silent: boolean): Record<string, unknown>
{
    return {
        headers: prune({
            'apns-priority': silent ? '5' : (high ? '10' : '5'),
            'apns-push-type': silent ? 'background' : 'alert',
            'apns-expiration': options.ttlSeconds !== undefined
                ? String(Math.floor(Date.now() / 1000) + options.ttlSeconds)
                : undefined,
            'apns-collapse-id': options.collapseKey,
        }),
        payload: {
            aps: prune({
                'badge': options.badge,
                'sound': options.sound,
                'content-available': silent ? 1 : undefined,
            }),
        },
    };
}

function webpushBlock(options: PushOptions, high: boolean): Record<string, unknown>
{
    return {
        headers: prune({
            TTL: options.ttlSeconds !== undefined ? String(options.ttlSeconds) : undefined,
            Urgency: high ? 'high' : 'normal',
            // Web push allows a Topic of at most 32 URL-safe base64 characters;
            // any other collapse key would get the whole message rejected.
            Topic: options.collapseKey && WEBPUSH_TOPIC.test(options.collapseKey) ? options.collapseKey : undefined,
        }),
    };
}

interface FcmErrorBody
{
    error?: {
        status?: string;
        message?: string;
        details?: {
            '@type'?: string;
            errorCode?: string;
            fieldViolations?: { field?: string }[];
        }[];
    };
}

function failure(httpStatus: number, body: FcmErrorBody): PushProviderResult
{
    const code = body.error?.details?.find(d => d.errorCode)?.errorCode ?? body.error?.status ?? `HTTP_${httpStatus}`;

    return {
        success: false,
        error: `${code}: ${body.error?.message ?? 'FCM request failed'}`,
        invalidToken: INVALIDATING[code] ?? (code === 'INVALID_ARGUMENT' && rejectsToken(body) ? 'invalid_token' : undefined),
        retryable: RETRYABLE.has(code) || httpStatus === 429 || httpStatus >= 500,
    };
}

/**
 * INVALID_ARGUMENT also covers a bad payload, which says nothing about the
 * device. Only a field violation on `message.token` means the token itself
 * is malformed and will fail every send.
 */
function rejectsToken(body: FcmErrorBody): boolean
{
    return body.error?.details?.some(detail => detail.fieldViolations?.some(violation => violation.field === 'message.token')) ?? false;
}

async function googleAuthCredentials(): Promise<FcmCredentials>
{
    const library = await import('google-auth-library').catch(() => undefined);

    if (!library)
    {
        throw new Error('FCM push needs the google-auth-library package: pnpm add google-auth-library');
    }

    const { GoogleAuth } = library;
    const serviceAccount = env.SPFN_NOTIFICATION_FCM_SERVICE_ACCOUNT
        ? parseServiceAccount(env.SPFN_NOTIFICATION_FCM_SERVICE_ACCOUNT)
        : undefined;
    const auth = new GoogleAuth({ credentials: serviceAccount, scopes: [FCM_SCOPE] });
    const projectId = env.SPFN_NOTIFICATION_FCM_PROJECT_ID ?? serviceAccount?.project_id ?? await auth.getProjectId();

    return {
        projectId,
        async getAccessToken()
        {
            const token = await auth.getAccessToken();

            if (!token)
            {
                throw new Error('FCM: no access token from google-auth-library');
            }

            return token;
        },
    };
}

/**
 * Parse the service-account JSON without letting a parse error quote it:
 * V8's message includes the text around the error, which can be the key.
 */
function parseServiceAccount(raw: string): { project_id?: string }
{
    const parsed = parseJson(raw);

    if (!isPlainObject(parsed))
    {
        throw new Error('SPFN_NOTIFICATION_FCM_SERVICE_ACCOUNT is not valid JSON');
    }

    return parsed as { project_id?: string };
}

function parseJson(raw: string): unknown
{
    try
    {
        return JSON.parse(raw);
    }
    catch
    {
        return undefined;
    }
}

/**
 * Resolve once; a failed resolution is retried on the next call.
 */
function memoize<T>(load: () => Promise<T>): () => Promise<T>
{
    let pending: Promise<T> | undefined;

    return () =>
    {
        if (!pending)
        {
            pending = load();
            pending.catch(() =>
            {
                pending = undefined;
            });
        }

        return pending;
    };
}

function prune<T extends Record<string, unknown>>(value: T): Partial<T>
{
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown>
{
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override))
    {
        merged[key] = isPlainObject(value) && isPlainObject(merged[key])
            ? deepMerge(merged[key] as Record<string, unknown>, value)
            : value;
    }

    return merged;
}

export const fcmProvider = createFcmProvider();
