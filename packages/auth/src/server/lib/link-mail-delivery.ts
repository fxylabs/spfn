/**
 * @spfn/auth - Link Mail Delivery Mode
 *
 * Decides who sends a link mail or a verification code: the `auth.link-mail`
 * worker, or the request's own process once its transaction has committed —
 * never the request's answer, which waits for neither. The two paths write the
 * same row and mint the same way — only the moment, and what a failed send
 * means, differ.
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
 * `sendInline` below for why the request's answer must not depend on the
 * mail provider.
 *
 * Both the send and the enqueue wait for the caller's transaction to commit:
 * the job runs on pg-boss's own connection, so enqueued inside the transaction
 * it could run before the row it names is visible, and find nothing to send.
 * Inline sends left running after the answer are drained on a graceful
 * shutdown (`settleLinkMail`), before the database closes under them. Queued
 * delivery has no such protection: `@spfn/core` stops pg-boss before that
 * drain, so an enqueue still in flight then fails, is logged and not delivered.
 */

import { env } from '@spfn/auth/config';
import { getBoss } from '@spfn/core/job';
import { getTransactionContext, onAfterCommit } from '@spfn/core/db';
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
 * How long a shutdown waits for link mail still in flight. A provider call
 * takes seconds; one blocked for longer is abandoned, and named in the log.
 */
const LINK_MAIL_SHUTDOWN_WAIT_MS = 10_000;

/**
 * Sends and enqueues started after a commit and not yet finished, each with the
 * payload it carries; read by `settleLinkMail`.
 */
const inFlight = new Map<Promise<void>, LinkMailPayload>();

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
    try
    {
        await linkMailJob.send(payload);

        return null;
    }
    catch (error)
    {
        return error ?? new Error('[auth.link-mail] enqueue failed');
    }
}

/**
 * Send outside the request's answer, now: the caller has committed, or was in
 * no transaction.
 *
 * `inlineSend` is one of the `link-mail.service` sends, and they throw when the
 * provider refuses — correct in the worker, where the throw is what makes
 * pg-boss retry. On the request path there is no retry to ask for and the throw
 * became a 500, while the branch that had nothing to send still answered 200:
 * during an outage the pair of statuses said which addresses have an account.
 * Awaiting a send that succeeds says the same thing in how long the answer took.
 * So the request never waits for it, and a failure is logged. The user asks
 * again; only the job path retries.
 *
 * The line names the payload's kind and row id — never the recipient, never a
 * URL — because it is written on behalf of an address the request has not
 * admitted to knowing.
 */
function sendInline(inlineSend: () => Promise<void>, payload: LinkMailPayload): void
{
    track(payload, inlineSend().catch((error: unknown) =>
    {
        authLogger.email.error('Link mail was not sent on the request path', { ...describe(payload), error });
    }));
}

/** Keep `work` where a shutdown can wait for it, until it settles. */
function track(payload: LinkMailPayload, work: Promise<void>): void
{
    inFlight.set(work, payload);
    void work.finally(() => inFlight.delete(work));
}

/** What a log line may say about a payload: its kind and row, never its recipient. */
function describe(payload: LinkMailPayload): { kind: string; rowId: number | null }
{
    return { kind: payload.kind, rowId: 'rowId' in payload ? payload.rowId : null };
}

/**
 * Wait, at most `timeoutMs`, until every inline send started after a commit
 * has finished — the auth lifecycle's `beforeShutdown`, so a graceful shutdown
 * does not close the database under them. What is still running at the bound
 * is abandoned and logged by kind and row.
 *
 * It does not protect queued delivery: `@spfn/core` stops pg-boss before
 * `beforeShutdown`, so an after-commit enqueue still in flight then fails and
 * is logged (`Link mail was not queued after the commit`) — no mail.
 *
 * A request no longer waits for its mail, so a test that reads what was sent
 * waits here as well.
 */
export async function settleLinkMail(timeoutMs = LINK_MAIL_SHUTDOWN_WAIT_MS): Promise<void>
{
    const deadline = Date.now() + timeoutMs;

    while (inFlight.size > 0 && Date.now() < deadline)
    {
        await settledWithin(Promise.all(inFlight.keys()), deadline - Date.now());
    }

    if (inFlight.size > 0)
    {
        authLogger.email.error('Link mail still in flight at shutdown was abandoned', {
            abandoned: [...inFlight.values()].map(describe),
        });
    }
}

/** `work` settled, or `ms` passed — whichever comes first. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<void>
{
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) =>
    {
        timer = setTimeout(resolve, ms);
    });

    await Promise.race([work, bound]);
    clearTimeout(timer);
}

/**
 * Hand a link mail to whoever is going to send it, once the caller's
 * transaction has committed (`onAfterCommit`).
 *
 * Called in no transaction, the enqueue is awaited and an enqueue failure
 * surfaces to the caller. Called inside one, the enqueue runs after the commit,
 * when the request has already answered 200: a failure — but the missing queue
 * in `auto`, which sends inline — means no mail and one log line (kind, row
 * id), and the person asks again. There is no inline resend — a "failed"
 * enqueue may have reached the queue, and a resend would send the mail twice.
 * A rolled-back transaction enqueues and sends nothing.
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
        onAfterCommit(() => sendInline(inlineSend, payload));

        return;
    }

    if (!getTransactionContext())
    {
        await queueLinkMail(payload, inlineSend, mode);

        return;
    }

    onAfterCommit(() => track(payload, queueLinkMail(payload, inlineSend, mode).catch((error: unknown) =>
    {
        authLogger.email.error('Link mail was not queued after the commit', { ...describe(payload), error });
    })));
}

/**
 * Enqueue, falling back to an inline send only in `auto` and only for the queue
 * nobody registered — every other failure is the caller's to see.
 */
async function queueLinkMail(
    payload: LinkMailPayload,
    inlineSend: () => Promise<void>,
    mode: LinkMailDelivery,
): Promise<void>
{
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

    sendInline(inlineSend, payload);
}
