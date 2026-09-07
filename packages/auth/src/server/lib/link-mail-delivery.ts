/**
 * @spfn/auth - Link Mail Delivery Mode
 *
 * Decides who sends a link mail: the `auth.link-mail` worker, or the request
 * itself. The two paths write the same row and mint the same way — only the
 * moment, and what a failed send means, differ.
 *
 * `auto` (the default) queues when pg-boss is initialised and sends inline when
 * it is not, which is what lets an app that never registered a job router keep
 * working exactly as it did before. `inline` and `queued` pin the choice for an
 * app that wants it stated.
 *
 * The one case worth the code below: an app initialised pg-boss but never
 * registered `authJobRouter`, so the queue does not exist and the enqueue fails.
 * Losing the mail there would be silent and would look like a mail-provider
 * outage, so `auto` sends that request inline and says once, loudly, what to
 * register. Every other enqueue failure — a database outage, most of all —
 * surfaces, because falling back on those would hide the outage behind mail that
 * still gets through.
 *
 * A refused *send*, on the other hand, never surfaces from here: see
 * `sendInlineQuietly` below for why the request's answer must not depend on the
 * mail provider.
 */

import { env } from '@spfn/auth/config';
import { getBoss } from '@spfn/core/job';
import { authLogger } from '../logger';
import { linkMailJob } from '../jobs/link-mail';
import type { LinkMailPayload } from '../jobs/link-mail';

export type LinkMailDelivery = 'auto' | 'inline' | 'queued';

/**
 * Whether the missing-queue warning has already been given.
 *
 * Per process, not per request: the condition is a deployment mistake that every
 * request hits, and a per-request warning would bury the one line that names the
 * fix under thousands of copies of itself.
 */
let warnedQueueMissing = false;

/**
 * Forget the warning, so a test can assert "once" more than once.
 *
 * @internal test-only
 */
export function resetLinkMailFallbackWarning(): void
{
    warnedQueueMissing = false;
}

/**
 * Configured delivery mode.
 *
 * An unknown value is refused by the config layer (`SPFN_AUTH_LINK_MAIL_DELIVERY`
 * is declared as an enum), so this never has to defend against one.
 */
export function getLinkMailDelivery(): LinkMailDelivery
{
    return env.SPFN_AUTH_LINK_MAIL_DELIVERY ?? 'auto';
}

/**
 * Whether an enqueue failed because nobody registered the queue.
 *
 * Matched on the message rather than on an error class: pg-boss 11 throws a
 * plain `Error` reading `Queue auth.link-mail does not exist`, so there is no
 * class to test, and naming the queue in the pattern is what keeps an unrelated
 * failure — a dropped connection, a permission error — from being read as this
 * one and quietly falling back.
 */
function isMissingQueueError(error: unknown): boolean
{
    return error instanceof Error
        && new RegExp(`queue ${linkMailJob.name} does not exist`, 'i').test(error.message);
}

/**
 * Enqueue, reporting failure as a value.
 *
 * The caller decides what a failure means, and deciding it here would put a
 * `throw` inside the `catch` that produced it.
 */
async function enqueueLinkMail(payload: LinkMailPayload): Promise<unknown>
{
    // `JobDef['send']` is a conditional type on the payload, and a payload that is
    // a union distributes it into three call signatures TypeScript will not let a
    // caller choose between. There is one job and one payload type; this says so.
    const send = linkMailJob.send as (input: LinkMailPayload) => Promise<string | null>;

    try
    {
        await send(payload);

        return null;
    }
    catch (error)
    {
        return error ?? new Error('[auth.link-mail] enqueue failed');
    }
}

/**
 * Send on the request path, and let the request answer as if it had worked.
 *
 * `inlineSend` is `issueSignupLink` or `issuePasswordResetLink`, and both throw
 * when the provider refuses — correct in the worker, where the throw is what
 * makes pg-boss retry. On the request path there is no retry to ask for and the
 * throw becomes a 500, while the branch that had no mail to send still answers
 * 200: during a mail outage the pair of statuses says which addresses have an
 * account, at the two endpoints whose entire design is that both branches answer
 * alike. So the request's answer must not depend on the mail provider. The
 * failure is logged, the user asks again, and only the job path retries.
 *
 * The line names the payload's kind and row id — never the recipient, never a
 * URL — because it is written on behalf of an address the request has not
 * admitted to knowing.
 */
async function sendInlineQuietly(
    inlineSend: () => Promise<void>,
    payload: LinkMailPayload,
): Promise<void>
{
    try
    {
        await inlineSend();
    }
    catch (error)
    {
        authLogger.email.error('Link mail was not sent on the request path', {
            kind: payload.kind,
            rowId: 'rowId' in payload ? payload.rowId : null,
            error,
        });
    }
}

/**
 * Hand a link mail to whoever is going to send it.
 *
 * @param payload - The reference the worker needs; never a secret or a URL
 * @param inlineSend - The same send, performed by this request instead
 */
export async function deliverLinkMail(
    payload: LinkMailPayload,
    inlineSend: () => Promise<void>,
): Promise<void>
{
    const mode = getLinkMailDelivery();

    if (mode === 'inline' || (mode === 'auto' && !getBoss()))
    {
        return await sendInlineQuietly(inlineSend, payload);
    }

    const error = await enqueueLinkMail(payload);

    if (!error)
    {
        return;
    }

    if (mode === 'queued' || !isMissingQueueError(error))
    {
        throw error;
    }

    if (!warnedQueueMissing)
    {
        warnedQueueMissing = true;
        authLogger.service.warn(
            `Queue ${linkMailJob.name} does not exist, so this link mail was sent on the request path. `
            + "Register the auth job router — .jobs(authJobRouter) — or set SPFN_AUTH_LINK_MAIL_DELIVERY='inline'.",
        );
    }

    await sendInlineQuietly(inlineSend, payload);
}
