/**
 * What a refused proven call reads off the wire (#106).
 *
 * A generated SDK classifies a failure by `error.code` and refuses a code it
 * does not know, so every refusal the profile middleware emits must carry one
 * of the six contract codes there — not the name of whatever error class
 * carried it out of the verifier. One case per code, driven through the real
 * middleware, plus the two rules the same envelope has to keep: the body is the
 * canonical form of the contract shape and nothing else, and an error that is
 * not a contract refusal is left alone for the error handler.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@spfn/auth/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/auth/server')>();

    return {
        ...actual,
        decodeToken: vi.fn(),
        verifyClientToken: vi.fn(),
        keysRepository: {
            findActiveByKeyId: vi.fn(),
            findByKeyId: vi.fn(),
            updateLastUsedById: vi.fn().mockResolvedValue(undefined),
        },
        findUserWithEffectiveRole: vi.fn(),
        userProfilesRepository: { findLocaleByUserId: vi.fn().mockResolvedValue('en') },
        getPendingDeletionInfo: vi.fn(),
    };
});

import { Hono } from 'hono';
import { ErrorHandler } from '@spfn/core/middleware';
import { ValidationError } from '@spfn/core/errors';

import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import { selectAuthProfile } from '@/server/middleware/auth-profiles';
import { keysRepository, findUserWithEffectiveRole } from '@spfn/auth/server';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';
import { encodeCanonicalJson, parseCanonicalJson } from '@/server/client-proof/canonical-json';
import { ABSENT_BODY_SHA256, sha256Hex, signClientProof } from '@/server/client-proof/proof';
import {
    CLIENT_PROOF_ERROR_CODES,
    HTTP_STATUS,
    type ClientProofErrorCode,
} from '@/server/client-proof/refusal';
import { MemoryReplayStore, configureClientProofReplayStore } from '@/server/client-proof/replay-store';
import { SERVER_CONTRACT_HEADERS } from '@/server/client-proof/wire-headers';
import {
    TEST_KEY_ID,
    TEST_PRIVATE_KEY_PKCS8_B64,
    TEST_PUBLIC_KEY_SPKI_B64,
} from '@/server/client-proof/__tests__/test-keys';
import type { Context, Next } from 'hono';

const USER_ID = 7;
const OWNER_CLIENT_ID = String(USER_ID);
const REPLAY_WINDOW_MILLIS = 300_000;

function validKeyRecord(overrides: Record<string, unknown> = {})
{
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 90);

    return {
        id: 1,
        keyId: TEST_KEY_ID,
        userId: USER_ID,
        publicKey: TEST_PUBLIC_KEY_SPKI_B64,
        algorithm: 'ES256',
        isActive: true,
        expiresAt: futureDate,
        ...overrides,
    };
}

function activeUser(overrides: Record<string, unknown> = {})
{
    return {
        user: { id: USER_ID, email: 'proof@example.com', status: 'active', ...overrides },
        role: { name: 'user' },
    };
}

interface DrivenContext
{
    c: Context;
    next: Next;
    authOf: () => Record<string, unknown> | undefined;
}

/**
 * The middleware runs against a hand-built context, as the profile case-table
 * suite does. `newResponse` is the one piece a refusal needs beyond it.
 */
function contextFor(options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
} = {}): DrivenContext
{
    const method = options.method ?? 'POST';
    const path = options.path ?? '/v1/protected';
    const headers = new Headers(options.headers ?? {});
    const body = options.body ?? new Uint8Array(0);
    const vars = new Map<string, unknown>();
    const next = vi.fn(async () => undefined);

    const c = {
        req: {
            method,
            path,
            raw: { headers },
            header: (name?: string) =>
            {
                if (name === undefined)
                {
                    return Object.fromEntries(headers.entries());
                }

                return headers.get(name) ?? undefined;
            },
            arrayBuffer: async () => body.slice().buffer,
        },
        set: (key: string, value: unknown) => vars.set(key, value),
        get: (key: string) => vars.get(key),
        newResponse: (responseBody: BodyInit, status: number, responseHeaders: Record<string, string>) =>
            new Response(responseBody, { status, headers: responseHeaders }),
    } as unknown as Context;

    return { c, next, authOf: () => vars.get('auth') as Record<string, unknown> | undefined };
}

