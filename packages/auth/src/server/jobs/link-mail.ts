/**
 * @spfn/auth - Link Mail Job
 *
 * Every mail the two link flows send leaves through here: the confirmation link
 * of a verified-email signup, the link of a password reset, and the "you already
 * have an account" notice the signup path answers an existing address with —
 * and so does every verification code `POST /_auth/codes` sends, by email or SMS.
 *
 * Why a job at all. Those cases used to be awaited on the request path, and only
 * one branch of each sends anything — so how long the endpoint took told a
 * caller whether the address had an account. Moving the send off the request
 * makes both branches cost one round of database writes and nothing else.
 *
 * Why the payload is a row id and not the mail. `@spfn/notification` can queue a
 * send of its own, but its payload carries the *rendered* mail, which for these
 * templates means the link token or the code in plaintext sitting in `pgboss.job`
 * until archive. So the queue carries a reference and the credential is minted
 * here, in the worker, moments before it is sent: the plaintext exists in the
 * mail and nowhere else. A verification code is not minted here — its row holds
 * it — but it is read from that row rather than copied into the queue. Nothing
 * in this file logs a URL, a token or a code.
 *
 * Retries. A failed send throws, so pg-boss retries, and the retry re-mints —
 * the token from the failed attempt stops matching the row. Everything that can
 * fail therefore happens before the send, and nothing runs after it.
 */

import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { job } from '@spfn/core/job';
import { TargetTypeSchema } from '../routes/schema';
import {
    issuePasswordResetLink,
    issueSignupLink,
    sendAccountExistsNotice,
    sendVerificationCode,
} from '../services/link-mail.service';

/**
 * What the worker is being asked to send.
 *
 * A reference in every case — a row of one of the two link tables or of
 * `verification_codes`, or the target a notice goes to. No secret, no URL, no
 * rendered body.
 */
export const linkMailPayloadSchema = Type.Union([
    Type.Object({
        kind: Type.Literal('signup-link'),
        rowId: Type.Integer(),
    }),
    Type.Object({
        kind: Type.Literal('password-reset'),
        rowId: Type.Integer(),
    }),
    Type.Object({
        kind: Type.Literal('account-exists'),
        target: Type.String(),
        targetType: TargetTypeSchema,
    }),
    Type.Object({
        kind: Type.Literal('verification-code'),
        rowId: Type.Integer(),
    }),
]);

export type LinkMailPayload = Static<typeof linkMailPayloadSchema>;

/**
 * The row a link payload names, refused when it is not there.
 *
 * `.run()` bypasses the input schema and a queue written by an older version of
 * this package can hold a shape this one does not know, so the payload is
 * checked here rather than trusted.
 */
function requireRowId(payload: { kind: string; rowId?: number }): number
{
    if (typeof payload.rowId !== 'number')
    {
        throw new Error(`[auth.link-mail] ${payload.kind} payload carries no rowId`);
    }

    return payload.rowId;
}

/**
 * Send the mail one request deferred.
 *
 * The kinds share a queue because they share a reason to exist: each is a
 * message whose presence or absence would otherwise be visible in how long a
 * request took.
 */
export const linkMailJob = job('auth.link-mail')
    .input(linkMailPayloadSchema)
    .options({ retryLimit: 3 })
    .handler(async (payload: LinkMailPayload) =>
    {
        if (payload.kind === 'signup-link')
        {
            return await issueSignupLink(requireRowId(payload));
        }

        if (payload.kind === 'password-reset')
        {
            return await issuePasswordResetLink(requireRowId(payload));
        }

        if (payload.kind === 'account-exists')
        {
            return await sendAccountExistsNotice(payload.target, payload.targetType);
        }

        if (payload.kind === 'verification-code')
        {
            return await sendVerificationCode(requireRowId(payload));
        }

        throw new Error(`[auth.link-mail] unknown payload kind: ${JSON.stringify(payload)}`);
    });
