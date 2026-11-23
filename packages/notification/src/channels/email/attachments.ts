/**
 * @spfn/notification - Email attachment checks
 *
 * Everything a send with attachments is refused for happens here, before a
 * history row is opened or the provider is called.
 */

import type { EmailAttachment, EmailProvider, InternalSendEmailParams } from './types';
import type { SendResult } from '../types';

/**
 * What a history row records of one attachment. The filename is left out: it
 * is routinely personal data (`jane-doe-medical-report.pdf`), and the row may
 * hash its recipient precisely so it holds none.
 */
export interface AttachmentRecord
{
    /**
     * The lower-cased `type/subtype` alone: a parameter such as
     * `name="jane-doe-medical-report.pdf"` would carry the filename.
     */
    contentType: string;
    size: number;
}

// Control characters (C0, DEL, C1 — NEL U+0085 among them) and the Unicode
// line and paragraph separators: every character a header reader may take
// for a line break.
const CONTROL_OR_LINE_BREAK = /[\p{Cc}\u2028\u2029]/u;
const TOKEN = '[!#$%&\'*+.^_`|~0-9A-Za-z-]+';
const QUOTED = '"[^"\\\\\\p{Cc}\\u2028\\u2029]*"';
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(\\s*;\\s*${TOKEN}=(${TOKEN}|${QUOTED}))*$`, 'u');

/**
 * Why a filename cannot be sent, or undefined
 */
function filenameProblem(filename: unknown): string | undefined
{
    if (typeof filename !== 'string')
    {
        return 'filename is not a string';
    }

    if (filename.trim().length === 0)
    {
        return 'filename is empty';
    }

    return CONTROL_OR_LINE_BREAK.test(filename) ? 'filename contains a control character or line break' : undefined;
}

/**
 * Why one attachment cannot be sent, or undefined. It is checked as a value,
 * not trusted as the TypeScript shape: a plain-JS caller reaches this too.
 * The text names the attachment by position, never by filename, since it
 * reaches logs.
 */
function attachmentProblem(attachment: unknown): string | undefined
{
    if (typeof attachment !== 'object' || attachment === null)
    {
        return 'not an object';
    }

    const { filename, contentType, content } = attachment as Record<string, unknown>;

    return filenameProblem(filename) ?? contentTypeProblem(contentType) ?? contentProblem(content);
}

/**
 * Why a content type cannot be sent, or undefined
 */
function contentTypeProblem(contentType: unknown): string | undefined
{
    if (typeof contentType !== 'string')
    {
        return 'contentType is not a string';
    }

    return MEDIA_TYPE.test(contentType) ? undefined : 'contentType is not a MIME type';
}

/**
 * Why an attachment's bytes cannot be sent, or undefined
 */
function contentProblem(content: unknown): string | undefined
{
    if (!(content instanceof Uint8Array))
    {
        return 'content is not a Uint8Array';
    }

    return content.byteLength === 0 ? 'content is empty' : undefined;
}

/**
 * Why the attachments cannot be sent, naming the first that breaks the
 * contract by position, or undefined
 */
function attachmentsProblem(attachments: unknown): string | undefined
{
    if (attachments === undefined || attachments === null)
    {
        return undefined;
    }

    if (!Array.isArray(attachments))
    {
        return 'Attachments: not an array';
    }

    for (const [index, attachment] of attachments.entries())
    {
        const problem = attachmentProblem(attachment);

        if (problem)
        {
            return `Attachment ${index + 1}: ${problem}`;
        }
    }

    return undefined;
}

/**
 * The first attachment that breaks the contract, as a failed result
 */
export function attachmentsError(attachments: EmailAttachment[] | undefined): SendResult | undefined
{
    const problem = attachmentsProblem(attachments);

    return problem ? { success: false, error: problem, errorCode: 'attachment_invalid' } : undefined;
}

/**
 * A lower bound of the message's encoded size: the attachments as base64
 * plus the subject and bodies as UTF-8. Headers, MIME boundaries and line
 * breaks only add to it, so a message over a limit by this count is over it.
 */
function encodedSizeLowerBound(params: InternalSendEmailParams): number
{
    const attachmentBytes = (params.attachments ?? [])
        .reduce((total, { content }) => total + 4 * Math.ceil(content.byteLength / 3), 0);

    return attachmentBytes + [params.subject, params.text, params.html]
        .reduce((total, part) => total + Buffer.byteLength(part ?? ''), 0);
}

/**
 * Why this provider cannot take this message, as a failed result
 */
export function providerRefusal(provider: EmailProvider, params: InternalSendEmailParams): SendResult | undefined
{
    if (params.attachments?.length && !provider.supportsAttachments)
    {
        return {
            success: false,
            error: `Email provider ${provider.name} does not send attachments`,
            errorCode: 'attachments_unsupported',
        };
    }

    if (provider.maxMessageBytes !== undefined && encodedSizeLowerBound(params) > provider.maxMessageBytes)
    {
        return {
            success: false,
            error: `Email exceeds the ${provider.name} message size limit of ${provider.maxMessageBytes} bytes`,
            errorCode: 'message_too_large',
        };
    }

    return undefined;
}

/**
 * The refusal for attachments on a send whose payload is stored as a JSON job
 */
export function deferredAttachmentsError(attachments: EmailAttachment[] | undefined): SendResult | undefined
{
    return attachments?.length
        ? {
            success: false,
            error: 'Attachments cannot be scheduled or sent distributed; send them immediately',
            errorCode: 'attachments_not_deferrable',
        }
        : undefined;
}

/**
 * What the history row records of the attachments: type and size, no name
 */
export function attachmentRecords(attachments: EmailAttachment[] | undefined): AttachmentRecord[] | undefined
{
    return attachments?.length
        ? attachments.map(({ contentType, content }) => ({ contentType: mediaType(contentType), size: content.byteLength }))
        : undefined;
}

/**
 * The `type/subtype` of a validated content type, lower-cased, without its
 * parameters
 */
function mediaType(contentType: string): string
{
    return contentType.split(';')[0].trim().toLowerCase();
}
