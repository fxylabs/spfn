/**
 * SPFN_AUTH_GUARD_TIMEOUT — the session lookup behind the guards (case table G1–G8)
 *
 * Every guard reaches the backend through `getAuthSessionData()`. Unset, the
 * variable leaves that call exactly as it was; set, the call carries
 * `.timeout(ms)`, and a lookup that outlives it reads as no session with a warn
 * line of its own. G3 and G4 run the real client from `@spfn/core/nextjs`
 * against a fake `fetch`; the rest stub `authApi` to see which call was made.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApi } from '@spfn/core/nextjs';

import { SessionRenewalRequiredError } from '../../errors';
import { authEnvSchema } from '../../config/schema';

const SESSION = { role: { name: 'admin' }, permissions: [{ name: 'user:read' }] };

afterEach(() =>
{
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
});

describe('getAuthSessionData and SPFN_AUTH_GUARD_TIMEOUT', () =>
{
    it('G1 unset, the backend answers: the session, through the call without .timeout', async () =>
    {
        const route = stubRoute(async () => SESSION);
        const { getAuthSessionData } = await loadAuthUtils(route);

        expect(await getAuthSessionData()).toEqual(SESSION);
        expect(route.timeout).not.toHaveBeenCalled();
        expect(route.call).toHaveBeenCalledTimes(1);
    });

    it('G2 3000, the backend answers within it: the session, through .timeout(3000)', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GUARD_TIMEOUT', '3000');
        const route = stubRoute(async () => SESSION);
        const { getAuthSessionData } = await loadAuthUtils(route);

        expect(await getAuthSessionData()).toEqual(SESSION);
        expect(route.timeout).toHaveBeenCalledExactlyOnceWith(3000);
        expect(route.call).toHaveBeenCalledTimes(1);
    });

    it('G3 50, the backend does not answer in 50 ms: null, one warn naming the timeout, no generic error', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GUARD_TIMEOUT', '50');
        vi.useFakeTimers();
        const backend = silentBackend();
        const { getAuthSessionData } = await loadAuthUtilsOver(backend.fetch);
        const { warn, error } = await spyMiddlewareLog();

        const lookup = getAuthSessionData();
        await backend.reached;
        await vi.advanceTimersByTimeAsync(50);

        expect(await lookup).toBeNull();
        expect(warn).toHaveBeenCalledExactlyOnceWith('Auth session lookup timed out', { timeoutMs: 50 });
        expect(error).not.toHaveBeenCalled();
    });

    it('G4 unset, the backend rejects with a network error: null and the generic error line, as today', async () =>
    {
        const { getAuthSessionData } = await loadAuthUtilsOver(async () =>
        {
            throw new TypeError('fetch failed');
        });
        const { warn, error } = await spyMiddlewareLog();

        expect(await getAuthSessionData()).toBeNull();
        expect(error).toHaveBeenCalledExactlyOnceWith('Failed to get auth session', expect.objectContaining({
            error: expect.objectContaining({ name: 'ApiError', errorType: 'network' }),
        }));
        expect(warn).not.toHaveBeenCalled();
    });

    it('G5 3000, the backend answers the renewal-required refusal: RENEWAL_REQUIRED, as today', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GUARD_TIMEOUT', '3000');
        const route = stubRoute(async () => Promise.reject(new SessionRenewalRequiredError()));
        const { getAuthSessionData, RENEWAL_REQUIRED } = await loadAuthUtils(route);

        expect(await getAuthSessionData()).toBe(RENEWAL_REQUIRED);
        expect(route.timeout).toHaveBeenCalledExactlyOnceWith(3000);
    });

    it('G8 a malformed value at runtime: the read throws inside the catch, null, and an error line names the variable', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GUARD_TIMEOUT', 'abc');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const route = stubRoute(async () => SESSION);
        const { getAuthSessionData } = await loadAuthUtils(route);
        const { error } = await spyMiddlewareLog();

        expect(await getAuthSessionData()).toBeNull();
        expect(route.call).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledExactlyOnceWith('Failed to get auth session', expect.anything());
        expect(consoleError.mock.calls.flat().join('\n')).toContain('SPFN_AUTH_GUARD_TIMEOUT');
    });
});

describe('the SPFN_AUTH_GUARD_TIMEOUT schema entry', () =>
{
    const validator = authEnvSchema.SPFN_AUTH_GUARD_TIMEOUT.validator;

    it.each(['0', '-1', 'abc', '2147483648'])('G6 refuses %s', (value) =>
    {
        expect(() => validator(value)).toThrow();
    });

    it('G6 accepts 3000, as a number, and has no default', () =>
    {
        expect(validator('3000')).toBe(3000);
        expect('default' in authEnvSchema.SPFN_AUTH_GUARD_TIMEOUT).toBe(false);
    });
});

describe('every guard reaches the backend through getAuthSessionData', () =>
{
    const helpers: Array<[string, (utils: typeof import('../../nextjs/guards/auth-utils')) => Promise<unknown>]> = [
        ['getAuthSessionData', utils => utils.getAuthSessionData()],
        ['getUserRole', utils => utils.getUserRole()],
        ['getUserPermissions', utils => utils.getUserPermissions()],
        ['hasAnyRole', utils => utils.hasAnyRole(['admin'])],
        ['hasAnyPermission', utils => utils.hasAnyPermission(['user:read'])],
    ];

    it.each(helpers)('G7 %s makes one lookup, bounded by .timeout(3000)', async (_name, run) =>
    {
        vi.stubEnv('SPFN_AUTH_GUARD_TIMEOUT', '3000');
        const route = stubRoute(async () => SESSION);

        await run(await loadAuthUtils(route));

        expect(route.timeout).toHaveBeenCalledExactlyOnceWith(3000);
        expect(route.call).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['RequireAuth', '../../nextjs/guards/require-auth', 'RequireAuth', {}],
        ['RequireRole', '../../nextjs/guards/require-role', 'RequireRole', { roles: 'admin' }],
        ['RequirePermission', '../../nextjs/guards/require-permission', 'RequirePermission', { permissions: 'user:read' }],
    ])('G7 %s makes one lookup, bounded by .timeout(3000)', async (_name, path, exported, props) =>
    {
        vi.stubEnv('SPFN_AUTH_GUARD_TIMEOUT', '3000');
        const route = stubRoute(async () => SESSION);
        stubGuardRuntime(route);

        const guard = (await import(path))[exported];
        await guard({ children: null, ...props });

        expect(route.timeout).toHaveBeenCalledExactlyOnceWith(3000);
        expect(route.call).toHaveBeenCalledTimes(1);
    });

    it('G7 no file under nextjs/guards names getAuthSession but auth-utils', () =>
    {
        const dir = join(__dirname, '../../nextjs/guards');
        const naming = readdirSync(dir).filter(file => readFileSync(join(dir, file), 'utf8').includes('getAuthSession.'));

        expect(naming).toEqual(['auth-utils.ts']);
    });
});

interface StubRoute
{
    call: ReturnType<typeof vi.fn>;
    timeout: ReturnType<typeof vi.fn>;
}

/** A `getAuthSession` stand-in whose `.timeout()` hands back the same `call`. */
function stubRoute(answer: () => Promise<unknown>): StubRoute
{
    const call = vi.fn(answer);

    return { call, timeout: vi.fn(() => ({ call })) };
}

