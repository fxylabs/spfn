/**
 * GitHub #114: a send with an idempotency key reaches the provider at most
 * once per (channel, key, recipient). One test per row of the approved case
 * table (I1-I11); each negative row asserts the provider was not called.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '@spfn/core/db';

const { getBoss } = vi.hoisted(() => ({ getBoss: vi.fn((): unknown => undefined) }));

vi.mock('@spfn/core/job', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getBoss,
}));

import { notifications, type NotificationStatus } from '../../entities';
import type { SendResult } from '../../channels/types';
import { configureNotification } from '../../config';
import { sendEmail, sendEmailBulk, registerEmailProvider } from '../../channels/email';
import { sendSMS, sendSMSBulk, registerSMSProvider } from '../../channels/sms';
import { sendSlack, registerSlackProvider } from '../../channels/slack';
import { scheduleEmail } from '../schedule.service';
import { deliverEmail } from '../../channels/email';
import { runScheduledSend } from '../../jobs/run-scheduled-send';
import { sendScheduledEmailJob } from '../../jobs/send-scheduled-email';
import { setupTestDb, teardownTestDb, clearTables } from '../../__tests__/helpers/db';

const emailSend = vi.fn(async (_params: unknown): Promise<SendResult> => ({ success: true, messageId: 'ses-1' }));
const smsSend = vi.fn(async (_params: unknown): Promise<SendResult> => ({ success: true, messageId: 'sns-1' }));
const slackSend = vi.fn(async (_params: unknown): Promise<SendResult> => ({ success: true }));

registerEmailProvider({ name: 'aws-ses', send: (p) => emailSend(p) });
registerSMSProvider({ name: 'aws-sns', send: (p) => smsSend(p) });
registerSlackProvider({ name: 'webhook', send: (p) => slackSend(p) });

const HISTORY_RESET = { storeContent: true, storeRecipient: 'raw' as const, hashSecret: undefined };
const mail = (idempotencyKey?: string) => ({ to: 'a@x.com', subject: 'Hi', text: 'Hello', idempotencyKey });

async function rows(channel: 'email' | 'sms' | 'slack', key: string)
{
    return getDatabase('write').select().from(notifications)
        .where(and(eq(notifications.channel, channel), eq(notifications.idempotencyKey, key)));
}

async function setStatus(key: string, status: NotificationStatus)
{
    await getDatabase('write').update(notifications).set({ status }).where(eq(notifications.idempotencyKey, key));
}

beforeAll(setupTestDb);
afterAll(teardownTestDb);

// No pg-boss in these tests: the enqueue returns a job id and is counted.
const enqueue = vi.spyOn(sendScheduledEmailJob, 'send').mockImplementation(async () => 'job-1');

beforeEach(async () =>
{
    await clearTables();
    enqueue.mockClear();
    configureNotification({ enableHistory: true, history: HISTORY_RESET });
    for (const send of [emailSend, smsSend, slackSend])
    {
        send.mockClear();
    }
    emailSend.mockImplementation(async () => ({ success: true, messageId: 'ses-1' }));
});

afterEach(() =>
{
    configureNotification({ enableHistory: false, history: HISTORY_RESET });
});

describe('#114 idempotency key', () =>
{
    it('I1 first keyed send: sends, row sent with the key', async () =>
    {
        await expect(sendEmail(mail('k1'))).resolves.toEqual({ success: true, messageId: 'ses-1' });

        expect(emailSend).toHaveBeenCalledTimes(1);
        const [row] = await rows('email', 'k1');
        expect(row).toMatchObject({ status: 'sent', providerMessageId: 'ses-1' });
    });

    it('I2 repeat after sent: first result, deduplicated, provider not called', async () =>
    {
        await sendEmail(mail('k2'));
        emailSend.mockClear();

        await expect(sendEmail(mail('k2'))).resolves.toEqual({ success: true, messageId: 'ses-1', deduplicated: true });
        expect(emailSend).not.toHaveBeenCalled();
        expect(await rows('email', 'k2')).toHaveLength(1);
    });

    it('I3 repeat after failed: reclaims the same row and sends', async () =>
    {
        emailSend.mockImplementationOnce(async () => ({ success: false, error: 'throttled' }));
        await sendEmail(mail('k3'));

        await expect(sendEmail(mail('k3'))).resolves.toEqual({ success: true, messageId: 'ses-1' });

        expect(emailSend).toHaveBeenCalledTimes(2);
        const keyed = await rows('email', 'k3');
        expect(keyed).toHaveLength(1);
        expect(keyed[0]).toMatchObject({ status: 'sent', errorMessage: null });
    });

    it('I4 repeat while pending: refused as in progress, provider not called', async () =>
    {
        await sendEmail(mail('k4'));
        await setStatus('k4', 'pending');
        emailSend.mockClear();

        await expect(sendEmail(mail('k4'))).resolves.toEqual({ success: false, deduplicated: true, error: 'send in progress' });
        expect(emailSend).not.toHaveBeenCalled();
    });

    it('I5 same key on another channel is independent', async () =>
    {
        await sendEmail(mail('k5'));
        await expect(sendSlack({ webhookUrl: 'https://hooks.example/x', text: 'hi', idempotencyKey: 'k5' }))
            .resolves.toMatchObject({ success: true });

        expect(slackSend).toHaveBeenCalledTimes(1);
    });

    it('I6 sms with two recipients: the sent one is deduplicated, the failed one retried', async () =>
    {
        smsSend.mockImplementation(async (p: any) => (p.to === '+821000000002'
            ? { success: false, error: 'carrier' }
            : { success: true, messageId: 'sns-1' }));
        await sendSMS({ to: ['+821000000001', '+821000000002'], message: 'hi', idempotencyKey: 'k6' });
        smsSend.mockReset();
        smsSend.mockImplementation(async () => ({ success: true, messageId: 'sns-2' }));

        const result = await sendSMS({ to: ['+821000000001', '+821000000002'], message: 'hi', idempotencyKey: 'k6' });

        expect(smsSend).toHaveBeenCalledTimes(1);
        expect(smsSend).toHaveBeenCalledWith(expect.objectContaining({ to: '+821000000002' }));
        expect(result).toMatchObject({ success: true, deduplicated: true });
        expect((await rows('sms', 'k6')).map(r => r.status)).toEqual(['sent', 'sent']);
    });

    it('I7 concurrent sends with one key: exactly one provider call', async () =>
    {
        const results = await Promise.all(Array.from({ length: 10 }, () => sendEmail(mail('k7'))));

        expect(emailSend).toHaveBeenCalledTimes(1);
        expect(results.filter(r => !r.deduplicated)).toHaveLength(1);
        expect(await rows('email', 'k7')).toHaveLength(1);
    });

    it('I8 history disabled: keyed send refused, provider not called', async () =>
    {
        configureNotification({ enableHistory: false });

        await expect(sendEmail(mail('k8'))).resolves.toEqual({
            success: false,
            error: 'idempotencyKey requires notification history',
        });
        expect(emailSend).not.toHaveBeenCalled();
    });

    it('I9 claim fails (DB error): nothing sent', async () =>
    {
        const spy = vi.spyOn(getDatabase('write'), 'insert').mockImplementationOnce(() =>
        {
            throw new Error('connection lost');
        });

        const result = await sendEmail(mail('k9'));
        spy.mockRestore();

        expect(result).toMatchObject({ success: false });
        expect(emailSend).not.toHaveBeenCalled();
    });

    it('I10 no key: unchanged, every call sends', async () =>
    {
        await sendEmail(mail());
        await sendEmail(mail());

        expect(emailSend).toHaveBeenCalledTimes(2);
    });

    it('I11 schedule with a spent key: returns the first schedule, queues nothing new', async () =>
    {
        const scheduledAt = new Date(Date.now() + 60_000);
        const first = await scheduleEmail(mail('k11'), { scheduledAt });

        const second = await scheduleEmail(mail('k11'), { scheduledAt });

        expect(first).toMatchObject({ success: true, jobId: 'job-1' });
        expect(second).toEqual({ success: true, deduplicated: true, notificationId: first.notificationId, jobId: 'job-1' });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(await rows('email', 'k11')).toHaveLength(1);
    });

    it.each([
        ['empty', ''],
        ['over 255 characters', 'x'.repeat(256)],
    ])('rejects a key that is %s before any send', async (_label, key) =>
    {
        await expect(sendEmail(mail(key))).resolves.toMatchObject({ success: false });
        expect(emailSend).not.toHaveBeenCalled();
    });

    it('accepts a 255-character key', async () =>
    {
        await expect(sendEmail(mail('x'.repeat(255)))).resolves.toMatchObject({ success: true });
    });
});

describe('#114 bulk', () =>
{
    it('email bulk: a spent key is deduplicated, the rest send, counts add up', async () =>
    {
        await sendEmail(mail('b1'));
        emailSend.mockClear();

        const result = await sendEmailBulk([mail('b1'), mail('b2'), mail()]);

        expect(emailSend).toHaveBeenCalledTimes(2);
        expect(result.results[0]).toEqual({ success: true, messageId: 'ses-1', deduplicated: true });
        expect(result).toMatchObject({ successCount: 3, failureCount: 0 });
    });

    it('sms bulk: a spent key per recipient is deduplicated', async () =>
    {
        await sendSMS({ to: '+821000000001', message: 'hi', idempotencyKey: 'b3' });
        smsSend.mockClear();

        const result = await sendSMSBulk([{ to: ['+821000000001', '+821000000002'], message: 'hi', idempotencyKey: 'b3' }]);

        expect(smsSend).toHaveBeenCalledTimes(1);
        expect(result.results[0]).toMatchObject({ success: true, deduplicated: true });
    });

    it('an invalid key fails only its item', async () =>
    {
        const result = await sendEmailBulk([mail(''), mail('b4')]);

        expect(result.results[0]).toMatchObject({ success: false });
        expect(result).toMatchObject({ successCount: 1, failureCount: 1 });
    });
});

describe('scheduled send keeps one history row', () =>
{
    it('the job sends against its own row instead of opening a second one', async () =>
    {
        const scheduled = await scheduleEmail(mail(), { scheduledAt: new Date(Date.now() + 60_000) });

        await runScheduledSend(scheduled.notificationId!, () => deliverEmail(mail(), scheduled.notificationId));

        const all = await getDatabase('write').select().from(notifications);
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ id: scheduled.notificationId, status: 'sent' });
    });
});
