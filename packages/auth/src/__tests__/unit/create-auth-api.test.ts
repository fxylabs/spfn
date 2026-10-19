/**
 * `createAuthApi(config)` — an app builds the auth client with its own configuration (fxylabs/spfn#148)
 *
 * `authApi` was one fixed client, so an app that keeps an app-wide status from its api
 * client never saw the auth routes' answers. The client is driven by a fake `fetch`: no
 * server, no network. Each `it` is one row of the case table:
 *
 * | #   | call                                                   | expected                                                               |
 * |-----|--------------------------------------------------------|------------------------------------------------------------------------|
 * | A1  | `createAuthApi()`                                      | same as `authApi`: an auth error body throws that auth error class    |
 * | A2  | `createAuthApi({ fetch })`                             | the request goes through the app's `fetch`                            |
 * | A3  | `createAuthApi({ onRequest, onResponse })`             | both called once for a call                                           |
 * | A4  | `createAuthApi({ timeout: 20, fetch: never-resolving })` | throws `ApiError` with errorType 'timeout'                          |
 * | A5  | `createAuthApi({ onOutcome })`                         | ok: true for a 200; ok: false, 'http' with the auth error instance    |
 * | A6  | `createAuthApi({ errorRegistry: [AppError] })`         | AppError body restores AppError; an auth error body the auth class    |
 * | A7  | app class with the same name as an auth error          | the auth class is restored                                            |
 * | A8  | core built-in (`NotFoundError` body)                   | restores NotFoundError                                                |
 * | A9  | type: `errorRegistry: someRegistryInstance`            | compile error (`@ts-expect-error`)                                    |
 * | A10 | type: `useMfaConfirm({ api: createAuthApi() })`, passkeys | compile                                                            |
 * | A11 | existing `authApi`                                     | existing tests unchanged and green (passkey-client, mfa-confirm-flow) |
 *
 * 🔗 src/index.ts (createAuthApi, AuthApiConfig)
 */

import { afterAll, describe, it, expect, expectTypeOf, vi } from 'vitest';
import { ErrorRegistry, NotFoundError, SerializableError } from '@spfn/core/errors';
import { ApiError } from '@spfn/core/nextjs';
import type { ApiOutcome } from '@spfn/core/nextjs';

import { authApi, createAuthApi } from '@/index';
import type { AuthApi } from '@/index';
import { InvalidCredentialsError } from '@/errors';
import type { enrollPasskey, renewSession, signInWithPasskey } from '@/client/passkeys';
import type { useMfaConfirm } from '@/nextjs/components/use-mfa-confirm';

/**
 * `createApi` reads the global fetch once, when a client is built, and `authApi` is built
 * on import — so the global is replaced before the imports run, and restored after.
 */
const { globalFetch, realFetch } = vi.hoisted(() =>
{
    const original = globalThis.fetch;
    const stand = vi.fn();
    globalThis.fetch = stand as unknown as typeof fetch;

    return { globalFetch: stand, realFetch: original };
});

afterAll(() =>
{
    globalThis.fetch = realFetch;
});

vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers({ host: 'app.test' }),
}));

class AppError extends SerializableError
{
    readonly statusCode = 409;

    constructor(data: { message?: string } = {})
    {
        super(data.message ?? 'app conflict');
        this.name = 'AppError';
    }
}

/**
 * An app class that claims the name of an auth error — as the name its instances carry, and
 * as its constructor name, which the registry keys by first. The constructor name is set
 * explicitly: the transform renames a class that clashes with an imported binding.
 */
class ImpostorCredentialsError extends SerializableError
{
    readonly statusCode = 401;

    constructor(data: { message?: string } = {})
    {
        super(data.message ?? 'impostor');
        this.name = 'InvalidCredentialsError';
    }
}

Object.defineProperty(ImpostorCredentialsError, 'name', { value: 'InvalidCredentialsError' });

const SESSION = { userId: '3', email: 'a@example.com' };
const AUTH_ERROR_BODY = { __type: 'InvalidCredentialsError', message: 'Invalid credentials' };

/** A fetch that answers every call with the given JSON body and status. */
function respondWith(body: unknown, status = 200)
{
    return vi.fn(async () => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    }));
}

/** A fetch that never answers, and rejects with its signal's reason once aborted, as real fetch does. */
function hangingFetch(): typeof fetch
{
    return ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) =>
    {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
}

/** Call one auth route on `api` and capture how it ended, so a rejection is never left unhandled. */
function settle(api: AuthApi): Promise<unknown>
{
    return api.getAuthSession.call({}).catch((error: unknown) => error);
}

