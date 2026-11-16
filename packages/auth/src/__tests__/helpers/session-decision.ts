/**
 * Run interceptor phases the way the proxy runs them: inside the session
 * decision, which is first in `authInterceptors` and the only writer of this
 * package's cookies. A suite that drives one rule on its own reads the cookies
 * that rule proposed only once the decision has run around it.
 */

import type {
    RequestInterceptor,
    RequestInterceptorContext,
    ResponseInterceptor,
    ResponseInterceptorContext,
} from '@spfn/core/nextjs/server';
import { executeRequestInterceptors, executeResponseInterceptors } from '@spfn/core/nextjs/server';

import { sessionDecisionInterceptor } from '../../nextjs/interceptors';

type Phase<C> = ((ctx: C, next: () => Promise<void>) => Promise<void>) | undefined;

/** `next` as the last link, so a suite's spy on it still sees the call. */
function tail<C>(next: () => Promise<void>): (ctx: C, chainNext: () => Promise<void>) => Promise<void>
{
    return async () =>
    {
        await next();
    };
}

/** Response phases inside the session decision. */
export async function decidedResponse(
    ctx: ResponseInterceptorContext,
    phases: Phase<ResponseInterceptorContext>[],
    next: () => Promise<void> = async () => undefined,
): Promise<void>
{
    const chain = [sessionDecisionInterceptor.response!, ...phases.filter(phase => !!phase), tail(next)];

    // The decision's request phase registers it for this request, as the proxy runs it
    await sessionDecisionInterceptor.request!({ metadata: ctx.metadata } as RequestInterceptorContext, async () => undefined);
    await executeResponseInterceptors(ctx, chain as ResponseInterceptor[]);
}

/** Request phases inside the session decision, so a refusal carries its cookies. */
export async function decidedRequest(
    ctx: RequestInterceptorContext,
    phases: Phase<RequestInterceptorContext>[],
    next: () => Promise<void> = async () => undefined,
): Promise<void>
{
    const chain = [sessionDecisionInterceptor.request!, ...phases.filter(phase => !!phase), tail(next)];

    await executeRequestInterceptors(ctx, chain as RequestInterceptor[]);
}
