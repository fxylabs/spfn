/**
 * The session decision: what the browser's session is after this response
 *
 * Every rule that matches a request may learn something about the session — a
 * sign-in made a new one, the cookie could not be read, the backend refused the
 * key, the cookie is near its end — and none of them writes a session cookie.
 * Each *proposes* an outcome on the shared metadata:
 *
 * - `establish(session)` — a sign-in-like rule installed a new session
 * - `clear(reason)` — a rule learned the session is gone
 * - `refresh(session)` — the same session, re-sealed (near its end, or its
 *   binding changed)
 *
 * and `sessionDecisionInterceptor`, registered first so that its response phase
 * runs after every other rule's, decides once: `establish` > `clear` >
 * `refresh` > leave as is — a new session wins — and writes the whole set
 * (session, key id, CSRF, and the pending cookies rules asked for) in one go.
 * Which rule ran last no longer matters.
 *
 * A new session retires the one it replaced in this browser. The decision reads
 * the request's session cookie itself and, when it is the same account's under
 * another key, revokes that key once the new session is written — no rule has to
 * remember to hand it over, so no establishing path can leave an orphan.
 *
 * A session that could not be written is not a success. An `establish` whose
 * seal fails answers `SessionSealFailedError` in place of the backend's 200, and
 * the key the sign-in registered is revoked through the backend's own sign-out,
 * signed by that key — nobody else holds it.
 *
 * A proposal on a request the decision is not registered for — a custom
 * interceptor list without it — answers `SessionDecisionMissingError` in place
 * of the response (and, for a new session, revokes its key the same way), so a
 * misconfigured proxy fails loudly instead of answering 200 with no cookie.
 */

import type { BackendAnswer, InterceptorRule, ResponseInterceptorContext, RequestInterceptorContext } from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';
import type { HttpError } from '@spfn/core/errors';
import { SessionDecisionMissingError, SessionResealFailedError, SessionSealFailedError } from '@spfn/auth/errors';

