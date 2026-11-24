/**
 * A provider that throws is answered at the channel's provider boundary as
 * one that returns its refusal is (#489): the scrubbed text, the masked "send
 * failed" line, the history row closed as failed, and a failed result for
 * the caller — never the raw error. P1 enters at each single send, P2 at each
 * bulk send; both look at every logger call, every history write and what the
 * send answers, with `util.inspect` deep enough to see inside an Error.
 */

import { inspect } from 'node:util';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../services/notification.service', () => ({
    createNotificationRecord: vi.fn(async () => ({ id: 1 })),
    createNotificationRecords: vi.fn(async () => [{ id: 1 }]),
    markNotificationSent: vi.fn(async () => undefined),
    markNotificationFailed: vi.fn(async () => undefined),
    markManySent: vi.fn(async () => undefined),
    markManyFailed: vi.fn(async () => undefined),
}));

import { Logger } from '@spfn/core/logger';
import { sendEmail, sendEmailBulk, registerEmailProvider } from '../email';
import { sendSMS, sendSMSBulk, registerSMSProvider } from '../sms';
import { markManyFailed, markNotificationFailed } from '../../services/notification.service';
import { configureNotification, getNotificationConfig } from '../../config';

const ADDRESS = 'taken@example.com';
const NUMBER = '+15551234567';
const PROVIDER = 'throws-489';

registerEmailProvider({
    name: PROVIDER,
    send: async () =>
    {
        throw new Error(`550 5.1.1 <${ADDRESS}>: mailbox unavailable`);
    },
});
registerSMSProvider({
    name: PROVIDER,
    send: async () =>
    {
        throw new Error(`Invalid 'To' Phone Number: ${NUMBER}`);
    },
});

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
const failedWrites = [markNotificationFailed, markManyFailed].map(fn => vi.mocked(fn));

const SENDS = {
    email: {
        recipient: ADDRESS,
        line: 'Email send failed',
        scrubbed: '550 5.1.1 <ta***@example.com>: mailbox unavailable',
        single: () => sendEmail({ to: ADDRESS, subject: 'Hi', text: 'Hello' }),
        bulk: () => sendEmailBulk([{ to: ADDRESS, subject: 'Hi', text: 'Hello' }]),
    },
    sms: {
        recipient: NUMBER,
        line: 'SMS send failed',
        scrubbed: 'Invalid \'To\' Phone Number: +1555*****67',
        single: () => sendSMS({ to: NUMBER, message: 'Hello' }),
        bulk: () => sendSMSBulk([{ to: NUMBER, message: 'Hello' }]),
    },
};

describe('a provider that throws is answered at the channel boundary (#489)', () =>
{
    const enableHistory = getNotificationConfig().enableHistory;
    let logged: MockInstance[];

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_NOTIFICATION_EMAIL_PROVIDER', PROVIDER);
        vi.stubEnv('SPFN_NOTIFICATION_SMS_PROVIDER', PROVIDER);
        configureNotification({ enableHistory: true });
        failedWrites.forEach(fn => fn.mockClear());
        logged = LEVELS.map(level => vi.spyOn(Logger.prototype, level));
    });

    afterEach(() =>
    {
        logged.forEach(spy => spy.mockRestore());
        configureNotification({ enableHistory });
        vi.unstubAllEnvs();
    });

    /** What the send answered or threw, every logger call, and every failed-row write. */
    async function seen(send: () => Promise<unknown>): Promise<{ answer: unknown; lines: unknown[][]; text: string }>
    {
        const answer = await send().catch((thrown: unknown) => ({ thrown }));
        // The history update is fire-and-forget: let it run.
        await new Promise(resolve => setTimeout(resolve, 0));
        const lines = logged.flatMap(spy => spy.mock.calls);

        return { answer, lines, text: inspect([answer, lines, failedWrites.map(fn => fn.mock.calls)], { depth: 10 }) };
    }

    it.each(Object.keys(SENDS))('P1: %s — a single send', async (channel) =>
    {
        const send = SENDS[channel as keyof typeof SENDS];
        const { answer, lines, text } = await seen(send.single);

        expect(answer).toMatchObject({ success: false, error: send.scrubbed });
        expect(lines.filter(([message]) => message === send.line)).toHaveLength(1);
        expect(vi.mocked(markNotificationFailed)).toHaveBeenCalledWith(1, send.scrubbed);
        expect(text).not.toContain(send.recipient);
    });

    it.each(Object.keys(SENDS))('P2: %s — a bulk send', async (channel) =>
    {
        const send = SENDS[channel as keyof typeof SENDS];
        const { answer, lines, text } = await seen(send.bulk);

        expect(answer).toMatchObject({ results: [{ success: false, error: send.scrubbed }], failureCount: 1 });
        expect(lines.filter(([message]) => message === send.line)).toHaveLength(1);
        expect(vi.mocked(markManyFailed)).toHaveBeenCalledWith([{ id: 1, errorMessage: send.scrubbed }]);
        expect(text).not.toContain(send.recipient);
    });
});
