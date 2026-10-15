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
 * Build the message content: the subject and whichever of the HTML and text
 * bodies the send carries
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
            const message = scrubProviderError(err.message) || 'Unknown error';

            log.error('SES send failed', {
                provider: 'aws-ses',
                name: err.name,
                status: err.$metadata?.httpStatusCode,
                error: message,
                to: maskRecipients(params.to),
                from: params.from,
            });

            return {
                success: false,
                error: message,
            };
        }
    },
};