import { readSealedSession, type SessionData, type SessionUnsealFailure } from '../../server/lib/session';
import { deriveCsrfToken, timingSafeEqualString } from '../../server/lib/csrf';
import { COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import {
    clearedSessionCookies,
    csrfCookie,
    sessionCookies,
    sessionTtlOf,
    signedOutCookies,
} from '../cookie-writer';
import { errorCodeOf, refusalBody, refusalEnvelope } from './error-envelope';
import { signedRequestHeaders } from './request-token';

/**
 * Why a session is cleared.
 *
 * An unreadable cookie by its unsealing failure; `key-refused` when the backend
 * answered with the key-refused family; `context-changed` for a bound session
 * presented from another browser; `reseal-failed` when a binding change could not
 * be written; `signed-out` for a sign-out, which expires every cookie of this
 * package rather than the session's three.
 */
export type ClearReason = SessionUnsealFailure | 'key-refused' | 'context-changed' | 'reseal-failed' | 'signed-out';

type Proposal =
    | { kind: 'establish'; session: SessionData }
    | { kind: 'clear'; reason: ClearReason }
    | { kind: 'refresh'; session: SessionData; changed: boolean };

/** What the rules of one request proposed. */
interface SessionOutcome
{
    proposals: Proposal[];
    /** Pending cookies a flow holds mid-way, built by the cookie writer. */
    writes: SetCookie[];
    /** Key id whose CSRF cookie a refusal has to reissue. */
    csrfRepair?: string;
}

/** Either phase's context, as a proposal is made on it. */
type ProposalContext = RequestInterceptorContext | ResponseInterceptorContext;

const OUTCOME_KEY = 'sessionOutcome';

/** Set by the decision's request phase: a proposal made without it has nobody to decide it. */
const DECIDING_KEY = 'sessionDecisionRegistered';

function outcomeOf(ctx: Pick<ProposalContext, 'metadata'>): SessionOutcome
{
    ctx.metadata[OUTCOME_KEY] ??= { proposals: [], writes: [] };

    return ctx.metadata[OUTCOME_KEY];
}

/**
 * The outcome a rule proposes to — or `null`, when the decision is not
 * registered for this request and the answer has been replaced with the
 * configuration error instead.
 *
 * Without the decision every proposal would be accepted and nothing written:
 * a sign-in would answer 200 with no cookie, no error and no log.
 */
function proposalsOf(ctx: ProposalContext): SessionOutcome | null
{
    if (ctx.metadata[DECIDING_KEY] === true)
    {
        return outcomeOf(ctx);
    }

    const error = new SessionDecisionMissingError();

    authLogger.interceptor.general.error(error.message, { path: ctx.path });

    if ('response' in ctx)
    {
        answerWith(ctx, error);
    }
    else
    {
        ctx.abort = refusalEnvelope(error);
    }

    return null;
}

/**
 * A sign-in-like rule installed this session.
 *
 * With no decision to write it, the session cannot be written: the key the
 * sign-in registered is revoked as for a seal that failed.
 */
export async function establish(ctx: ResponseInterceptorContext, session: SessionData): Promise<void>
{
    const outcome = proposalsOf(ctx);

    if (!outcome)
    {
        await revokeKey(ctx, session, 'Could not revoke the key of a session that was not written');

        return;
    }

    outcome.proposals.push({ kind: 'establish', session });
}

/** The session this browser holds is gone. */
export function clear(ctx: ProposalContext, reason: ClearReason): void
{
    proposalsOf(ctx)?.proposals.push({ kind: 'clear', reason });
}

/**
 * The same session, re-sealed.
 *
 * @param changed - its content changed (a binding setting), so failing to write
 *   it is answered as a failure rather than left for the next request
 */
export function refresh(ctx: ProposalContext, session: SessionData, changed = false): void
{
    proposalsOf(ctx)?.proposals.push({ kind: 'refresh', session, changed });
}

/** A pending cookie a flow holds mid-way, or its expiry — built by the cookie writer. */
export function writeCookie(ctx: ProposalContext, cookie: SetCookie): void
{
    proposalsOf(ctx)?.writes.push(cookie);
}

/** A CSRF refusal reissues the token cookie for this key. */
export function repairCsrf(ctx: ProposalContext, keyId: string): void
{
    const outcome = proposalsOf(ctx);

    if (outcome)
    {
        outcome.csrfRepair = keyId;
    }
}

const RANK: Record<Proposal['kind'], number> = { establish: 3, clear: 2, refresh: 1 };

/** A changed refresh over a plain one; a sign-out over any other clear, since it expires more. */
function outranksItsKind(proposal: Proposal): boolean
{
    return (proposal.kind === 'refresh' && proposal.changed)
        || (proposal.kind === 'clear' && proposal.reason === 'signed-out');
}

/** The proposal that decides: the highest rank, the first of equals. */
function decisive(proposals: Proposal[]): Proposal | undefined
{
    const rank = (proposal: Proposal): number => RANK[proposal.kind] + (outranksItsKind(proposal) ? 0.5 : 0);

    return proposals.reduce<Proposal | undefined>(
        (best, proposal) => (!best || rank(proposal) > rank(best) ? proposal : best),
        undefined,
    );
}

/**
 * Session Decision Interceptor
 *
 * Registered first: both phases run the rest of the chain inside `next()` and
 * decide afterwards. A request refused in its request phase (`ctx.abort`) gets
 * the decided cookies on the refusal — the only cookies a refusal can carry.
 */
export const sessionDecisionInterceptor: InterceptorRule = {
    pathPattern: '*',

    request: async (ctx, next) =>
    {
        ctx.metadata[DECIDING_KEY] = true;
        await next();

        if (ctx.abort)
        {
            ctx.abort.setCookies = await refusalCookies(ctx);
        }
    },

    response: async (ctx, next) =>
    {
        await next();

        const outcome = outcomeOf(ctx);
        const decided = await decidedCookies(ctx, outcome.proposals);

        // Decided once: the outcome is spent with this write
        delete ctx.metadata[OUTCOME_KEY];
        ctx.setCookies.push(...outcome.writes, ...decided);
    },
};

/** What a request-phase refusal carries: the pending-cookie writes, and a clear or the CSRF repair. */
async function refusalCookies(ctx: RequestInterceptorContext): Promise<SetCookie[]>
{
    const outcome = outcomeOf(ctx);

    if (outcome.proposals.some(proposal => proposal.kind === 'clear'))
    {
        return [...outcome.writes, ...clearedSessionCookies()];
    }

    return [...outcome.writes, ...(outcome.csrfRepair ? await repairedCsrfCookies(ctx, outcome.csrfRepair) : [])];
}

/**
 * The reissued CSRF cookie, or nothing when it cannot be derived.
 *
 * A refusal that cannot carry its repair is still the refusal; the request-side
 * check already failed closed on a derivation it could not make.
 */
async function repairedCsrfCookies(ctx: ProposalContext, keyId: string): Promise<SetCookie[]>
{
    const session: SessionData | undefined = ctx.metadata.inboundSession;

    return await Promise.resolve()
        .then(async () => [await csrfCookie(keyId, sessionTtlOf(session ?? {}))])
        .catch((error) =>
        {
            authLogger.interceptor.csrf.error('Cannot reissue the CSRF cookie', error as Error);

            return [];
        });
}

/** The cookies the decisive proposal writes; a response that is not a success establishes nothing. */
async function decidedCookies(ctx: ResponseInterceptorContext, proposals: Proposal[]): Promise<SetCookie[]>
{
    const live = proposals.filter(proposal => proposal.kind !== 'establish' || ctx.response.ok);
    const proposal = decisive(live);

    switch (proposal?.kind)
    {
        case 'establish':
            return await establishedCookies(ctx, proposal, live);
        case 'clear':
            return proposal.reason === 'signed-out' ? signedOutCookies(ctx.cookies) : clearedSessionCookies();
        case 'refresh':
            return await refreshedCookies(ctx, proposal.session, proposal.changed);
        default:
            return await healedCsrfCookies(ctx);
    }
}

/**
 * The new session's cookies — or, when they cannot be built, the typed failure,
 * the revocation of the key nobody now holds, and whatever else was proposed.
 */
async function establishedCookies(
    ctx: ResponseInterceptorContext,
    { session }: Extract<Proposal, { kind: 'establish' }>,
    proposals: Proposal[],
): Promise<SetCookie[]>
{
    const built = await sessionCookies(session).catch((error) =>
    {
        authLogger.interceptor.general.error('Failed to write the session a sign-in established', error as Error);

        return null;
    });

    if (built)
    {
        await retirePrevious(ctx, session);

        return built;
    }

    answerWith(ctx, new SessionSealFailedError());
    await revokeKey(ctx, session, 'Could not revoke the key of a session that was not written');

    return await decidedCookies(ctx, proposals.filter(proposal => proposal.kind !== 'establish'));
}

/**
 * Ask the backend to revoke a session's key, through its own sign-out signed by
 * that key — the same call a sign-out makes.
 *
 * Used for the key a session was not written for: the request this response
 * answers registered it, and the private half is only here. A failure is logged
 * with the key id, so the key can be found and revoked by hand.
 */
async function revokeKey(ctx: ResponseInterceptorContext, session: SessionData, failure: string): Promise<void>
{
    const answer = await signOutAs(ctx, session);

    if (!answer?.ok)
    {
        authLogger.interceptor.general.error(failure, { keyId: session.keyId, status: answer?.status });
    }
}

/** The backend's sign-out, signed by the session's key: its answer, or null when it could not be reached. */
async function signOutAs(ctx: ResponseInterceptorContext, session: SessionData): Promise<BackendAnswer | null>
{
    return ctx.callBackend
        ? await ctx.callBackend({ method: 'POST', path: '/_auth/logout', headers: signedRequestHeaders(session), body: {} })
            .catch(() => null)
        : null;
}

/** The session this browser sent with the request, when its cookie unseals; the same read the clear decision makes. */
async function inboundSessionOf(ctx: ResponseInterceptorContext): Promise<SessionData | undefined>
{
    const sealed = ctx.cookies.get(COOKIE_NAMES.SESSION);
    const read = sealed ? await readSealedSession(sealed) : null;

    return read && 'session' in read ? read.session : undefined;
}

/**
 * Revoke the key of the session a sign-in replaced in this browser — the same
 * account's only, by the account the backend answered for. Another account's
 * session (an invitation accepted, a sign-up completed, a social sign-in into a
 * second account) is left alone: it is not this account's to end.
 *
 * A sign-in that proves the replacement (password or passkey login), a rotation
 * and a renewal have the backend revoke the previous key itself, and their
 * answers do not say so. Its sign-out then answers `KeyRevokedError` — the key is
 * already gone, which is the outcome asked for, not a failure. Any other failure
 * is logged with the key id and the sign-in stands.
 */
async function retirePrevious(ctx: ResponseInterceptorContext, session: SessionData): Promise<void>
{
    const previous = await inboundSessionOf(ctx);

    if (!previous || previous.userId !== session.userId || previous.keyId === session.keyId)
    {
        return;
    }

    const answer = await signOutAs(ctx, previous);

    if (!answer?.ok && errorCodeOf(answer?.body) !== 'KeyRevokedError')
    {
        authLogger.interceptor.general.error('Could not revoke the previous key of a sign-in', {
            keyId: previous.keyId,
            status: answer?.status,
        });
    }
}

/**
 * The re-sealed session. Failing to write a session whose content did not change
 * leaves the cookie the browser has, still valid; failing to write a changed one
 * is answered as `SessionResealFailedError` and clears it.
 */
async function refreshedCookies(ctx: ResponseInterceptorContext, session: SessionData, changed: boolean): Promise<SetCookie[]>
{
    const built = await sessionCookies(session).catch((error) =>
    {
        authLogger.interceptor.general.error('Failed to re-seal the session', error as Error);

        return null;
    });

    if (built || !changed)
    {
        return built ?? [];
    }

    answerWith(ctx, new SessionResealFailedError());

    return clearedSessionCookies();
}

/**
 * Leave the session as is — but reissue its CSRF cookie when the request's copy
 * is missing or stale.
 *
 * A session that predates CSRF protection carries no readable cookie, and one
 * whose value stopped matching would otherwise sit broken until the session came
 * within a day of expiry; any authenticated response repairs it. A derivation
 * failure is logged rather than answered: the request-side check refuses those.
 */
async function healedCsrfCookies(ctx: ResponseInterceptorContext): Promise<SetCookie[]>
{
    const session: SessionData | undefined = ctx.metadata.inboundSession;
    const repair = outcomeOf(ctx).csrfRepair;

    if (repair)
    {
        return await repairedCsrfCookies(ctx, repair);
    }

    if (!session)
    {
        return [];
    }

    const expected = await deriveCsrfToken(session.keyId).catch(() => undefined);
    const presented = ctx.cookies.get(COOKIE_NAMES.CSRF);

    return expected && presented && timingSafeEqualString(expected, presented)
        ? []
        : await repairedCsrfCookies(ctx, session.keyId);
}

/** Replace the backend's answer with a registered refusal. */
function answerWith(ctx: ResponseInterceptorContext, error: HttpError): void
{
    ctx.response.ok = false;
    ctx.response.status = error.statusCode;
    ctx.response.statusText = error.name;
    ctx.response.body = refusalBody(error);
}
