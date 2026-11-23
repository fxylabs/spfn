/**
 * Privacy helper tests — masking and history recipient hashing, no DB.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { configureNotification } from '../config';
import {
    maskEmail,
    maskPhone,
    maskRecipient,
    maskRecipients,
    scrubProviderError,
    scrubSendResult,
    historyRecipient,
    historyRecipientFilter,
} from '../privacy';

const SECRET = 'test-history-secret';

function hmac(value: string): string
{
    return createHmac('sha256', SECRET).update(value.trim().toLowerCase()).digest('hex');
}

afterEach(() =>
{
    // history merges deep, so the reset lists every key explicitly.
    configureNotification({ history: { storeContent: true, storeRecipient: 'raw', hashSecret: undefined } });
});

describe('maskEmail', () =>
{
    it('keeps two leading characters and the domain', () =>
    {
        expect(maskEmail('jordan@example.com')).toBe('jo***@example.com');
    });

    it('keeps a single character for short local parts', () =>
    {
        expect(maskEmail('ab@example.com')).toBe('a***@example.com');
        expect(maskEmail('a@example.com')).toBe('a***@example.com');
    });

    it('falls back to opaque masking for non-address values', () =>
    {
        expect(maskEmail('not-an-email')).toBe('n***');
    });
});

describe('maskPhone', () =>
{
    it('keeps the prefix and last two digits', () =>
    {
        const masked = maskPhone('+821012345678');

        expect(masked.startsWith('+8210')).toBe(true);
        expect(masked.endsWith('78')).toBe(true);
        expect(masked).not.toContain('123456');
    });

    it('masks short values opaquely', () =>
    {
        expect(maskPhone('12345')).toBe('1***');
    });

    it('never throws or passes a value through unmasked at boundary lengths', () =>
    {
        // 6 chars used to hit '*'.repeat(-1); 7 chars used to return the input unchanged.
        expect(maskPhone('+82100')).toBe('+***');
        expect(maskPhone('1234567')).toBe('1***');
        expect(maskPhone('12345678')).toBe('12345*78');
    });
});

describe('maskRecipient / maskRecipients', () =>
{
    it('picks the mask by value shape', () =>
    {
        expect(maskRecipient('jordan@example.com')).toContain('@example.com');
        expect(maskRecipient('+821012345678')).not.toContain('@');
    });

    it('masks every entry in a list', () =>
    {
        const masked = maskRecipients(['jordan@example.com', 'casey@example.org']);

        expect(masked).toEqual(['jo***@example.com', 'ca***@example.org']);
    });
});

describe('historyRecipient', () =>
{
    it('joins raw values by default', () =>
    {
        expect(historyRecipient(['a@x.com', 'b@x.com'])).toBe('a@x.com,b@x.com');
    });

    it('stores per-recipient HMACs in hashed mode', () =>
    {
        configureNotification({ history: { storeRecipient: 'hashed', hashSecret: SECRET } });

        expect(historyRecipient(['a@x.com', 'b@x.com'])).toBe(`${hmac('a@x.com')},${hmac('b@x.com')}`);
    });

    it('hashes case-insensitively so lookups match how addresses compare', () =>
    {
        configureNotification({ history: { storeRecipient: 'hashed', hashSecret: SECRET } });

        expect(historyRecipient(['A@X.com'])).toBe(historyRecipient(['a@x.com']));
    });

    it('never stores a raw value when the secret is missing', () =>
    {
        // configureNotification refuses this combination up front…
        expect(() => configureNotification({ history: { storeRecipient: 'hashed', hashSecret: undefined } })).toThrow(/hash secret/);
        // …and the failed call must not have changed the active config.
        expect(historyRecipient(['a@x.com'])).toBe('a@x.com');
    });

    it('keeps hashed mode across a later partial configure call', () =>
    {
        configureNotification({ history: { storeRecipient: 'hashed', hashSecret: SECRET } });
        configureNotification({ history: { storeContent: false } });

        expect(historyRecipient(['a@x.com'])).toBe(hmac('a@x.com'));
    });
});

describe('historyRecipientFilter', () =>
{
    it('passes values through in raw mode', () =>
    {
        expect(historyRecipientFilter('a@x.com')).toBe('a@x.com');
    });

    it('transforms filters exactly like stored values', () =>
    {
        configureNotification({ history: { storeRecipient: 'hashed', hashSecret: SECRET } });

        expect(historyRecipientFilter('a@x.com,b@x.com')).toBe(historyRecipient(['a@x.com', 'b@x.com']));
    });
});

describe('scrubProviderError', () =>
{
    it('masks the address SES quotes in a sandbox rejection', () =>
    {
        const message = 'Email address is not verified. The following identities '
            + 'failed the check in region US-EAST-1: learner@example.com';

        expect(scrubProviderError(message)).toBe(
            'Email address is not verified. The following identities '
            + 'failed the check in region US-EAST-1: le***@example.com',
        );
    });

    it('masks every address in a message that names two', () =>
    {
        expect(scrubProviderError('rejected: learner@example.com, tutor@school.ac.kr'))
            .toBe('rejected: le***@example.com, tu***@school.ac.kr');
    });

    it('leaves a sentence-ending period outside the address', () =>
    {
        expect(scrubProviderError('Not verified: learner@example.com.'))
            .toBe('Not verified: le***@example.com.');
    });

    it('masks an E.164 number in an SNS rejection', () =>
    {
        expect(scrubProviderError('Invalid parameter: PhoneNumber Reason: +821012345678 is not valid'))
            .toBe('Invalid parameter: PhoneNumber Reason: +8210******78 is not valid');
    });

    it('masks a bare national-length digit run', () =>
    {
        expect(scrubProviderError('destination 821012345678 unreachable'))
            .toBe('destination 82101*****78 unreachable');
    });

    it('leaves timestamps, request ids, regions and message ids alone', () =>
    {
        const message = 'MessageRejected at 2026-09-04T10:53:49.972Z '
            + 'request f47ac10b-58cc-4372-a567-0e02b2c3d479 '
            + 'in us-east-1, message id 0100019a2b3c4d5e-abc12345-0000';

        expect(scrubProviderError(message)).toBe(message);
    });

    it('leaves a Slack ts value alone — it is a decimal, not a number to mask', () =>
    {
        expect(scrubProviderError('thread_ts 1725439200.123456 not found'))
            .toBe('thread_ts 1725439200.123456 not found');
    });

    it('masks an address that text looking like an earlier mask runs into', () =>
    {
        expect(scrubProviderError('see ab***@x.com.someone@example.com')).toBe('see ab***@x.***@example.com');
    });

    it('returns an empty string for empty or non-string input', () =>
    {
        expect(scrubProviderError('')).toBe('');
        expect(scrubProviderError(undefined as unknown as string)).toBe('');
        expect(scrubProviderError(42 as unknown as string)).toBe('');
    });
});

describe('scrubProviderError with the send\'s attachments', () =>
{
    const TO = 'jane.doe@example.com';
    const named = (filename: string) => [{ filename }];

    it('masks the address when the filename "@" is a part of it', () =>
    {
        expect(scrubProviderError(`Message rejected for ${TO}`, named('@')))
            .toBe('Message rejected for ja***@example.com');
    });

    it('a one-letter filename is matched only as a whole word', () =>
    {
        expect(scrubProviderError(`Message rejected for ${TO}: blocked file e, each time`, named('e')))
            .toBe('Message rejected for ja***@example.com: blocked file [attachment 1], each time');
    });

    it('removes a filename that holds an address whole, and a second scrub keeps it so', () =>
    {
        const scrubbed = scrubProviderError(`Blocked: invoice for ${TO} (1).pdf`, named(`invoice for ${TO} (1).pdf`));

        expect(scrubbed).toBe('Blocked: [attachment 1]');
        expect(scrubProviderError(scrubbed)).toBe(scrubbed);
    });

    it.each([
        ['1', 'Blocked file 1 for jane.doe@example.com'],
        ['ja', 'Blocked file ja for jane.doe@example.com'],
        ['8210', 'Blocked file 8210 for +821012345678'],
    ])('scrubbing again with the same filename %j changes nothing', (filename, message) =>
    {
        const once = scrubProviderError(message, named(filename));

        expect(scrubProviderError(once, named(filename))).toBe(once);
    });

    it('masks an address whose local part is a digit run as an address', () =>
    {
        expect(scrubProviderError('rejected: 01012345678@example.com')).toBe('rejected: 01***@example.com');
    });

    it('an empty filename removes nothing', () =>
    {
        expect(scrubProviderError('Blocked file type', named(''))).toBe('Blocked file type');
    });

    it('removes a percent-encoded filename with + for a space', () =>
    {
        expect(scrubProviderError('Blocked: report+%ED%99%8D.pdf', named('report 홍.pdf')))
            .toBe('Blocked: [attachment 1]');
    });

    it.each([
        ['Rejected key uploads%2Fa.pdf', 'Rejected key uploads%2F[attachment 1]'],
        ['Rejected key x%20a.pdf', 'Rejected key x%20[attachment 1]'],
    ])('removes a filename right after a percent escape in %j', (message, scrubbed) =>
    {
        expect(scrubProviderError(message, named('a.pdf'))).toBe(scrubbed);
    });

    it('a filename dropped for overlapping an address does not hide one inside it', () =>
    {
        const attachments = [{ filename: '홍길동 진단서.pdf' }, { filename: 'com 홍길동 진단서.pdf' }];

        expect(scrubProviderError('Rejected for kim@example.com 홍길동 진단서.pdf', attachments))
            .toBe('Rejected for ki***@example.com [attachment 1]');
    });

    it('a dropped filename does not hide two shorter ones inside it', () =>
    {
        const attachments = [{ filename: 'a.pdf' }, { filename: 'b.pdf' }, { filename: 'com a.pdf b.pdf' }];

        expect(scrubProviderError('Rejected for kim@example.com a.pdf b.pdf', attachments))
            .toBe('Rejected for ki***@example.com [attachment 1] [attachment 2]');
    });

    it('an occurrence dropped for overlapping an address does not hide the next one of the same name', () =>
    {
        expect(scrubProviderError('Rejected for kim@x.com x.com x.com', named('x.com x.com')))
            .toBe('Rejected for ki***@x.com [attachment 1]');
    });

    it('a null attachment list from a plain-JS caller is no attachments, not a throw', () =>
    {
        expect(scrubSendResult({ success: false, error: 'Rejected for jane.doe@example.com' }, null))
            .toEqual({ success: false, error: 'Rejected for ja***@example.com' });
    });

    it('a filename that starts with a character outside the BMP is removed at each place it occurs', () =>
    {
        expect(scrubProviderError('Blocked: 😀 scan.pdf, 😀 scan.pdf', named('😀 scan.pdf')))
            .toBe('Blocked: [attachment 1], [attachment 1]');
    });

    it('a filename with a lone surrogate is still removed as written, without throwing', () =>
    {
        expect(scrubProviderError('Blocked: \uD800.pdf', named('\uD800.pdf'))).toBe('Blocked: [attachment 1]');
    });
});
