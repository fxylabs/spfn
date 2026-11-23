/**
 * GitHub #443: SES attachments, at the request level — the SendEmailCommand
 * input the provider builds is asserted; no real SES is called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send, logged } = vi.hoisted(() => ({ send: vi.fn(), logged: vi.fn() }));

vi.mock('@aws-sdk/client-sesv2', () => ({
    SESv2Client: class
    {
        send = send;
    },
    SendEmailCommand: class
    {
        input: unknown;

        constructor(input: unknown)
        {
            this.input = input;
        }
    },
}));

vi.mock('@spfn/core/logger', () => ({
    logger: { child: () => ({ debug: logged, info: logged, warn: logged, error: logged }) },
}));

vi.mock('../../../../services/notification.service', () => ({
    createNotificationRecord: vi.fn(async () => ({ id: 1 })),
    markNotificationSent: vi.fn(async () => undefined),
    markNotificationFailed: vi.fn(async () => undefined),
}));

import { awsSesProvider, SES_MAX_MESSAGE_BYTES } from '../aws-ses';
import { sendEmail } from '../../index';
import { markNotificationFailed } from '../../../../services/notification.service';
import { configureNotification } from '../../../../config';

const PDF = { filename: 'report.pdf', contentType: 'application/pdf', content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]) };
const CSV = { filename: 'rows.csv', contentType: 'text/csv; charset=utf-8', content: new TextEncoder().encode('a,b\n1,2\n') };
const PARAMS = { to: ['a@x.com'], from: 'noreply@app.example.com', subject: 'Hi', text: 'Hello' };

beforeEach(() =>
{
    vi.clearAllMocks();
    send.mockReset();
    send.mockResolvedValue({ MessageId: 'ses-1' });
});

describe('awsSesProvider attachments (request level)', () =>
{
    it('puts each attachment on Simple content with its exact bytes, name and type', async () =>
    {
        await awsSesProvider.send({ ...PARAMS, attachments: [PDF, CSV] });

        const simple = send.mock.calls[0][0].input.Content.Simple;

        expect(simple.Attachments).toEqual([
            { RawContent: PDF.content, FileName: 'report.pdf', ContentType: 'application/pdf', ContentDisposition: 'ATTACHMENT' },
            { RawContent: CSV.content, FileName: 'rows.csv', ContentType: 'text/csv; charset=utf-8', ContentDisposition: 'ATTACHMENT' },
        ]);
        expect(send.mock.calls[0][0].input.Content.Raw).toBeUndefined();
    });

    it('maps SES\'s own size rejection to message_too_large', async () =>
    {
        send.mockRejectedValue(Object.assign(new Error('Message length is more than 41943040 bytes long: \'41943100\'.'), {
            name: 'MessageRejected',
            $metadata: { httpStatusCode: 400 },
        }));

        const result = await awsSesProvider.send({ ...PARAMS, attachments: [PDF] });

        expect(result).toMatchObject({ success: false, errorCode: 'message_too_large' });
    });

    it('leaves any other rejection without a code', async () =>
    {
        send.mockRejectedValue(Object.assign(new Error('Email address is not verified.'), {
            name: 'MessageRejected',
            $metadata: { httpStatusCode: 400 },
        }));

        const result = await awsSesProvider.send(PARAMS);

        expect(result.errorCode).toBeUndefined();
    });
});

describe('sendEmail through SES over its 40 MB limit', () =>
{
    it('is refused as message_too_large without calling SES', async () =>
    {
        // base64 makes 3 bytes 4: this is just over the limit before any header
        const content = new Uint8Array(Math.floor(SES_MAX_MESSAGE_BYTES / 4) * 3 + 3);

        const result = await sendEmail({ ...PARAMS, attachments: [{ ...PDF, content }] });

        expect(result).toMatchObject({ success: false, errorCode: 'message_too_large' });
        expect(send).not.toHaveBeenCalled();
    });
});

describe('a SES rejection quoting one of the send\'s filenames', () =>
{
    it('reaches neither a log line nor history.error_message', async () =>
    {
        configureNotification({ enableHistory: true });
        send.mockRejectedValue(Object.assign(new Error('Attachment rows.csv has an unsupported file type.'), {
            name: 'MessageRejected',
            $metadata: { httpStatusCode: 400 },
        }));

        const result = await sendEmail({ ...PARAMS, attachments: [PDF, CSV] });
        configureNotification({ enableHistory: false });

        expect(result.error).toBe('Attachment [attachment 2] has an unsupported file type.');
        expect(vi.mocked(markNotificationFailed).mock.calls[0][1]).not.toContain('rows.csv');
        expect(JSON.stringify(logged.mock.calls)).not.toContain('rows.csv');
    });
});
