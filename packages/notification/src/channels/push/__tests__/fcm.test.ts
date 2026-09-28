/**
 * FCM HTTP v1 provider: the response table from the #116 design, and the
 * message each option produces. No network: fetch and credentials are
 * injected.
 */

import { describe, it, expect, vi } from 'vitest';
import { createFcmProvider, buildFcmMessage } from '../providers/fcm';

function providerAnswering(status: number, body: unknown)
{
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
    const provider = createFcmProvider({
        credentials: async () => ({ projectId: 'proj-1', getAccessToken: async () => 'access-1' }),
        fetch: fetch as unknown as typeof globalThis.fetch,
    });

    return { provider, fetch };
}

const fcmError = (status: string, errorCode?: string) => ({
    error: {
        status,
        message: 'boom',
        details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [],
    },
});

describe('FCM response table', () =>
{
    it('200: success with the message name', async () =>
    {
        const { provider, fetch } = providerAnswering(200, { name: 'projects/proj-1/messages/m-1' });

        await expect(provider.send({ token: 't', title: 'Hi' })).resolves.toEqual({
            success: true,
            messageId: 'projects/proj-1/messages/m-1',
        });

        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-1');
    });

    it.each([
        [404, 'NOT_FOUND', 'UNREGISTERED', 'unregistered', false],
        [403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH', 'sender_mismatch', false],
        [400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', undefined, false],
        [401, 'UNAUTHENTICATED', 'THIRD_PARTY_AUTH_ERROR', undefined, false],
        [429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', undefined, true],
        [503, 'UNAVAILABLE', 'UNAVAILABLE', undefined, true],
        [500, 'INTERNAL', 'INTERNAL', undefined, true],
    ])('%i %s/%s → invalidToken %s, retryable %s', async (status, grpc, code, invalidToken, retryable) =>
    {
        const { provider } = providerAnswering(status, fcmError(grpc, code));

        const result = await provider.send({ token: 't', title: 'Hi' });

        expect(result).toMatchObject({ success: false, retryable });
        expect(result.invalidToken).toBe(invalidToken);
        expect(result.error).toContain(code);
    });

    it('an error body without FcmError details falls back to the status', async () =>
    {
        const { provider } = providerAnswering(404, fcmError('NOT_FOUND'));

        await expect(provider.send({ token: 't', title: 'Hi' })).resolves.toMatchObject({ success: false, error: 'NOT_FOUND: boom' });
    });

    it('credentials resolve once across sends', async () =>
    {
        const credentials = vi.fn(async () => ({ projectId: 'p', getAccessToken: async () => 'a' }));
        const fetch = vi.fn(async () => new Response('{"name":"m"}', { status: 200 }));
        const provider = createFcmProvider({ credentials, fetch: fetch as unknown as typeof globalThis.fetch });

        await provider.send({ token: 't', title: 'x' });
        await provider.send({ token: 't', title: 'x' });

        expect(credentials).toHaveBeenCalledTimes(1);
    });
});

describe('FCM message', () =>
{
    it('visible push: notification block, high priority, alert push type', () =>
    {
        const message = buildFcmMessage({ token: 't', title: 'Hi', body: 'There', data: { k: 'v' } });

        expect(message).toMatchObject({
            token: 't',
            notification: { title: 'Hi', body: 'There' },
            data: { k: 'v' },
            android: { priority: 'HIGH' },
            apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' } },
            webpush: { headers: { Urgency: 'high' } },
        });
    });

    it('silent push: no notification block, background push type, content-available', () =>
    {
        const message = buildFcmMessage({ token: 't', data: { sync: '1' }, options: { contentAvailable: true } });

        expect(message.notification).toBeUndefined();
        expect(message).toMatchObject({
            android: { priority: 'NORMAL' },
            apns: {
                headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
                payload: { aps: { 'content-available': 1 } },
            },
        });
    });

    it('ttl, collapse key, badge and sound map onto every platform', () =>
    {
        const message = buildFcmMessage({
            token: 't',
            title: 'Hi',
            options: { ttlSeconds: 60, collapseKey: 'c', badge: 3, sound: 'ping.caf' },
        });

        expect(message).toMatchObject({
            android: { ttl: '60s', collapse_key: 'c', notification: { sound: 'ping.caf' } },
            apns: { headers: { 'apns-collapse-id': 'c' }, payload: { aps: { badge: 3, sound: 'ping.caf' } } },
            webpush: { headers: { TTL: '60', Topic: 'c' } },
        });
        expect(Number((message.apns as any).headers['apns-expiration'])).toBeGreaterThan(Date.now() / 1000);
    });

    it('the raw fcm override is merged last and deep', () =>
    {
        const message = buildFcmMessage({
            token: 't',
            title: 'Hi',
            fcm: { android: { priority: 'NORMAL', restricted_package_name: 'app' } },
        });

        expect(message.android).toMatchObject({ priority: 'NORMAL', restricted_package_name: 'app' });
        expect(message.apns).toBeDefined();
    });
});

describe('review round 4', () =>
{
    it('webpush Topic is set only for a valid topic', () =>
    {
        const valid = buildFcmMessage({ token: 't', title: 'x', options: { collapseKey: 'order_1-a' } });
        const invalid = buildFcmMessage({ token: 't', title: 'x', options: { collapseKey: 'order 1:shipped' } });

        expect((valid.webpush as any).headers.Topic).toBe('order_1-a');
        expect((invalid.webpush as any).headers.Topic).toBeUndefined();
        expect((invalid.android as any).collapse_key).toBe('order 1:shipped');
    });
});
