/**
 * GitHub #112: a cancelled scheduled notification is never sent.
 *
 * Real PostgreSQL, because the guarantee is a status-guarded UPDATE: the
 * scheduled job claims a row and a cancel marks it, and whichever lands first
 * decides. Each negative row states what must not happen.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDatabase, findOne } from '@spfn/core/db';

const { getBoss } = vi.hoisted(() => ({ getBoss: vi.fn((): unknown => undefined) }));

vi.mock('@spfn/core/job', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getBoss,
}));

import { notifications, type NotificationStatus } from '../../entities';
import { createScheduledNotification, claimNotificationForJob, markNotificationCancelled } from '../notification.service';
import { cancelNotification } from '../cancel.service';
import * as notificationService from '../notification.service';
import { runScheduledSend } from '../../jobs/run-scheduled-send';
import { setupTestDb, teardownTestDb, clearTables } from '../../__tests__/helpers/db';

async function seed(status: NotificationStatus = 'scheduled', jobId?: string): Promise<number>
{
    const row = await createScheduledNotification({
        channel: 'email',
        recipient: 'learner@example.com',
        providerName: 'pending',
        scheduledAt: new Date(Date.now() + 60_000),
        jobId,
    });

    if (status !== 'scheduled')
    {
        await getDatabase('write').update(notifications).set({ status }).where(eq(notifications.id, row.id));
    }

    return row.id;
}

async function statusOf(id: number): Promise<string | undefined>
{
    return (await findOne(notifications, { id }))?.status;
}

const sendOk = () => vi.fn(async () => ({ success: true, messageId: 'm-1' }));

beforeAll(setupTestDb);
afterAll(teardownTestDb);

beforeEach(async () =>
{
    await clearTables();
    getBoss.mockReset();
    getBoss.mockReturnValue(undefined);
});

describe('scheduled job claims only a sendable row', () =>
{
    it.each<[NotificationStatus, 'sent' | 'skipped', string]>([
        ['scheduled', 'sent', 'sent'],
        ['failed', 'sent', 'sent'],      // pg-boss retry after a failed attempt
        ['pending', 'sent', 'sent'],     // pg-boss retry after a worker died mid-send
        ['cancelled', 'skipped', 'cancelled'],
        ['sent', 'skipped', 'sent'],
    ])('row %s → job %s, row ends %s', async (initial, outcome, final) =>
    {
        const id = await seed(initial);
        const send = sendOk();

        await expect(runScheduledSend(id, undefined, send)).resolves.toBe(outcome);

        expect(send).toHaveBeenCalledTimes(outcome === 'sent' ? 1 : 0);
        expect(await statusOf(id)).toBe(final);
    });

    it('a missing row is skipped, not thrown (no pg-boss retry of a send that must not happen)', async () =>
    {
        const send = sendOk();

        await expect(runScheduledSend(999_999, undefined, send)).resolves.toBe('skipped');
        expect(send).not.toHaveBeenCalled();
    });

    it('a failed send marks the row failed and throws so pg-boss retries', async () =>
    {
        const id = await seed();

        await expect(runScheduledSend(id, undefined, async () => ({ success: false, error: 'boom' }))).rejects.toThrow('boom');
        expect(await statusOf(id)).toBe('failed');
    });
});

describe('cancelNotification', () =>
{
    it('without a queue (getBoss() empty) still cancels, and the job then sends nothing', async () =>
    {
        const id = await seed('scheduled', 'job-1');
        const send = sendOk();

        await expect(cancelNotification(id)).resolves.toEqual({ success: true, jobCancelled: false });
        await expect(runScheduledSend(id, undefined, send)).resolves.toBe('skipped');

        expect(send).not.toHaveBeenCalled();
        expect(await statusOf(id)).toBe('cancelled');
    });

    it('removes the queued job from the channel queue when the queue is up', async () =>
    {
        const cancel = vi.fn(async () => undefined);
        getBoss.mockReturnValue({ cancel });
        const id = await seed('scheduled', 'job-2');

        await expect(cancelNotification(id)).resolves.toEqual({ success: true, jobCancelled: true });
        expect(cancel).toHaveBeenCalledWith('notification.send-scheduled-email', 'job-2');
    });

    it('a queue error does not fail the cancel; the row stays cancelled', async () =>
    {
        const cancel = vi.fn(async () =>
        {
            throw new Error('queue down');
        });
        getBoss.mockReturnValue({ cancel });
        const id = await seed('scheduled', 'job-3');

        await expect(cancelNotification(id)).resolves.toEqual({ success: true, jobCancelled: false });
        expect(await statusOf(id)).toBe('cancelled');
    });

    it.each<NotificationStatus>(['pending', 'sent', 'cancelled'])(
        'a %s row is refused and left unchanged; the queue is not touched',
        async (status) =>
        {
            const cancel = vi.fn(async () => undefined);
            getBoss.mockReturnValue({ cancel });
            const id = await seed(status, 'job-4');

            await expect(cancelNotification(id)).resolves.toEqual({
                success: false,
                error: `Cannot cancel notification with status: ${status}`,
            });
            expect(await statusOf(id)).toBe(status);
            expect(cancel).not.toHaveBeenCalled();
        },
    );

    it('a scheduled row that failed and awaits a pg-boss retry can be cancelled; the retry sends nothing', async () =>
    {
        const id = await seed('failed', 'job-5');
        const send = sendOk();

        await expect(cancelNotification(id)).resolves.toMatchObject({ success: true });
        await expect(runScheduledSend(id, undefined, send)).resolves.toBe('skipped');

        expect(send).not.toHaveBeenCalled();
    });

    it('a failed row that was never scheduled is refused', async () =>
    {
        const row = await notificationService.createNotificationRecord({
            channel: 'email',
            recipient: 'learner@example.com',
            providerName: 'aws-ses',
        });
        await getDatabase('write').update(notifications).set({ status: 'failed' }).where(eq(notifications.id, row.id));

        await expect(cancelNotification(row.id)).resolves.toMatchObject({ success: false });
        expect(await statusOf(row.id)).toBe('failed');
    });

    it('an unknown id is refused', async () =>
    {
        await expect(cancelNotification(999_999)).resolves.toEqual({ success: false, error: 'Notification not found' });
    });
});

describe('claim and cancel racing on the same row', () =>
{
    it('exactly one wins, every time', async () =>
    {
        const ids = await Promise.all(Array.from({ length: 30 }, () => seed()));

        const outcomes = await Promise.all(ids.map(async (id) =>
        {
            const [claimed, cancelled] = await Promise.all([
                claimNotificationForJob(id),
                markNotificationCancelled(id),
            ]);

            return { claimed, cancelled, status: await statusOf(id) };
        }));

        for (const { claimed, cancelled, status } of outcomes)
        {
            expect(claimed !== cancelled).toBe(true);
            expect(status).toBe(claimed ? 'pending' : 'cancelled');
        }
    });
});