describe('createAuthApi — the app\'s configuration reaches the auth client', () =>
{
    it('A1: createAuthApi() restores an auth error body as the auth class, as authApi does', async () =>
    {
        globalFetch.mockImplementation(respondWith(AUTH_ERROR_BODY, 401));

        expect(await settle(createAuthApi())).toBeInstanceOf(InvalidCredentialsError);
        expect(await settle(authApi)).toBeInstanceOf(InvalidCredentialsError);
        expect(globalFetch).toHaveBeenCalledTimes(2);
    });

    it('A2: the request goes through the app\'s fetch', async () =>
    {
        const appFetch = respondWith(SESSION);

        expect(await settle(createAuthApi({ fetch: appFetch as unknown as typeof fetch }))).toEqual(SESSION);
        expect(appFetch).toHaveBeenCalledTimes(1);
        expect(String((appFetch.mock.calls[0] as unknown[])[0])).toContain('getAuthSession');
    });

    it('A3: onRequest and onResponse are each called once for a call', async () =>
    {
        const onRequest = vi.fn((_url: string, init: RequestInit) => init);
        const onResponse = vi.fn((response: Response, body: unknown) => ({ response, body }));
        const api = createAuthApi({ fetch: respondWith(SESSION) as unknown as typeof fetch, onRequest, onResponse });

        expect(await settle(api)).toEqual(SESSION);
        expect(onRequest).toHaveBeenCalledTimes(1);
        expect(onResponse).toHaveBeenCalledTimes(1);
    });

    it('A4: the app\'s timeout ends a call that never answers with ApiError \'timeout\'', async () =>
    {
        const error = await settle(createAuthApi({ timeout: 20, fetch: hangingFetch() }));

        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).errorType).toBe('timeout');
    });

    it('A5: onOutcome observes the auth call\'s outcome — ok for a 200, the auth error instance for an error body', async () =>
    {
        const onOutcome = vi.fn<(outcome: ApiOutcome) => void>();

        await settle(createAuthApi({ fetch: respondWith(SESSION) as unknown as typeof fetch, onOutcome }));
        const thrown = await settle(createAuthApi({
            fetch: respondWith(AUTH_ERROR_BODY, 401) as unknown as typeof fetch,
            onOutcome,
        }));

        expect(onOutcome).toHaveBeenCalledTimes(2);
        expect(onOutcome.mock.calls[0][0]).toMatchObject({ ok: true, body: SESSION });
        expect(onOutcome.mock.calls[1][0]).toMatchObject({ ok: false, errorType: 'http', status: 401 });
        expect((onOutcome.mock.calls[1][0] as { error: Error }).error).toBe(thrown);
        expect(thrown).toBeInstanceOf(InvalidCredentialsError);
    });
});

describe('createAuthApi — error registry', () =>
{
    it('A6: an app class in errorRegistry is restored, and auth errors still are', async () =>
    {
        const appBody = { __type: 'AppError', message: 'app conflict' };

        expect(await settle(createAuthApi({
            fetch: respondWith(appBody, 409) as unknown as typeof fetch,
            errorRegistry: [AppError],
        }))).toBeInstanceOf(AppError);
        expect(await settle(createAuthApi({
            fetch: respondWith(AUTH_ERROR_BODY, 401) as unknown as typeof fetch,
            errorRegistry: [AppError],
        }))).toBeInstanceOf(InvalidCredentialsError);
    });

    it('A7: an app class named like an auth error does not shadow the auth class', async () =>
    {
        const error = await settle(createAuthApi({
            fetch: respondWith(AUTH_ERROR_BODY, 401) as unknown as typeof fetch,
            errorRegistry: [ImpostorCredentialsError],
        }));

        expect(error).toBeInstanceOf(InvalidCredentialsError);
        expect(error).not.toBeInstanceOf(ImpostorCredentialsError);
    });

    it('A8: a core built-in body is restored as the core class', async () =>
    {
        const error = await settle(createAuthApi({
            fetch: respondWith({ __type: 'NotFoundError', message: 'gone' }, 404) as unknown as typeof fetch,
            errorRegistry: [AppError],
        }));

        expect(error).toBeInstanceOf(NotFoundError);
    });
});

describe('createAuthApi — types', () =>
{
    it('A9: a bare ErrorRegistry instance is a compile error — only an array is merged with core\'s', () =>
    {
        // @ts-expect-error errorRegistry takes an array; a bare instance would replace core's registry
        expectTypeOf(createAuthApi).toBeCallableWith({ errorRegistry: new ErrorRegistry() });
        expectTypeOf(createAuthApi).toBeCallableWith({ errorRegistry: [new ErrorRegistry()] });
    });

    it('A10: useMfaConfirm and the passkey helpers take a client built by createAuthApi', () =>
    {
        type MfaConfirmApi = NonNullable<Parameters<typeof useMfaConfirm>[0]>['api'];

        expectTypeOf(createAuthApi()).toEqualTypeOf<typeof authApi>();
        expectTypeOf(createAuthApi()).toMatchTypeOf<MfaConfirmApi>();
        expectTypeOf(createAuthApi()).toMatchTypeOf<Parameters<typeof enrollPasskey>[0]>();
        expectTypeOf(createAuthApi()).toMatchTypeOf<Parameters<typeof signInWithPasskey>[0]>();
        expectTypeOf(createAuthApi()).toMatchTypeOf<Parameters<typeof renewSession>[0]>();
    });
});
