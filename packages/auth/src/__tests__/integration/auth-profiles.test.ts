/**
 * The authenticate/optionalAuth profile branch (case-table G) and the replay
 * ledger through the middleware (case-table H3/H4/H6, plus I3).
 *
 * Cell ↔ test mapping is in each test name. The middleware is driven the same
 * way authenticate.test.ts drives it: the '@spfn/auth/server' barrel is mocked
 * for the repositories, and real proofs are signed with the frozen test
 * keypairs — the ECDSA verification, canonical-body and admission-order code
 * paths all run for real.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import {
    decodeToken,
    verifyClientToken,
    keysRepository,
    findUserWithEffectiveRole,
    getPendingDeletionInfo,
} from '@spfn/auth/server';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';
import { encodeCanonicalJson, type CanonicalValue } from '@/server/client-proof/canonical-json';
import { ABSENT_BODY_SHA256, sha256Hex, signClientProof } from '@/server/client-proof/proof';
import {
    MemoryReplayStore,
    configureClientProofReplayStore,
    type ClientProofReplayStore,
} from '@/server/client-proof/replay-store';
import {
    TEST_KEY_ID,
    TEST_PRIVATE_KEY_PKCS8_B64,
    TEST_PUBLIC_KEY_SPKI_B64,
} from '@/server/client-proof/__tests__/test-keys';
import type { Context, Next } from 'hono';

const USER_ID = 7;

/**
 * On the REST surface clientId identifies the key owner (G9), so the default
 * test clientId is the owner id of the mocked key record.
 */
const OWNER_CLIENT_ID = String(USER_ID);

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

