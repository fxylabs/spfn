/**
 * GitHub #113 through the send path: the chosen locale reaches the provider
 * and the history row, and a template with nothing for the locale is refused
 * before the provider is called.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getDatabase } from '@spfn/core/db';
import { notifications } from '../../entities';
import type { SendResult } from '../../channels/types';
import { configureNotification } from '../../config';
import { sendEmail, registerEmailProvider } from '../../channels/email';
import { sendSMSBulk, registerSMSProvider } from '../../channels/sms';
import { registerTemplate } from '../../templates';
import { scheduleEmail } from '../schedule.service';
import { sendScheduledEmailJob } from '../../jobs/send-scheduled-email';
import { setupTestDb, teardownTestDb, clearTables } from '../../__tests__/helpers/db';

const emailSend = vi.fn(async (_p: any): Promise<SendResult> => ({ success: true, messageId: 'ses-1' }));
const smsSend = vi.fn(async (_p: any): Promise<SendResult> => ({ success: true, messageId: 'sns-1' }));
registerEmailProvider({ name: 'aws-ses', send: (p) => emailSend(p) });
registerSMSProvider({ name: 'aws-sns', send: (p) => smsSend(p) });
const enqueue = vi.spyOn(sendScheduledEmailJob, 'send').mockImplementation(async () => 'job-1');

registerTemplate({
    name: 'greet',
    channels: ['email', 'sms'],
    locales: {
        ko: { email: { subject: '안녕 {{name}}', text: '안녕' }, sms: { message: '안녕' } },
        en: { email: { subject: 'Hi {{name}}', text: 'Hi' }, sms: { message: 'Hi' } },
    },
    defaultLocale: 'en',
});
registerTemplate({ name: 'ko-only', channels: ['email'], locales: { ko: { email: { subject: '안녕', text: '안녕' } } } });

const HISTORY_RESET = { storeContent: true, storeRecipient: 'raw' as const, hashSecret: undefined };
const history = () => getDatabase('write').select().from(notifications);

beforeAll(setupTestDb);
afterAll(teardownTestDb);

beforeEach(async () =>
{
    await clearTables();
    configureNotification({ enableHistory: true, history: HISTORY_RESET });
    emailSend.mockClear();
    smsSend.mockClear();
    enqueue.mockClear();
});

afterEach(() =>
{
    configureNotification({ enableHistory: false, history: HISTORY_RESET });
});

describe('#113 send path', () =>
{
    it('sends the requested locale and records it', async () =>
    {
        await sendEmail({ to: 'a@x.com', template: 'greet', data: { name: '민수' }, locale: 'ko-KR' });

        expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({ subject: '안녕 민수' }));
        expect((await history())[0]).toMatchObject({ locale: 'ko' });
    });

    it('falls back to the default and records that', async () =>
    {
        await sendEmail({ to: 'a@x.com', template: 'greet', data: { name: 'Ann' }, locale: 'fr' });

        expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Hi Ann' }));
        expect((await history())[0]).toMatchObject({ locale: 'en' });
    });

    it('L6 at send time: refused, provider not called, no row', async () =>
    {
        const result = await sendEmail({ to: 'a@x.com', template: 'ko-only', locale: 'fr' });

        expect(result).toEqual({ success: false, error: 'Template ko-only has no email content for locale fr' });
        expect(emailSend).not.toHaveBeenCalled();
        expect(await history()).toHaveLength(0);
    });

    it('bulk items each use their own locale', async () =>
    {
        await sendSMSBulk([
            { to: '+821000000001', template: 'greet', locale: 'ko' },
            { to: '+821000000002', template: 'greet', locale: 'en' },
        ]);

        const messages = smsSend.mock.calls.map(([p]) => p.message).sort();
        expect(messages).toEqual(['Hi', '안녕']);
        expect((await history()).map(r => r.locale).sort()).toEqual(['en', 'ko']);
    });

    it('a scheduled send renders in its locale when the job runs', async () =>
    {
        const scheduled = await scheduleEmail(
            { to: 'a@x.com', template: 'greet', data: { name: '민수' }, locale: 'ko' },
            { scheduledAt: new Date(Date.now() + 60_000) },
        );
        expect((await history())[0]).toMatchObject({ id: scheduled.notificationId, locale: 'ko' });

        await sendScheduledEmailJob.handler!(enqueue.mock.calls[0][0] as never);

        expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({ subject: '안녕 민수' }));
    });

    it('a keyed retry takes over the failed row whole: fields the retry leaves out are cleared (review round 3)', async () =>
    {
        registerTemplate({ name: 'plain-or-ko', channels: ['email'], email: { subject: 'Plain', text: 'Plain' }, locales: { ko: { email: { subject: '안녕', text: '안녕' } } } });
        emailSend.mockImplementationOnce(async () => ({ success: false, error: 'throttled' }));
        await sendEmail({ to: 'a@x.com', template: 'plain-or-ko', locale: 'ko', idempotencyKey: 'rk' });
        expect((await history())[0]).toMatchObject({ status: 'failed', locale: 'ko' });

        await sendEmail({ to: 'a@x.com', template: 'plain-or-ko', idempotencyKey: 'rk' });

        const rows = await history();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'sent', locale: null, subject: 'Plain', errorMessage: null });
    });
});
