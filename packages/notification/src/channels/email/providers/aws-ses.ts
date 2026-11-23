/**
 * @spfn/notification - AWS SES v2 Email Provider
 */

import type { SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import type { EmailProvider, InternalSendEmailParams } from '../types';
import type { SendResult } from '../../types';
import { env, getSesConfigurationSetName } from '../../../config';
import { maskRecipients, scrubProviderError } from '../../../privacy';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:ses');

let sesClient: any = null;

/**
 * SES v2's maximum message size, attachments included, measured after base64
 * encoding: "40 MB per message" (SES Developer Guide, Service quotas, Message
 * quotas). SES counts MB in binary units — its v1 rejection for the 10 MB
 * limit reads "Message length is more than 10485760 bytes long".
 */
export const SES_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

/**
 * SES's rejection of a message over the size limit. The endpoint answering
 * HTTP 413 before SES reads the message is the other form, told by status.
 */
const SIZE_REJECTION = /Message length is more than \d+ bytes/;

/**
 * Get or create SES v2 client
 */
async function getSESClient()
{
    if (sesClient)
    {
        return sesClient;
    }

    try
    {
        const { SESv2Client } = await import('@aws-sdk/client-sesv2');

        sesClient = new SESv2Client({
            region: env.AWS_REGION,
            credentials: env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
                ? {
                    accessKeyId: env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
                }
                : undefined,
        });

        log.debug('SES v2 client created', { region: env.AWS_REGION });

        return sesClient;
    }
    catch
    {
        throw new Error(
            '@aws-sdk/client-sesv2 is not installed. ' +
            'Please install it: pnpm add @aws-sdk/client-sesv2',
        );
    }
}

/**
 * Build the message content: the subject, whichever of the HTML and text
 * bodies the send carries, and its attachments. Simple content takes
 * attachments in SES v2, so no raw MIME is built here.
 */
function buildContent(params: InternalSendEmailParams): SendEmailCommandInput['Content']
{
    return {
        Simple: {
            Subject: {
                Charset: 'UTF-8',
                Data: params.subject,
            },
            Body: {
                ...(params.html && {
                    Html: {
                        Charset: 'UTF-8',
                        Data: params.html,
                    },
                }),
                ...(params.text && {
                    Text: {
                        Charset: 'UTF-8',
                        Data: params.text,
                    },
                }),
            },
            ...(params.attachments?.length && {
                Attachments: params.attachments.map(attachment => ({
                    RawContent: attachment.content,
                    FileName: attachment.filename,
                    ContentType: attachment.contentType,
                    ContentDisposition: 'ATTACHMENT' as const,
                })),
            }),
        },
    };
}

/**
 * Build the SendEmailCommand input. `ConfigurationSetName` is present only when
 * a configuration set is configured, so without one the request is unchanged.
 */
function buildSendEmailInput(params: InternalSendEmailParams): SendEmailCommandInput
{
    const configurationSetName = getSesConfigurationSetName();

    return {
        FromEmailAddress: params.from,
        Destination: {
            ToAddresses: params.to,
        },
        ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
        Content: buildContent(params),
        ...(configurationSetName && { ConfigurationSetName: configurationSetName }),
    };
}

/**
 * AWS SES v2 Email Provider
 */
export const awsSesProvider: EmailProvider = {
    name: 'aws-ses',
    supportsAttachments: true,
    maxMessageBytes: SES_MAX_MESSAGE_BYTES,

    async send(params: InternalSendEmailParams): Promise<SendResult>
    {
        try
        {
            const client = await getSESClient();
            const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');

            const response = await client.send(new SendEmailCommand(buildSendEmailInput(params)));

            return {
                success: true,
                messageId: response.MessageId,
            };
        }
        catch (error)
        {
            const err = error as Error & { $metadata?: { httpStatusCode?: number } };
            // The Error object itself is not passed to the logger: it would print
            // err.stack, whose first line repeats `${name}: ${message}` and with it
            // the address this scrub just removed. The name and the HTTP status
            // carry the diagnostic value instead.
            const message = scrubProviderError(err.message, params.attachments) || 'Unknown error';

            log.error('SES send failed', {
                provider: 'aws-ses',
                name: err.name,
                status: err.$metadata?.httpStatusCode,
                error: message,
                to: maskRecipients(params.to),
                from: params.from,
            });

            const tooLarge = err.$metadata?.httpStatusCode === 413 || SIZE_REJECTION.test(err.message);

            return {
                success: false,
                error: message,
                ...(tooLarge && { errorCode: 'message_too_large' as const }),
            };
        }
    },
};
