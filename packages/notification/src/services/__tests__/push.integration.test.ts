/**
 * GitHub #116 send path, against PostgreSQL with a fake provider:
 * multi-device selection (D9-D14), what FCM's answers do to the device
 * store, per-device idempotency and locale, and scheduled pushes.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDatabase } from '@spfn/core/db';
import { notifications, pushDevices } from '../../entities';
import { configureNotification } from '../../config';
import { sendPush, sendPushBulk, registerPushProvider, type PushMessage, type PushProviderResult } from '../../channels/push';
import { registerTemplate } from '../../templates';
import { registerPushDevice, listPushDevices } from '../push-device.service';
import { schedulePush } from '../schedule.service';
import { registerSendGuard } from '../send-guard.service';
import { sendScheduledPushJob } from '../../jobs/send-scheduled-push';
import { setupTestDb, teardownTestDb, clearTables } from '../../__tests__/helpers/db';

const send = vi.fn(async (_m: PushMessage): Promise<PushProviderResult> => ({ success: true, messageId: 'm-1' }));
registerPushProvider({ name: 'fcm', send: (m) => send(m) });
const enqueue = vi.spyOn(sendScheduledPushJob, 'send').mockImplementation(async () => 'job-1');

const HISTORY_RESET = { storeContent: true, storeRecipient: 'raw' as const, hashSecret: undefined };
const sentTokens = () => send.mock.calls.map(([m]) => m.token).sort();
const history = () => getDatabase('write').select().from(notifications);

async function devicesAB()
{
    await registerPushDevice({ ownerId: 'A', token: 'tok-ios', platform: 'ios', deviceId: 'X' });
    await new Promise(resolve => setTimeout(resolve, 5));
    await registerPushDevice({ ownerId: 'A', token: 'tok-android', platform: 'android', deviceId: 'Y' });
}

beforeAll(setupTestDb);
afterAll(teardownTestDb);

beforeEach(async () =>
{
    await clearTables();
    configureNotification({ enableHistory: true, history: HISTORY_RESET });
    send.mockReset();
    send.mockImplementation(async () => ({ success: true, messageId: 'm-1' }));
    enqueue.mockClear();
});

afterEach(() =>
{
    configureNotification({ enableHistory: false, history: HISTORY_RESET });
});

describe('#116 multi-device selection', () =>
{
    it('D9 an owner with two devices: both receive', async () =>
    {
        await devicesAB();

        const result = await sendPush({ to: { ownerId: 'A' }, title: 'Hi' });

        expect(sentTokens()).toEqual(['tok-android', 'tok-ios']);
        expect(result).toMatchObject({ success: true, successCount: 2, failureCount: 0 });
        expect(await history()).toHaveLength(2);
    });

    it('D10 platforms: ios only', async () =>
    {
        await devicesAB();

        await sendPush({ to: { ownerId: 'A', devices: { platforms: ['ios'] } }, title: 'Hi' });

        expect(sentTokens()).toEqual(['tok-ios']);
    });

    it('D11 latest: 1 → only the most recently seen device', async () =>
    {
        await devicesAB();

        await sendPush({ to: { ownerId: 'A', devices: { latest: 1 } }, title: 'Hi' });

        expect(sentTokens()).toEqual(['tok-android']);
    });

    it('deviceIds: only the named device', async () =>
    {
        await devicesAB();

        await sendPush({ to: { ownerId: 'A', devices: { deviceIds: ['X'] } }, title: 'Hi' });

        expect(sentTokens()).toEqual(['tok-ios']);
    });

    it('D12 an invalidated device is not sent to', async () =>
    {
        await devicesAB();
        await getDatabase('write').update(pushDevices).set({ invalidatedAt: new Date(), invalidatedReason: 'unregistered' })
            .where(eq(pushDevices.token, 'tok-android'));

        await sendPush({ to: { ownerId: 'A' }, title: 'Hi' });

        expect(sentTokens()).toEqual(['tok-ios']);
    });

    it('D13 an owner with no active device: no_devices, provider not called', async () =>
    {
        const result = await sendPush({ to: { ownerId: 'nobody' }, title: 'Hi' });

        expect(result).toMatchObject({ success: false, error: 'no_devices', results: [] });
        expect(send).not.toHaveBeenCalled();
    });

    it('D14 schedule, then a new device registers: the job sends to it too', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok-ios', platform: 'ios' });
        await schedulePush({ to: { ownerId: 'A' }, title: 'Later' }, { scheduledAt: new Date(Date.now() + 60_000) });
        await registerPushDevice({ ownerId: 'A', token: 'tok-new', platform: 'android' });

        await sendScheduledPushJob.handler!(enqueue.mock.calls[0][0] as never);

        expect(sentTokens()).toEqual(['tok-ios', 'tok-new']);
    });

    it('direct tokens are sent without a device lookup', async () =>
    {
        await sendPush({ to: { tokens: ['raw-1', 'raw-2'] }, title: 'Hi' });

        expect(sentTokens()).toEqual(['raw-1', 'raw-2']);
    });
});

describe('#116 what FCM answers do to the device store', () =>
{
    it.each([
        ['unregistered' as const],
        ['sender_mismatch' as const],
    ])('%s: the token is invalidated, the other device is untouched', async (reason) =>
    {
        await devicesAB();
        send.mockImplementation(async (m) => (m.token === 'tok-ios'
            ? { success: false, error: 'dead', invalidToken: reason }
            : { success: true, messageId: 'm-2' }));

        const result = await sendPush({ to: { ownerId: 'A' }, title: 'Hi' });

        expect(result).toMatchObject({ success: false, successCount: 1, failureCount: 1 });
        expect((await listPushDevices('A')).map(d => d.token)).toEqual(['tok-android']);
    });

    it('INVALID_ARGUMENT (no invalidToken): no device is invalidated', async () =>
    {
        await devicesAB();
        send.mockImplementation(async () => ({ success: false, error: 'INVALID_ARGUMENT: bad payload' }));

        await sendPush({ to: { ownerId: 'A' }, title: 'Hi' });

        expect(await listPushDevices('A')).toHaveLength(2);
    });

    it('results carry masked tokens only', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'abcdefghijklmnopqrstuvwxyz', platform: 'ios' });

        const result = await sendPush({ to: { ownerId: 'A' }, title: 'Hi' });

        expect(result.results[0].token).toBe('abcdef…wxyz');
        expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    });
});

describe('#116 per-device idempotency, locale, validation', () =>
{
    it('a retry with the same key reaches only the device that failed', async () =>
    {
        await devicesAB();
        send.mockImplementation(async (m) => (m.token === 'tok-ios'
            ? { success: false, error: 'UNAVAILABLE', retryable: true }
            : { success: true, messageId: 'm-2' }));
        await sendPush({ to: { ownerId: 'A' }, title: 'Hi', idempotencyKey: 'p1' });
        send.mockReset();
        send.mockImplementation(async () => ({ success: true, messageId: 'm-3' }));

        const retry = await sendPush({ to: { ownerId: 'A' }, title: 'Hi', idempotencyKey: 'p1' });

        expect(sentTokens()).toEqual(['tok-ios']);
        expect(retry).toMatchObject({ success: true, deduplicated: true, successCount: 2 });
    });

    it('each device renders in its own locale; a device without one uses the send locale', async () =>
    {
        registerTemplate({
            name: 'greet-push',
            channels: ['push'],
            defaultLocale: 'en',
            locales: { ko: { push: { title: '안녕 {{name}}' } }, en: { push: { title: 'Hi {{name}}' } } },
        });
        await registerPushDevice({ ownerId: 'A', token: 'tok-ko', platform: 'ios', locale: 'ko-KR' });
        await registerPushDevice({ ownerId: 'A', token: 'tok-none', platform: 'android' });

        await sendPush({ to: { ownerId: 'A' }, template: 'greet-push', templateData: { name: 'Min' }, locale: 'en' });

        const titles = Object.fromEntries(send.mock.calls.map(([m]) => [m.token, m.title]));
        expect(titles).toEqual({ 'tok-ko': '안녕 Min', 'tok-none': 'Hi Min' });
        expect((await history()).map(r => r.locale).sort()).toEqual(['en', 'ko']);
    });

    it.each([
        ['no title, body or data', { title: undefined }, 'Push needs a title or body'],
        ['a non-string data value', { title: 'Hi', data: { n: 1 as unknown as string } }, 'must be strings'],
        ['a payload over 4096 bytes', { title: 'Hi', body: 'x'.repeat(5000) }, 'FCM allows 4096'],
    ])('refuses %s before the provider', async (_label, content, error) =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok', platform: 'ios' });

        const result = await sendPush({ to: { ownerId: 'A' }, ...content });

        expect(result.results[0].error).toContain(error);
        expect(send).not.toHaveBeenCalled();
        expect(await history()).toHaveLength(0);
    });

    it('a silent push with data needs no title', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok', platform: 'ios' });

        await expect(sendPush({ to: { ownerId: 'A' }, data: { sync: '1' }, options: { contentAvailable: true } }))
            .resolves.toMatchObject({ success: true });
    });

    it('a sensitive push keeps title and body out of history', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok', platform: 'ios' });

        await sendPush({ to: { ownerId: 'A' }, title: 'Code 123456', body: 'secret', sensitive: true });

        expect((await history())[0]).toMatchObject({ subject: null, content: null });
    });

    it('bulk: each item fans out to its own owner', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'a', platform: 'ios' });
        await registerPushDevice({ ownerId: 'B', token: 'b', platform: 'ios' });

        const result = await sendPushBulk([{ to: { ownerId: 'A' }, title: 'x' }, { to: { ownerId: 'nobody' }, title: 'y' }, { to: { ownerId: 'B' }, title: 'z' }]);

        expect(sentTokens()).toEqual(['a', 'b']);
        expect(result).toMatchObject({ successCount: 2, failureCount: 1 });
    });
});

describe('#116 scheduled push', () =>
{
    it('a retry after a partial failure reaches only the device that failed', async () =>
    {
        await devicesAB();
        await schedulePush({ to: { ownerId: 'A' }, title: 'Later' }, { scheduledAt: new Date(Date.now() + 60_000) });
        const job = enqueue.mock.calls[0][0];
        send.mockImplementation(async (m) => (m.token === 'tok-ios' ? { success: false, error: 'UNAVAILABLE', retryable: true } : { success: true, messageId: 'm' }));

        await expect(sendScheduledPushJob.handler!(job as never)).rejects.toThrow();
        send.mockReset();
        send.mockImplementation(async () => ({ success: true, messageId: 'm2' }));
        await sendScheduledPushJob.handler!(job as never);

        expect(sentTokens()).toEqual(['tok-ios']);
    });

    it('a guard that says no: nothing sent, scheduled row skipped', async () =>
    {
        await devicesAB();
        registerSendGuard('push-guard-no', () => false);
        const scheduled = await schedulePush({ to: { ownerId: 'A' }, title: 'Later' }, { scheduledAt: new Date(Date.now() + 60_000), guard: 'push-guard-no' });

        await sendScheduledPushJob.handler!(enqueue.mock.calls[0][0] as never);

        expect(send).not.toHaveBeenCalled();
        const [row] = await getDatabase('write').select().from(notifications).where(eq(notifications.id, scheduled.notificationId!));
        expect(row.status).toBe('skipped');
    });

    it('an unknown template is refused at schedule time', async () =>
    {
        await expect(schedulePush({ to: { ownerId: 'A' }, template: 'nope' }, { scheduledAt: new Date() }))
            .resolves.toEqual({ success: false, error: 'Template not found: nope' });
        expect(enqueue).not.toHaveBeenCalled();
    });
});

describe('review round 4', () =>
{
    it('B1 a provider that throws: a failed device result (not a rejection), and a keyed retry reaches the device', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok-1234567890abc', platform: 'ios' });
        send.mockImplementationOnce(async () =>
        {
            throw new TypeError('fetch failed: secret-looking text');
        });

        const first = await sendPush({ to: { ownerId: 'A' }, title: 'Hi', idempotencyKey: 'b1' });

        expect(first).toMatchObject({ success: false, retryable: true });
        expect(first.results[0].error).toBe('fcm request failed (TypeError)');
        expect(JSON.stringify(first)).not.toContain('secret-looking');
        expect((await history())[0]).toMatchObject({ status: 'failed' });

        await expect(sendPush({ to: { ownerId: 'A' }, title: 'Hi', idempotencyKey: 'b1' })).resolves.toMatchObject({ success: true });
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('N2 a scheduled push that failed for good (bad payload): row failed, the job does not throw', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok', platform: 'ios' });
        const scheduled = await schedulePush({ to: { ownerId: 'A' }, title: 'Hi' }, { scheduledAt: new Date(Date.now() + 60_000) });
        send.mockImplementation(async () => ({ success: false, error: 'INVALID_ARGUMENT: bad' }));

        await expect(sendScheduledPushJob.handler!(enqueue.mock.calls[0][0] as never)).resolves.toBeUndefined();

        const [row] = await getDatabase('write').select().from(notifications).where(eq(notifications.id, scheduled.notificationId!));
        expect(row.status).toBe('failed');
    });

    it('N2 a scheduled push with no devices: row failed, no retry', async () =>
    {
        await schedulePush({ to: { ownerId: 'nobody' }, title: 'Hi' }, { scheduledAt: new Date(Date.now() + 60_000) });

        await expect(sendScheduledPushJob.handler!(enqueue.mock.calls[0][0] as never)).resolves.toBeUndefined();
    });

    it('N2 a transient failure still throws so pg-boss retries', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok', platform: 'ios' });
        await schedulePush({ to: { ownerId: 'A' }, title: 'Hi' }, { scheduledAt: new Date(Date.now() + 60_000) });
        send.mockImplementation(async () => ({ success: false, error: 'UNAVAILABLE', retryable: true }));

        await expect(sendScheduledPushJob.handler!(enqueue.mock.calls[0][0] as never)).rejects.toThrow();
    });

    it('round 5: a database error while claiming one device key keeps the scheduled job retrying', async () =>
    {
        await devicesAB();
        await schedulePush({ to: { ownerId: 'A' }, title: 'Hi' }, { scheduledAt: new Date(Date.now() + 60_000) });
        const insert = vi.spyOn(getDatabase('write'), 'insert');
        insert.mockImplementationOnce(() =>
        {
            throw new Error('connection reset');
        });

        await expect(sendScheduledPushJob.handler!(enqueue.mock.calls[0][0] as never)).rejects.toThrow();
        insert.mockRestore();
    });
});