function proofHeaders(options: {
    method?: string;
    path?: string;
    body?: Uint8Array;
    clientId?: string;
    keyId?: string;
    nonce?: string;
    issuedAtMillis?: bigint;
    profile?: string;
    tamper?: boolean;
    extra?: Record<string, string>;
} = {}): Record<string, string>
{
    const method = options.method ?? 'POST';
    const path = options.path ?? '/v1/protected';
    const clientId = options.clientId ?? OWNER_CLIENT_ID;
    const keyId = options.keyId ?? TEST_KEY_ID;
    const nonce = options.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`;
    const issuedAtMillis = options.issuedAtMillis ?? BigInt(Date.now());
    const bodySha256 = options.body === undefined || options.body.length === 0
        ? ABSENT_BODY_SHA256
        : sha256Hex(options.body);

    let proof = signClientProof(
        { method, path, clientId, keyId, nonce, issuedAtMillis, bodySha256 },
        TEST_PRIVATE_KEY_PKCS8_B64,
    );
    if (options.tamper)
    {
        proof = `${proof.slice(0, -1)}${proof.endsWith('0') ? '1' : '0'}`;
    }

    const headers: Record<string, string> = {
        [CLIENT_PROOF_HEADERS.profile]: options.profile ?? 'clientProofV1',
        [CLIENT_PROOF_HEADERS.clientId]: clientId,
        [CLIENT_PROOF_HEADERS.keyId]: keyId,
        [CLIENT_PROOF_HEADERS.nonce]: nonce,
        [CLIENT_PROOF_HEADERS.issuedAtMillis]: issuedAtMillis.toString(),
        [CLIENT_PROOF_HEADERS.proof]: proof,
        ...options.extra,
    };
    if (options.body !== undefined && options.body.length > 0)
    {
        headers['content-type'] = 'application/json';
    }

    return headers;
}

type Middleware = typeof authenticate | typeof optionalAuth;

/** Runs the middleware and returns what it answered with, refusal or throw. */
async function answer(middleware: Middleware, driven: DrivenContext): Promise<Response>
{
    const result = await middleware.handler(driven.c, driven.next);
    expect(result, 'expected the middleware to answer with a refusal response').toBeInstanceOf(Response);

    return result as Response;
}

/**
 * One request per refusal code, each reaching its code through the real
 * admission path rather than by construction.
 */
const SCENARIOS: Record<ClientProofErrorCode, (middleware: Middleware) => Promise<Response>> = {
    PROOF_INVALID: (middleware) =>
        answer(middleware, contextFor({ headers: proofHeaders({ tamper: true }) })),

    PROOF_REPLAYED: async (middleware) =>
    {
        const nonce = 'nonce-replayed';
        await middleware.handler(contextFor({ headers: proofHeaders({ nonce }) }).c, vi.fn(async () => undefined));

        return answer(middleware, contextFor({ headers: proofHeaders({ nonce }) }));
    },

    PROOF_EXPIRED: (middleware) =>
        answer(middleware, contextFor({
            headers: proofHeaders({ issuedAtMillis: BigInt(Date.now()) - BigInt(REPLAY_WINDOW_MILLIS + 1) }),
        })),

    SESSION_REVOKED: (middleware) =>
    {
        vi.mocked(keysRepository.findByKeyId).mockResolvedValue(validKeyRecord({ isActive: false }) as never);

        return answer(middleware, contextFor({ headers: proofHeaders() }));
    },

    PROFILE_REJECTED: (middleware) =>
        answer(middleware, contextFor({ headers: proofHeaders({ profile: 'someFutureProfile' }) })),

    CONTRACT_UNSUPPORTED: (middleware) =>
        answer(middleware, contextFor({
            headers: proofHeaders({ extra: { [CLIENT_PROOF_HEADERS.session]: 'session-does-not-belong-here' } }),
        })),
};

interface ParsedEnvelope
{
    body: Record<string, unknown>;
    error: Record<string, unknown>;
    bytes: Uint8Array;
}

async function readEnvelope(response: Response): Promise<ParsedEnvelope>
{
    const bytes = new Uint8Array(await response.arrayBuffer());
    const body = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;

    return { body, error: body.error as Record<string, unknown>, bytes };
}

const EACH_MIDDLEWARE: [string, Middleware][] = [
    ['authenticate', authenticate],
    ['optionalAuth', optionalAuth],
];

describe.each(EACH_MIDDLEWARE)('clientProofV1 refusal envelope (%s)', (_name, middleware) =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        configureClientProofReplayStore(new MemoryReplayStore());
        vi.mocked(keysRepository.updateLastUsedById).mockResolvedValue(undefined as never);
        vi.mocked(keysRepository.findByKeyId).mockResolvedValue(validKeyRecord() as never);
        vi.mocked(findUserWithEffectiveRole).mockResolvedValue(activeUser() as never);
    });

    it.each(CLIENT_PROOF_ERROR_CODES.map((code) => [code] as const))(
        'error.code is %s — the contract code, never the wrapper class name',
        async (code) =>
        {
            const response = await SCENARIOS[code](middleware);
            const { error } = await readEnvelope(response);

            expect(error.code).toBe(code);
            expect(response.status).toBe(HTTP_STATUS[code]);
        },
    );

    it.each(CLIENT_PROOF_ERROR_CODES.map((code) => [code] as const))(
        'the %s body is the contract envelope and nothing else',
        async (code) =>
        {
            const response = await SCENARIOS[code](middleware);
            const { body, error, bytes } = await readEnvelope(response);

            // Only the envelope: no __type, no error-class fields, no details.
            expect(Object.keys(body)).toEqual(['error']);
            expect(Object.keys(error).sort()).toEqual(['code', 'message', 'requestId']);
            expect(error.requestId).toMatch(/^[0-9a-f]{32}$/);
            expect(typeof error.message).toBe('string');

            // Byte-canonical: the bytes are the canonical form of what they encode.
            expect(Buffer.from(encodeCanonicalJson(parseCanonicalJson(bytes)))).toEqual(Buffer.from(bytes));

            expect(response.headers.get('content-type')).toBe('application/json');
            expect(response.headers.get(SERVER_CONTRACT_HEADERS.version)).not.toBeNull();
        },
    );

    it('a refusal never reaches the route and never leaves an auth context', async () =>
    {
        const driven = contextFor({ headers: proofHeaders({ tamper: true }) });
        await answer(middleware, driven);

        expect(driven.next).not.toHaveBeenCalled();
        expect(driven.authOf()).toBeUndefined();
    });

    it('mixing a profile with Bearer credentials is refused as PROFILE_REJECTED', async () =>
    {
        const driven = contextFor({
            headers: { ...proofHeaders(), Authorization: 'Bearer also-present' },
        });
        const { error } = await readEnvelope(await answer(middleware, driven));

        expect(error.code).toBe('PROFILE_REJECTED');
        expect(driven.next).not.toHaveBeenCalled();
    });

    it('an error that is not a contract refusal still throws for the error handler', async () =>
    {
        // The user-status path runs after admission and is not part of the
        // contract's refusal vocabulary — it must keep its own error class.
        vi.mocked(findUserWithEffectiveRole).mockResolvedValue(
            activeUser({ status: 'inactive' }) as never,
        );

        const driven = contextFor({ headers: proofHeaders() });
        const thrown = await middleware.handler(driven.c, driven.next).then(() => null, (err: unknown) => err);

        expect((thrown as Error | null)?.name).toBe('AccountDisabledError');
    });
});

/** What `run` threw, or null when it returned. */
function thrownBy(run: () => unknown): unknown
{
    try
    {
        run();
    }
    catch (err)
    {
        return err;
    }

    return null;
}

/**
 * `selectAuthProfile` is exported, so a caller can drive the dispatch itself
 * and let the refusal escape as a throw. Even then the contract code is what
 * classifies the failure — the error handler mints `error.code` from `__type`.
 */
describe('a refusal that escapes the middleware', () =>
{
    it('serializes with the contract code, not the carrying class name', () =>
    {
        const driven = contextFor({
            headers: { ...proofHeaders(), Authorization: 'Bearer also-present' },
        });
        const thrown = thrownBy(() => selectAuthProfile(driven.c)) as
            { statusCode: number; toJSON: () => Record<string, unknown> } | null;

        expect(thrown).not.toBeNull();
        expect(thrown!.statusCode).toBe(400);
        expect(thrown!.toJSON()).toEqual({
            __type: 'PROFILE_REJECTED',
            message: expect.any(String),
        });
    });
});

/**
 * The same thing through a real server: a hand-built context proves the
 * middleware's own answer, and this proves the answer survives the stack that
 * produced the wrong code in the first place — the generic error handler, which
 * mints `error.code` from the error class's name.
 */
describe('a refused proven call through the whole server stack', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        configureClientProofReplayStore(new MemoryReplayStore());
        vi.mocked(keysRepository.updateLastUsedById).mockResolvedValue(undefined as never);
        vi.mocked(keysRepository.findByKeyId).mockResolvedValue(validKeyRecord() as never);
        vi.mocked(findUserWithEffectiveRole).mockResolvedValue(activeUser() as never);
    });

    function appWithAuth(): Hono
    {
        const app = new Hono();
        app.onError(ErrorHandler({ enableLogging: false }));
        app.use('*', authenticate.handler);
        app.post('/v1/protected', (c) => c.json({ ok: true }));

        return app;
    }

    it('answers PROOF_INVALID with the contract envelope, not the wrapper class name', async () =>
    {
        const response = await appWithAuth().request('/v1/protected', {
            method: 'POST',
            headers: proofHeaders({ tamper: true }),
        });
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(401);
        expect((body.error as Record<string, unknown>).code).toBe('PROOF_INVALID');
        expect(body).not.toHaveProperty('__type');
    });

    it('leaves a REST-surface error to the error handler, class name and all', async () =>
    {
        const app = new Hono();
        app.onError(ErrorHandler({ enableLogging: false }));
        app.post('/v1/rest', () =>
        {
            throw new ValidationError({ message: 'nope' });
        });

        const response = await app.request('/v1/rest', { method: 'POST' });
        const body = await response.json() as Record<string, unknown>;

        expect(body.__type).toBe('ValidationError');
        expect((body.error as Record<string, unknown>).code).toBe('ValidationError');
    });
});
