/**
 * GitHub #443: email attachments — what reaches an app's provider, what the
 * history row keeps of them, and the sends that are refused before any
 * provider call. The DB layer and the job queue are mocked out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { scheduledJobSend, bulkJobSendBatch, logged } = vi.hoisted(() => ({
    scheduledJobSend: vi.fn(async () => 'job-1'),
    bulkJobSendBatch: vi.fn(async (_inputs: unknown[]) => undefined),
    logged: vi.fn(),
}));

vi.mock('@spfn/core/logger', () => ({
    logger: { child: () => ({ debug: logged, info: logged, warn: logged, error: logged }) },
}));

vi.mock('../../../services/notification.service', () => ({
    createNotificationRecord: vi.fn(async () => ({ id: 1 })),
    createNotificationRecords: vi.fn(async (rows: unknown[]) => rows.map((_, i) => ({ id: i + 1 }))),
    createScheduledNotification: vi.fn(async () => ({ id: 1 })),
    updateNotificationJobId: vi.fn(async () => undefined),
    markNotificationSent: vi.fn(async () => undefined),
    markNotificationFailed: vi.fn(async () => undefined),
    markManySent: vi.fn(async () => undefined),
    markManyFailed: vi.fn(async () => undefined),
}));

vi.mock('../../../jobs/send-scheduled-email', () => ({ sendScheduledEmailJob: { send: scheduledJobSend } }));
vi.mock('../../../jobs/send-bulk-email-item', () => ({ sendBulkEmailItemJob: { sendBatch: bulkJobSendBatch } }));

import { sendEmail, sendEmailBulk, registerEmailProvider } from '../index';
import type { InternalSendEmailParams } from '../types';
import type { SendResult } from '../../types';
import { scheduleEmail } from '../../../services/schedule.service';
import { createNotificationRecord, createScheduledNotification, markNotificationFailed, markManyFailed } from '../../../services/notification.service';
import { configureNotification } from '../../../config';

const appSend = vi.fn(async (_params: InternalSendEmailParams): Promise<SendResult> => ({ success: true, messageId: 'app-1' }));

// SPFN_NOTIFICATION_EMAIL_PROVIDER is unset, so the send goes to 'aws-ses':
// registering an app provider under that name is how an app replaces it.
const appProvider = { name: 'aws-ses', supportsAttachments: true, maxMessageBytes: 64, send: appSend };

const created = vi.mocked(createNotificationRecord);
const HISTORY_RESET = { storeContent: true, storeRecipient: 'raw' as const, hashSecret: undefined };
const PDF = { filename: '홍길동 진단서.pdf', contentType: 'application/pdf', content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]) };
const mail = { to: 'a@x.com', subject: 'Hi', text: 'Hello' };

beforeEach(() =>
{
    vi.clearAllMocks();
    registerEmailProvider(appProvider);
    configureNotification({ enableHistory: true, history: HISTORY_RESET });
});

afterEach(() =>
{
    configureNotification({ enableHistory: false, history: HISTORY_RESET });
});

describe('an app-supplied provider', () =>
{
    it('receives the attachments as given: same bytes, name and type', async () =>
    {
        const result = await sendEmail({ ...mail, attachments: [PDF] });

        expect(result.success).toBe(true);
        expect(appSend.mock.calls[0][0].attachments).toEqual([PDF]);
    });

    it('that does not declare supportsAttachments is refused, not called', async () =>
    {
        registerEmailProvider({ name: 'aws-ses', send: appSend });

        const result = await sendEmail({ ...mail, attachments: [PDF] });

        expect(result).toMatchObject({ success: false, errorCode: 'attachments_unsupported' });
        expect(appSend).not.toHaveBeenCalled();
    });

    it('in-process bulk: each item reaches the provider with its attachments', async () =>
    {
        await sendEmailBulk([{ ...mail, attachments: [PDF] }, mail]);

        const sent = appSend.mock.calls.map(([params]) => params.attachments);

        expect(sent).toContainEqual([PDF]);
    });
});

describe('refused before any provider call', () =>
{
    it('a message whose encoded size is over the provider limit: message_too_large', async () =>
    {
        // 48 bytes are 64 in base64; the subject and body take it over 64
        const result = await sendEmail({ ...mail, attachments: [{ ...PDF, content: new Uint8Array(48).fill(1) }] });

        expect(result).toMatchObject({ success: false, errorCode: 'message_too_large' });
        expect(appSend).not.toHaveBeenCalled();
        expect(created).not.toHaveBeenCalled();
    });

    it.each([
        ['a CR/LF in filename', { filename: 'a.pdf\r\nBcc: victim@example.com' }],
        ['a CR/LF in contentType', { contentType: 'application/pdf\r\nBcc: victim@example.com' }],
        ['NEL (U+0085) in filename', { filename: 'a.pdf\u0085Bcc: victim@example.com' }],
        ['LINE SEPARATOR (U+2028) in filename', { filename: 'a.pdf\u2028Bcc: victim@example.com' }],
        ['PARAGRAPH SEPARATOR (U+2029) in filename', { filename: 'a.pdf\u2029Bcc: victim@example.com' }],
        ['LINE SEPARATOR (U+2028) in a contentType parameter', { contentType: 'application/pdf; name="a\u2028Bcc: victim@example.com"' }],
        ['an empty filename', { filename: ' ' }],
        ['zero-length content', { content: new Uint8Array(0) }],
    ])('%s: attachment_invalid', async (_case, override) =>
    {
        const result = await sendEmail({ ...mail, attachments: [{ ...PDF, ...override }] });

        expect(result).toMatchObject({ success: false, errorCode: 'attachment_invalid' });
        expect(appSend).not.toHaveBeenCalled();
    });
});

describe('a malformed value from a plain-JS caller', () =>
{
    it.each([
        ['attachments not an array', 'PDF', 'Attachments: not an array'],
        ['an entry that is not an object', [null], 'Attachment 1: not an object'],
        ['no filename', [{ ...PDF, filename: undefined }], 'Attachment 1: filename is not a string'],
        ['a contentType that is not a string', [PDF, { ...PDF, contentType: 42 }], 'Attachment 2: contentType is not a string'],
        ['base64 text as content', [{ ...PDF, content: 'JVBERg==' }], 'Attachment 1: content is not a Uint8Array'],
    ])('%s: attachment_invalid, naming what is wrong', async (_case, attachments, error) =>
    {
        const result = await sendEmail({ ...mail, attachments: attachments as never });

        expect(result).toEqual({ success: false, error, errorCode: 'attachment_invalid' });
        expect(appSend).not.toHaveBeenCalled();
    });

    it.each([
        ['sendEmail', () => sendEmail({ ...mail, attachments: null as never })],
        ['in-process bulk', () => sendEmailBulk([{ ...mail, attachments: null as never }]).then(bulk => bulk.results[0])],
    ])('%s with attachments: null sends without any, and a provider error is scrubbed, not thrown on', async (_case, send) =>
    {
        appSend.mockResolvedValueOnce({ success: false, error: 'Throttled' });

        expect(await send()).toMatchObject({ success: false, error: 'Throttled' });
        expect(appSend.mock.calls[0][0].attachments).toBeUndefined();
    });

    it('scheduleEmail with attachments that are not an array is refused, not scheduled without them', async () =>
    {
        const result = await scheduleEmail({ ...mail, attachments: {} as never }, { scheduledAt: new Date(Date.now() + 60_000) });

        expect(result).toMatchObject({ success: false, errorCode: 'attachment_invalid' });
        expect(createScheduledNotification).not.toHaveBeenCalled();
    });
});

describe('history', () =>
{
    it('normal send: records type and size of each attachment, never the name or bytes', async () =>
    {
        await sendEmail({ ...mail, attachments: [PDF] });

        const row = created.mock.calls[0][0];

        expect(row.attachments).toEqual([{ contentType: 'application/pdf', size: 6 }]);
        expect(JSON.stringify(row)).not.toContain('진단서');
    });

    it('a filename in a contentType parameter does not reach the row', async () =>
    {
        await sendEmail({ ...mail, attachments: [{ ...PDF, contentType: 'Application/PDF; name="홍길동 진단서.pdf"' }] });

        expect(created.mock.calls[0][0].attachments).toEqual([{ contentType: 'application/pdf', size: 6 }]);
    });

    it('sensitive send: nothing of the attachments in the row', async () =>
    {
        await sendEmail({ ...mail, attachments: [PDF], sensitive: true });

        expect(created.mock.calls[0][0].attachments).toBeUndefined();
    });
});

describe('a provider rejection quoting one of the send\'s filenames', () =>
{
    const quoting: SendResult = { success: false, error: `Blocked file type: ${PDF.filename}` };

    it('sendEmail: neither the log line nor history.error_message holds it', async () =>
    {
        appSend.mockResolvedValueOnce(quoting);

        await sendEmail({ ...mail, attachments: [PDF] });

        expect(vi.mocked(markNotificationFailed).mock.calls[0][1]).toBe('Blocked file type: [attachment 1]');
        expect(JSON.stringify(logged.mock.calls)).not.toContain('진단서');
    });

    it('a name that contains another send filename is removed whole', async () =>
    {
        appSend.mockResolvedValueOnce({ success: false, error: 'Blocked file type: 홍길동 scan.pdf' });

        await sendEmail({ ...mail, attachments: [{ ...PDF, filename: '홍길동' }, { ...PDF, filename: '홍길동 scan.pdf' }] });

        expect(vi.mocked(markNotificationFailed).mock.calls[0][1]).toBe('Blocked file type: [attachment 2]');
    });

    it('a filename that is part of the recipient address: the address is still masked in history and the log', async () =>
    {
        appSend.mockResolvedValueOnce({ success: false, error: 'Message rejected for jane.doe@example.com: blocked file example.com' });

        await sendEmail({ ...mail, to: 'jane.doe@example.com', attachments: [{ ...PDF, filename: 'example.com' }] });

        expect(vi.mocked(markNotificationFailed).mock.calls[0][1]).toBe('Message rejected for ja***@example.com: blocked file [attachment 1]');
        expect(JSON.stringify(logged.mock.calls)).not.toContain('jane.doe');
    });

    it('a percent-encoded filename: neither the log line nor history.error_message holds it', async () =>
    {
        appSend.mockResolvedValueOnce({ success: false, error: 'Blocked file type: report%20name.pdf' });

        await sendEmail({ ...mail, attachments: [{ ...PDF, filename: 'report name.pdf' }] });

        expect(vi.mocked(markNotificationFailed).mock.calls[0][1]).toBe('Blocked file type: [attachment 1]');
        expect(JSON.stringify(logged.mock.calls)).not.toContain('report%20name.pdf');
    });

    it('in-process bulk: neither the log line nor history.error_message holds it', async () =>
    {
        appSend.mockResolvedValueOnce(quoting);

        await sendEmailBulk([{ ...mail, attachments: [PDF] }]);

        expect(vi.mocked(markManyFailed).mock.calls[0][0]).toEqual([{ id: 1, errorMessage: 'Blocked file type: [attachment 1]' }]);
        expect(JSON.stringify(logged.mock.calls)).not.toContain('진단서');
    });
});

describe('sends whose payload is stored as a JSON job', () =>
{
    it('scheduleEmail with attachments is refused: no row, nothing queued', async () =>
    {
        const result = await scheduleEmail({ ...mail, attachments: [PDF] }, { scheduledAt: new Date(Date.now() + 60_000) });

        expect(result).toMatchObject({ success: false, errorCode: 'attachments_not_deferrable' });
        expect(createScheduledNotification).not.toHaveBeenCalled();
        expect(scheduledJobSend).not.toHaveBeenCalled();
    });

    it('distributed bulk: the item with attachments is refused, the rest are queued', async () =>
    {
        const result = await sendEmailBulk([{ ...mail, attachments: [PDF] }, mail], { distributed: true });

        expect(result.results[0]).toMatchObject({ success: false, errorCode: 'attachments_not_deferrable' });
        expect(result.results[1]).toMatchObject({ success: true });
        expect(vi.mocked(bulkJobSendBatch).mock.calls[0][0]).toHaveLength(1);
    });
});
