/**
 * GitHub #115: a scheduled send can name a guard that decides at send time
 * whether it still goes out. One test per row of the approved case table
 * (G1-G8); each row that must not send asserts the provider was not called.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getDatabase, findOne } from '@spfn/core/db';

const { getBoss } = vi.hoisted(() => ({ getBoss: vi.fn((): unknown => undefined) }));

vi.mock('@spfn/core/job', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getBoss,
}));

import { notifications } from '../../entities';
import type { SendResult } from '../../channels/types';
import { configureNotification } from '../../config';
import { registerEmailProvider } from '../../channels/email';
import { scheduleEmail } from '../schedule.service';
import { cancelNotification } from '../cancel.service';
import { registerSendGuard, type SendGuardContext } from '../send-guard.service';
import { sendScheduledEmailJob } from '../../jobs/send-scheduled-email';
import { setupTestDb, teardownTestDb, clearTables } from '../../__tests__/helpers/db';

const emailSend = vi.fn(async (_params: unknown): Promise<SendResult> => ({ success: true, messageId: 'ses-1' }));
registerEmailProvider({ name: 'aws-ses', send: (p) => emailSend(p) });

// No pg-boss here: capture the job payload and run the real handler with it.
const enqueue = vi.spyOn(sendScheduledEmailJob, 'send').mockImplementation(async () => 'job-1');

async function runJob(): Promise<void>
{
    const [payload] = enqueue.mock.calls.at(-1)!;
    await sendScheduledEmailJob.handler!(payload as never);
}

const HISTORY_RESET = { storeContent: true, storeRecipient: 'raw' as const, hashSecret: undefined };
const mail = { to: 'a@x.com', subject: 'Outage', text: 'Still down', data: { incident: 'inc-1' } };

async function schedule(guard?: string): Promise<number>
{
    const result = await scheduleEmail(mail, {
        scheduledAt: new Date(Date.now() + 60_000),
        referenceType: 'incident',
        referenceId: 'inc-1',
        guard,
    });

    expect(result.success).toBe(true);

    return result.notificationId!;
}

async function statusOf(id: number)
{
    return (await findOne(notifications, { id }))?.status;
}

beforeAll(setupTestDb);
afterAll(teardownTestDb);

beforeEach(async () =>
{
    await clearTables();
    configureNotification({ enableHistory: true, history: HISTORY_RESET });
    emailSend.mockClear();
    enqueue.mockClear();
});

afterEach(() =>
{
    configureNotification({ enableHistory: false, history: HISTORY_RESET });
});

describe('#115 send guard', () =>
{
    it('G1 guard true: sends, row sent; the guard sees the reference and data', async () =>
    {
        const guard = vi.fn((_ctx: SendGuardContext) => true);
        registerSendGuard('g1', guard);
        const id = await schedule('g1');

        await runJob();

        expect(emailSend).toHaveBeenCalledTimes(1);
        expect(await statusOf(id)).toBe('sent');
        expect(guard).toHaveBeenCalledWith({
            notificationId: id,
            channel: 'email',
            referenceType: 'incident',
            referenceId: 'inc-1',
            data: { incident: 'inc-1' },
        });
    });

    it('G2 guard false: row skipped, nothing sent, the job does not throw', async () =>
    {
        registerSendGuard('g2', async () => false);
        const id = await schedule('g2');

        await expect(runJob()).resolves.toBeUndefined();

        expect(emailSend).not.toHaveBeenCalled();
        expect(await statusOf(id)).toBe('skipped');
    });

    it('G3 guard throws: row failed, nothing sent, the job throws so pg-boss retries; the retry calls the guard again', async () =>
    {
        const guard = vi.fn()
            .mockRejectedValueOnce(new Error('status page down'))
            .mockResolvedValueOnce(true);
        registerSendGuard('g3', guard);
        const id = await schedule('g3');

        await expect(runJob()).rejects.toThrow('status page down');
        expect(emailSend).not.toHaveBeenCalled();
        expect(await statusOf(id)).toBe('failed');

        await runJob();

        expect(guard).toHaveBeenCalledTimes(2);
        expect(emailSend).toHaveBeenCalledTimes(1);
        expect(await statusOf(id)).toBe('sent');
    });

    it('G4 guard missing at send time: row failed, nothing sent, no retry', async () =>
    {
        registerSendGuard('g4', () => true);
        const id = await schedule('g4');
        const [payload] = enqueue.mock.calls.at(-1)!;

        await expect(sendScheduledEmailJob.handler!({ ...(payload as object), guard: 'g4-removed' } as never))
            .resolves.toBeUndefined();

        expect(emailSend).not.toHaveBeenCalled();
        const row = await findOne(notifications, { id });
        expect(row).toMatchObject({ status: 'failed', errorMessage: 'Send guard not registered: g4-removed' });
    });

    it('G5 unknown guard at schedule time: refused, no row, nothing queued', async () =>
    {
        const result = await scheduleEmail(mail, { scheduledAt: new Date(Date.now() + 60_000), guard: 'nope' });

        expect(result).toEqual({ success: false, error: 'Send guard not registered: nope' });
        expect(enqueue).not.toHaveBeenCalled();
        expect(await getDatabase('write').select().from(notifications)).toHaveLength(0);
    });

    it('G6 cancelled before the send: guard never called, nothing sent', async () =>
    {
        const guard = vi.fn(() => true);
        registerSendGuard('g6', guard);
        const id = await schedule('g6');
        await cancelNotification(id);

        await runJob();

        expect(guard).not.toHaveBeenCalled();
        expect(emailSend).not.toHaveBeenCalled();
        expect(await statusOf(id)).toBe('cancelled');
    });

    it('G7 no guard: sends as before', async () =>
    {
        const id = await schedule();

        await runJob();

        expect(emailSend).toHaveBeenCalledTimes(1);
        expect(await statusOf(id)).toBe('sent');
    });

    it('G8 skipped, then the app schedules again: the new row sends', async () =>
    {
        let stillDown = false;
        registerSendGuard('g8', () => stillDown);
        const first = await schedule('g8');
        await runJob();

        stillDown = true;
        const second = await schedule('g8');
        await runJob();

        expect(await statusOf(first)).toBe('skipped');
        expect(await statusOf(second)).toBe('sent');
        expect(emailSend).toHaveBeenCalledTimes(1);
    });

    it('a skipped row cannot be cancelled and is left unchanged', async () =>
    {
        registerSendGuard('g9', () => false);
        const id = await schedule('g9');
        await runJob();

        await expect(cancelNotification(id)).resolves.toMatchObject({ success: false });
        expect(await statusOf(id)).toBe('skipped');
    });
});