async function loadAuthUtils(route: StubRoute): Promise<typeof import('../../nextjs/guards/auth-utils')>
{
    vi.doMock('@spfn/auth', () => ({ authApi: { getAuthSession: route } }));

    return import('../../nextjs/guards/auth-utils');
}

/** auth-utils over the real client, whose every request goes to `fakeFetch`. */
async function loadAuthUtilsOver(fakeFetch: typeof fetch): Promise<typeof import('../../nextjs/guards/auth-utils')>
{
    vi.stubEnv('SPFN_APP_URL', 'http://app.test');
    vi.doMock('@spfn/auth', () => ({ authApi: createApi<any>({ fetch: fakeFetch }) }));

    return import('../../nextjs/guards/auth-utils');
}

/**
 * A backend that never answers; its request fails only when aborted. `reached`
 * settles once the client has sent it — after the client's timer is armed, so a
 * test advances the clock from there rather than before the call gets that far.
 */
function silentBackend(): { fetch: typeof fetch; reached: Promise<void> }
{
    let resolve: () => void = () => undefined;
    const reached = new Promise<void>(settle =>
    {
        resolve = settle;
    });

    const silentFetch = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    {
        resolve();

        return new Promise((_resolve, reject) =>
        {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
    };

    return { fetch: silentFetch, reached };
}

async function spyMiddlewareLog()
{
    const { authLogger } = await import('../../server/logger');

    return {
        warn: vi.spyOn(authLogger.middleware, 'warn').mockImplementation(() => undefined),
        error: vi.spyOn(authLogger.middleware, 'error').mockImplementation(() => undefined),
    };
}

/** What a guard needs besides the lookup: a signed-in cookie, a JSX runtime, `redirect`. */
function stubGuardRuntime(route: StubRoute): void
{
    // `react` is not a dependency of this package; the guards render their
    // children through this stub, which is all a passing guard does here.
    const runtime = { jsx: () => null, jsxs: () => null, jsxDEV: () => null, Fragment: Symbol('Fragment') };

    vi.doMock('react/jsx-dev-runtime', () => runtime);
    vi.doMock('react/jsx-runtime', () => runtime);
    vi.doMock('next/navigation', () => ({
        redirect: (path: string) =>
        {
            throw new Error(`redirected to ${path}`);
        },
    }));
    vi.doMock('../../nextjs/session-helpers', () => ({ getSession: async () => ({ userId: '7' }) }));
    vi.doMock('@spfn/auth', () => ({ authApi: { getAuthSession: route } }));
}