/** Headers carrying a real clientProofV1 proof over the given request shape. */
function proofHeaders(options: {
    method?: string;
    path?: string;
    body?: Uint8Array;
    clientId?: string;
    keyId?: string;
    nonce?: string;
    issuedAtMillis?: bigint;
    privateKey?: string;
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
        options.privateKey ?? TEST_PRIVATE_KEY_PKCS8_B64,
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

/**
 * What the middleware answered with: null when it passed the request on, the
 * contract refusal response, or the error it threw.
 *
 * A contract refusal is a response rather than a throw — a proven call is
 * answered with the contract's own envelope, never with an error classified by
 * its wrapper class name (#106). Everything else still leaves as a throw.
 */
async function run(middleware: Middleware, driven: DrivenContext): Promise<unknown>
{
    return middleware.handler(driven.c, driven.next).then((res) => res ?? null, (error: unknown) => error);
}

/** The contract code the answer carries, whichever way it came back. */
async function refusalCodeOf(answer: unknown): Promise<string | undefined>
{
    if (answer instanceof Response)
    {
        const body = await answer.clone().json() as { error?: { code?: string } };

        return body.error?.code;
    }

    return (answer as { details?: { code?: string } } | null)?.details?.code;
}

/** The refusal body with the one field that differs per request removed. */
async function envelopeWithoutRequestId(response: Response): Promise<unknown>
{
    const body = await response.clone().json() as { error: Record<string, unknown> };
    const { requestId: _requestId, ...error } = body.error;

    return { ...body, error };
}

async function expectRefusal(answer: unknown, statusCode: number, code?: string): Promise<void>
{
    expect(answer, 'expected the middleware to refuse').not.toBeNull();
    const status = answer instanceof Response
        ? answer.status
        : (answer as { statusCode?: number }).statusCode;
    expect(status).toBe(statusCode);
    if (code !== undefined)
    {
        expect(await refusalCodeOf(answer)).toBe(code);
    }
}

const EACH_MIDDLEWARE: [string, Middleware][] = [
    ['authenticate', authenticate],
    ['optionalAuth', optionalAuth],
];

describe('auth profile branch (case table G)', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        configureClientProofReplayStore(new MemoryReplayStore());
        vi.mocked(keysRepository.updateLastUsedById).mockResolvedValue(undefined as never);
        vi.mocked(keysRepository.findByKeyId).mockResolvedValue(validKeyRecord() as never);
        vi.mocked(findUserWithEffectiveRole).mockResolvedValue(activeUser() as never);
    });

    describe('G1 — Bearer only: the web path, untouched', () =>
    {
        it('G1 authenticate: a valid Bearer token authenticates with scheme bearer', async () =>
        {
            vi.mocked(decodeToken).mockReturnValue({ keyId: TEST_KEY_ID } as never);
            vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(validKeyRecord() as never);
            vi.mocked(verifyClientToken).mockReturnValue({ keyId: TEST_KEY_ID } as never);

            const driven = contextFor({ headers: { Authorization: 'Bearer valid-token' } });
            expect(await run(authenticate, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
            expect(driven.authOf()).toMatchObject({ userId: String(USER_ID), scheme: 'bearer' });
            expect(keysRepository.findByKeyId).not.toHaveBeenCalled();
        });

        it('G1 optionalAuth: a valid Bearer token authenticates with scheme bearer', async () =>
        {
            vi.mocked(decodeToken).mockReturnValue({ keyId: TEST_KEY_ID } as never);
            vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(validKeyRecord() as never);
            vi.mocked(verifyClientToken).mockReturnValue({ keyId: TEST_KEY_ID } as never);

            const driven = contextFor({ headers: { Authorization: 'Bearer valid-token' } });
            expect(await run(optionalAuth, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
            expect(driven.authOf()).toMatchObject({ userId: String(USER_ID), scheme: 'bearer' });
        });
    });

    describe.each(EACH_MIDDLEWARE)('G2 — profile header + valid proof (%s)', (_name, middleware) =>
    {
        it('admits and converges on the Principal shape', async () =>
        {
            const driven = contextFor({ headers: proofHeaders() });
            expect(await run(middleware, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
            expect(driven.authOf()).toMatchObject({
                userId: String(USER_ID),
                keyId: TEST_KEY_ID,
                role: 'user',
                locale: 'en',
                scheme: 'clientProofV1',
            });
        });

        it('admits a canonical JSON body and binds it into the proof', async () =>
        {
            const body = encodeCanonicalJson(new Map<string, CanonicalValue>([['message', 'hi'], ['sequence', 1n]]));
            const driven = contextFor({ body, headers: proofHeaders({ body }) });
            expect(await run(middleware, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
        });
    });

    describe.each(EACH_MIDDLEWARE)('G3/G3\' — profile header + invalid proof is 401, never anonymous (%s)', (_name, middleware) =>
    {
        it('refuses a tampered proof with PROOF_INVALID', async () =>
        {
            const driven = contextFor({ headers: proofHeaders({ tamper: true }) });
            await expectRefusal(await run(middleware, driven), 401, 'PROOF_INVALID');
            expect(driven.next).not.toHaveBeenCalled();
            expect(driven.authOf()).toBeUndefined();
        });

        it('refuses a proof over different bytes than the body sent', async () =>
        {
            const signedBody = encodeCanonicalJson(new Map<string, CanonicalValue>([['a', 1n]]));
            const sentBody = encodeCanonicalJson(new Map<string, CanonicalValue>([['a', 2n]]));
            const driven = contextFor({ body: sentBody, headers: proofHeaders({ body: signedBody }) });
            await expectRefusal(await run(middleware, driven), 401, 'PROOF_INVALID');
            expect(driven.next).not.toHaveBeenCalled();
        });
    });

    describe.each(EACH_MIDDLEWARE)('G4 — unknown profile value (%s)', (_name, middleware) =>
    {
        it('rejects immediately with PROFILE_REJECTED (unknownProfilePolicy: reject)', async () =>
        {
            const driven = contextFor({ headers: proofHeaders({ profile: 'someFutureProfile' }) });
            await expectRefusal(await run(middleware, driven), 400, 'PROFILE_REJECTED');
            expect(driven.next).not.toHaveBeenCalled();
            expect(keysRepository.findByKeyId).not.toHaveBeenCalled();
        });
    });

    describe.each(EACH_MIDDLEWARE)('G5 — profile header and Bearer together (%s)', (_name, middleware) =>
    {
        it('rejects the mixture without running either path', async () =>
        {
            const driven = contextFor({
                headers: { ...proofHeaders(), Authorization: 'Bearer also-present' },
            });
            await expectRefusal(await run(middleware, driven), 400, 'PROFILE_REJECTED');
            expect(driven.next).not.toHaveBeenCalled();
            expect(keysRepository.findByKeyId).not.toHaveBeenCalled();
            expect(keysRepository.findActiveByKeyId).not.toHaveBeenCalled();
        });
    });

    describe('G6 — neither profile nor Bearer', () =>
    {
        it('G6 authenticate: 401', async () =>
        {
            const driven = contextFor();
            await expectRefusal(await run(authenticate, driven), 401);
            expect(driven.next).not.toHaveBeenCalled();
        });

        it('G6 optionalAuth: anonymous passage without an auth context', async () =>
        {
            const driven = contextFor();
            expect(await run(optionalAuth, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
            expect(driven.authOf()).toBeUndefined();
        });

        // I3 — a proven-surface call presented with no credentials at all is
        // refused exactly as before this change.
        it('I3: an unproven call to a proof-requiring surface is refused', async () =>
        {
            const driven = contextFor({ path: '/_auth/keys/rotate' });
            await expectRefusal(await run(authenticate, driven), 401);
            expect(driven.next).not.toHaveBeenCalled();
        });
    });

    describe.each(EACH_MIDDLEWARE)('G7 — revoked or expired keys, non-disclosing (%s)', (_name, middleware) =>
    {
        it('a revoked key answers SESSION_REVOKED before the proof is examined', async () =>
        {
            vi.mocked(keysRepository.findByKeyId).mockResolvedValue(
                validKeyRecord({ isActive: false }) as never,
            );
            const driven = contextFor({ headers: proofHeaders() });
            await expectRefusal(await run(middleware, driven), 401, 'SESSION_REVOKED');
            expect(driven.next).not.toHaveBeenCalled();
        });

        it('an expired key answers SESSION_REVOKED at the same revocation step', async () =>
        {
            const past = new Date();
            past.setDate(past.getDate() - 1);
            vi.mocked(keysRepository.findByKeyId).mockResolvedValue(
                validKeyRecord({ expiresAt: past }) as never,
            );
            const driven = contextFor({ headers: proofHeaders() });
            await expectRefusal(await run(middleware, driven), 401, 'SESSION_REVOKED');
        });

        it('an unregistered keyId shares PROOF_INVALID with a bad signature (non-disclosure)', async () =>
        {
            vi.mocked(keysRepository.findByKeyId).mockResolvedValue(null as never);
            const driven = contextFor({ headers: proofHeaders({ keyId: 'key-never-registered' }) });
            await expectRefusal(await run(middleware, driven), 401, 'PROOF_INVALID');
        });
    });

    describe.each(EACH_MIDDLEWARE)('G9 — clientId must be the key owner (%s)', (_name, middleware) =>
    {
        it("a valid signature over someone else's key is PROOF_INVALID", async () =>
        {
            // User B (id 8) owns the key; the proof is validly signed with
            // B's private key, but presented under user A's clientId ('7').
            vi.mocked(keysRepository.findByKeyId).mockResolvedValue(
                validKeyRecord({ userId: 8 }) as never,
            );
            const driven = contextFor({ headers: proofHeaders({ clientId: OWNER_CLIENT_ID }) });
            await expectRefusal(await run(middleware, driven), 401, 'PROOF_INVALID');
            expect(driven.next).not.toHaveBeenCalled();
            expect(driven.authOf()).toBeUndefined();
        });

        it('the ownership refusal is byte-identical to the unregistered-key refusal (no key existence leak)', async () =>
        {
            vi.mocked(keysRepository.findByKeyId).mockResolvedValue(
                validKeyRecord({ userId: 8 }) as never,
            );
            const mismatch = await run(middleware, contextFor({ headers: proofHeaders() })) as Response;

            vi.mocked(keysRepository.findByKeyId).mockResolvedValue(null as never);
            const unregistered = await run(middleware, contextFor({ headers: proofHeaders() })) as Response;

            expect(mismatch.status).toBe(unregistered.status);
            // The envelopes differ in requestId alone — nothing else in either
            // body can be read back as whether the key exists.
            expect(await envelopeWithoutRequestId(mismatch)).toEqual(await envelopeWithoutRequestId(unregistered));
        });

        it('exact string match only: no normalization of the owner id', async () =>
        {
            // ' 7' (padded) is not '7' — the comparison must not trim or coerce.
            const driven = contextFor({ headers: proofHeaders({ clientId: ` ${OWNER_CLIENT_ID}` }) });
            await expectRefusal(await run(middleware, driven), 401, 'PROOF_INVALID');
        });
    });

    describe('G8 — user status runs the same downstream path as the web scheme', () =>
    {
        it('an inactive account is refused as AccountDisabledError', async () =>
        {
            vi.mocked(findUserWithEffectiveRole).mockResolvedValue(
                activeUser({ status: 'inactive' }) as never,
            );
            const driven = contextFor({ headers: proofHeaders() });
            const error = await run(authenticate, driven) as { name: string };
            expect(error.name).toBe('AccountDisabledError');
            expect(driven.next).not.toHaveBeenCalled();
        });

        it('a pending_deletion account carries purgeScheduledAt, as on the web path', async () =>
        {
            vi.mocked(findUserWithEffectiveRole).mockResolvedValue(
                activeUser({ status: 'pending_deletion' }) as never,
            );
            const purgeScheduledAt = new Date('2030-01-01T00:00:00.000Z');
            vi.mocked(getPendingDeletionInfo).mockResolvedValue({ purgeScheduledAt } as never);

            const driven = contextFor({ headers: proofHeaders() });
            const error = await run(authenticate, driven) as { name: string; details: Record<string, unknown> };
            expect(error.name).toBe('AccountPendingDeletionError');
            expect(error.details).toMatchObject({ purgeScheduledAt: purgeScheduledAt.toISOString() });
        });
    });

    describe('downstream invariant — nothing outside the middleware branches on scheme', () =>
    {
        it('no server module outside the scheme-setting middlewares mentions the scheme field', () =>
        {
            const root = join(__dirname, '..', '..', 'server');
            const offenders: string[] = [];
            // The middlewares that *authenticate* set the field; nothing else
            // may even mention it — consuming code takes the Principal as one
            // shape and never branches on how it was produced.
            const excluded = [
                join('middleware', 'auth-profiles.ts'),
                join('middleware', 'authenticate.ts'),
                join('middleware', 'one-time-token-auth.ts'),
                // machine-principals sets the field on its own principal — the
                // one that never enters AuthContext (#79). It is a
                // scheme-setting middleware in exactly the sense this list
                // means, and it branches on the field no more than the others.
                join('middleware', 'machine-principals.ts'),
            ];

            const walk = (dir: string): void =>
            {
                for (const entry of readdirSync(dir))
                {
                    const full = join(dir, entry);
                    if (statSync(full).isDirectory())
                    {
                        if (entry !== '__tests__')
                        {
                            walk(full);
                        }
                        continue;
                    }
                    if (!entry.endsWith('.ts') || excluded.some((path) => full.endsWith(path)))
                    {
                        continue;
                    }
                    if (/\bscheme\b/.test(readFileSync(full, 'utf8')))
                    {
                        offenders.push(full);
                    }
                }
            };
            walk(root);

            expect(offenders).toEqual([]);
        });
    });
});

describe('replay ledger through the middleware (case table H)', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        configureClientProofReplayStore(new MemoryReplayStore());
        vi.mocked(keysRepository.updateLastUsedById).mockResolvedValue(undefined as never);
        vi.mocked(keysRepository.findByKeyId).mockResolvedValue(validKeyRecord() as never);
        vi.mocked(findUserWithEffectiveRole).mockResolvedValue(activeUser() as never);
    });

    it('H1/H2: a nonce is admitted once, and its reuse is PROOF_REPLAYED', async () =>
    {
        const nonce = 'nonce-h1-h2';
        const first = contextFor({ headers: proofHeaders({ nonce }) });
        expect(await run(authenticate, first)).toBeNull();

        const replayed = contextFor({ headers: proofHeaders({ nonce }) });
        await expectRefusal(await run(authenticate, replayed), 401, 'PROOF_REPLAYED');
        expect(replayed.next).not.toHaveBeenCalled();
    });

    it('H3: a failing store refuses the request (fail-closed) instead of admitting', async () =>
    {
        const downStore: ClientProofReplayStore = {
            isSpent: async () =>
            {
                throw new Error('connection refused');
            },
            spend: async () =>
            {
                throw new Error('connection refused');
            },
        };
        configureClientProofReplayStore(downStore);

        const driven = contextFor({ headers: proofHeaders() });
        await expectRefusal(await run(authenticate, driven), 503);
        expect(driven.next).not.toHaveBeenCalled();
    });

    it('H2 (race): losing the check-and-set on spend is PROOF_REPLAYED, not a second acceptance', async () =>
    {
        // A store where the pair looks unspent at the replay check but another
        // request wins the spend — the interleaving two concurrent same-nonce
        // requests can produce.
        configureClientProofReplayStore({
            isSpent: async () => false,
            spend: async () => false,
        });

        const driven = contextFor({ headers: proofHeaders() });
        await expectRefusal(await run(authenticate, driven), 401, 'PROOF_REPLAYED');
        expect(driven.next).not.toHaveBeenCalled();
    });

    it('H4: a refused request does not spend its nonce — the same nonce then succeeds', async () =>
    {
        const nonce = 'nonce-h4';
        const refused = contextFor({ headers: proofHeaders({ nonce, tamper: true }) });
        await expectRefusal(await run(authenticate, refused), 401, 'PROOF_INVALID');

        const retried = contextFor({ headers: proofHeaders({ nonce }) });
        expect(await run(authenticate, retried)).toBeNull();
        expect(retried.next).toHaveBeenCalled();
    });

    it('H6: a proof outside the window is PROOF_EXPIRED at the expiry step, ledger untouched', async () =>
    {
        const nonce = 'nonce-h6';
        const stale = contextFor({
            headers: proofHeaders({ nonce, issuedAtMillis: BigInt(Date.now()) - 300_001n }),
        });
        await expectRefusal(await run(authenticate, stale), 401, 'PROOF_EXPIRED');

        // The expired refusal spent nothing: the nonce is admissible when fresh.
        const fresh = contextFor({ headers: proofHeaders({ nonce }) });
        expect(await run(authenticate, fresh)).toBeNull();
    });
});
