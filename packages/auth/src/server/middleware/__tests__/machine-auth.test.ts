/**
 * The machine-principal case table (#79), asserted cell by cell.
 *
 * | credential ↓ route →     | authenticate | machineAuth | optionalAuth |
 * |--------------------------|--------------|-------------|--------------|
 * | user bearer JWT          | A1 ✓ user    | A2 401      | A3 ✓ user    |
 * | machine, registered      | B1 401       | B2 ✓        | B3 401       |
 * | machine, verifier reject | C1 401       | C2 401      | C3 401       |
 * | machine-shaped, unknown  | D1 401       | D2 401      | D3 401       |
 * | profile header + Bearer  | E1 mixed     | E2 mixed    | E3 mixed     |
 * | nothing                  | F1 401       | F2 401      | F3 continues |
 * | principal, scope short   | —            | G2 403      | —            |
 * | principal, scope met     | —            | H2 200      | —            |
 *
 * Every cell's test name starts with its id. B1 carries the load-bearing extra
 * assertion: the refusal happens before `decodeToken` and before any key
 * lookup, because resolving a machine token to its owning user is exactly what
 * this design exists to make unreachable.
 *
 * The registry is module-global and has no reset, so the verifiers are
 * registered once for the file and every prefix here is its own.
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

import { UnauthorizedError } from '@spfn/core/errors';

import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import {
    getMachinePrincipal,
    machineAuth,
    registerMachineVerifier,
    requireMachineScope,
    type MachinePrincipal,
} from '@/server/middleware/machine-principals';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';
import { CONTRACT_SUPPORTED_RANGE, CONTRACT_VERSION } from '@/server/client-proof/contract-bundle';
import { SERVER_CONTRACT_HEADERS } from '@/server/client-proof/wire-headers';
import { authLogger } from '@/server/logger';
import { decodeToken, verifyClientToken, keysRepository, findUserWithEffectiveRole } from '@spfn/auth/server';
import type { Context, Next } from 'hono';

const USER_ID = 7;
const KEY_ID = 'machine-case-table-key';

const VALID_PREFIX = 'spfn_mach_ok_';
const REJECTING_PREFIX = 'spfn_mach_no_';
const BUGGY_PREFIX = 'spfn_mach_bug_';
const NO_PRINCIPAL_PREFIX = 'spfn_mach_void_';
const UNREADABLE_PREFIX = 'spfn_mach_getter_';
const PROXY_PREFIX = 'spfn_mach_proxy_';
const SHIFTING_PREFIX = 'spfn_mach_shifting_';
const COPY_PREFIX = 'spfn_mach_copy_';
const UNREGISTERED_PREFIX = 'spfn_mach_nobody_';
const MACHINE_KID_PREFIX = 'machine:runtime:';
const UNREGISTERED_KID_PREFIX = 'machine:elsewhere:';

/** The error a registrant's bug throws — nothing of it may reach the wire. */
const REGISTRANT_INTERNALS = 'reporting-cluster.internal:5432 unreachable';

function machinePrincipal(overrides: Partial<MachinePrincipal> = {}): MachinePrincipal
{
    return {
        subjectType: 'account',
        subjectId: 'acct-42',
        scopes: ['events:write'],
        claims: { tokenId: 'tok_1' },
        scheme: 'the-verifier-does-not-decide-this',
        ...overrides,
    };
}

registerMachineVerifier({
    id: 'opaqueMachineV1',
    match: { tokenPrefix: VALID_PREFIX },
    verify: async () => machinePrincipal(),
});

registerMachineVerifier({
    id: 'rejectingMachineV1',
    match: { tokenPrefix: REJECTING_PREFIX },
    verify: async () =>
    {
        throw new UnauthorizedError({ message: 'this token was revoked at 09:14 by admin 3' });
    },
});

registerMachineVerifier({
    id: 'buggyMachineV1',
    match: { tokenPrefix: BUGGY_PREFIX },
    verify: async () =>
    {
        throw new TypeError(REGISTRANT_INTERNALS);
    },
});

registerMachineVerifier({
    id: 'noPrincipalMachineV1',
    match: { tokenPrefix: NO_PRINCIPAL_PREFIX },
    verify: async () => null as unknown as MachinePrincipal,
});

// The result is a principal only until something reads it — the shape a bug or
// a hostile registrant produces, and the one that must not reach the wire as a
// 500 carrying registrant text.
registerMachineVerifier({
    id: 'unreadableMachineV1',
    match: { tokenPrefix: UNREADABLE_PREFIX },
    verify: async () => ({
        subjectType: 'account',
        subjectId: 'acct-42',
        get scopes(): string[]
        {
            throw new TypeError(REGISTRANT_INTERNALS);
        },
        scheme: 'unreadableMachineV1',
    }),
});

registerMachineVerifier({
    id: 'proxyMachineV1',
    match: { tokenPrefix: PROXY_PREFIX },
    verify: async () => new Proxy({} as MachinePrincipal, {
        get()
        {
            throw new TypeError(REGISTRANT_INTERNALS);
        },
    }),
});

/** How many times shiftingMachineV1's identity has been read this run. */
let subjectIdReads = 0;

// A result that answers differently on the second read. Validating the
// registrant's object and then copying from it reads every field twice, and
// would store an identity that was never the one validated.
registerMachineVerifier({
    id: 'shiftingMachineV1',
    match: { tokenPrefix: SHIFTING_PREFIX },
    verify: async () => ({
        subjectType: 'account',
        get subjectId(): string
        {
            subjectIdReads += 1;

            return subjectIdReads === 1 ? 'acct-first' : 'acct-someone-else';
        },
        scopes: ['events:write'],
        scheme: 'shiftingMachineV1',
    }),
});

/** The object copyMachineV1 hands over and then keeps mutating. */
const RETAINED_RESULT = {
    subjectType: 'account',
    subjectId: 'acct-77',
    scopes: ['events:write'],
    claims: { tokenId: 'tok_9', issuer: { region: 'eu' } },
    scheme: 'copyMachineV1',
    privateHandle: 'not a field of MachinePrincipal',
} as unknown as MachinePrincipal;

registerMachineVerifier({
    id: 'copyMachineV1',
    match: { tokenPrefix: COPY_PREFIX },
    verify: async () => RETAINED_RESULT,
});

registerMachineVerifier({
    id: 'runtimeJwsV1',
    match: { kidPrefix: MACHINE_KID_PREFIX },
    verify: async () => machinePrincipal({ subjectType: 'service', subjectId: 'svc-9', scopes: ['events:read'] }),
});

function jwsWithKid(kid: string): string
{
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    return `${segment({ alg: 'RS256', kid })}.${segment({ sub: 'acct-42' })}.not-a-real-signature`;
}

const VALID_MACHINE_TOKEN = `${VALID_PREFIX}${'a'.repeat(32)}`;
const REJECTED_MACHINE_TOKEN = `${REJECTING_PREFIX}${'b'.repeat(32)}`;
const UNREGISTERED_MACHINE_TOKEN = `${UNREGISTERED_PREFIX}${'c'.repeat(32)}`;
const VALID_MACHINE_JWS = jwsWithKid(`${MACHINE_KID_PREFIX}svc-9`);
const UNREGISTERED_MACHINE_JWS = jwsWithKid(`${UNREGISTERED_KID_PREFIX}svc-9`);

function validKeyRecord()
{
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 90);

    return {
        id: 1,
        keyId: KEY_ID,
        userId: USER_ID,
        publicKey: 'unused-on-the-bearer-path',
        algorithm: 'ES256',
        isActive: true,
        expiresAt: futureDate,
    };
}

interface DrivenContext
{
    c: Context;
    next: Next;
    authOf: () => Record<string, unknown> | undefined;
    principalOf: () => MachinePrincipal | null;
}

function contextFor(headers: Record<string, string> = {}): DrivenContext
{
    const headerMap = new Headers(headers);
    const vars = new Map<string, unknown>();
    const next = vi.fn(async () => undefined);

    const c = {
        req: {
            method: 'POST',
            path: '/v1/ingest',
            raw: { headers: headerMap },
            header: (name?: string) =>
            {
                if (name === undefined)
                {
                    return Object.fromEntries(headerMap.entries());
                }

                return headerMap.get(name) ?? undefined;
            },
            arrayBuffer: async () => new ArrayBuffer(0),
        },
        set: (key: string, value: unknown) => vars.set(key, value),
        get: (key: string) => vars.get(key),
        newResponse: (body: BodyInit, status: number, responseHeaders: Record<string, string>) =>
            new Response(body, { status, headers: responseHeaders }),
    } as unknown as Context;

    return {
        c,
        next,
        authOf: () => vars.get('auth') as Record<string, unknown> | undefined,
        principalOf: () => getMachinePrincipal(c),
    };
}

type Middleware = typeof authenticate | typeof optionalAuth | typeof machineAuth;

/** Null when the middleware passed the request on, else its response or its throw. */
async function run(middleware: Middleware, driven: DrivenContext): Promise<unknown>
{
    return middleware.handler(driven.c, driven.next).then(res => res ?? null, (error: unknown) => error);
}

function bearer(token: string): Record<string, string>
{
    return { Authorization: `Bearer ${token}` };
}

/** The status and message a refusal carries, whether it threw or was built. */
async function refusalOf(answer: unknown): Promise<{ status: number; message: string }>
{
    if (answer instanceof Response)
    {
        const body = await answer.clone().json() as { error?: { message?: string } };

        return { status: answer.status, message: body.error?.message ?? '' };
    }

    const error = answer as Error & { statusCode?: number };

    return { status: error.statusCode ?? 0, message: error.message };
}

/** machineAuth followed by its scope guard, over one context. */
async function runScoped(driven: DrivenContext, required: string[]): Promise<{ answer: unknown; reached: boolean }>
{
    const handler = vi.fn(async () => undefined);
    const guard = requireMachineScope(...required);
    const answer = await machineAuth.handler(driven.c, async () =>
    {
        await guard(driven.c, handler);
    }).then(res => res ?? null, (error: unknown) => error);

    return { answer, reached: handler.mock.calls.length > 0 };
}

describe('the machine-principal case table', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        vi.mocked(keysRepository.updateLastUsedById).mockResolvedValue(undefined as never);
        vi.mocked(findUserWithEffectiveRole).mockResolvedValue({
            user: { id: USER_ID, email: 'machine-table@example.com', status: 'active' },
            role: { name: 'user' },
        } as never);
    });

    /** The mocks a user's Bearer JWT needs to authenticate for real. */
    function admitUserToken(): void
    {
        vi.mocked(decodeToken).mockReturnValue({ keyId: KEY_ID } as never);
        vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(validKeyRecord() as never);
        vi.mocked(verifyClientToken).mockReturnValue({ keyId: KEY_ID } as never);
    }

    describe('user bearer JWT', () =>
    {
        it('A1 authenticate: authenticates as before, with scheme bearer', async () =>
        {
            admitUserToken();
            const driven = contextFor(bearer('a-user-token'));

            expect(await run(authenticate, driven)).toBeNull();
            expect(driven.authOf()).toMatchObject({ userId: String(USER_ID), scheme: 'bearer' });
            expect(driven.principalOf()).toBeNull();
        });

        it('A2 machineAuth: refused — a user session is not a machine principal', async () =>
        {
            admitUserToken();
            const driven = contextFor(bearer('a-user-token'));

            expect((await refusalOf(await run(machineAuth, driven))).status).toBe(401);
            expect(driven.next).not.toHaveBeenCalled();
            expect(driven.principalOf()).toBeNull();
            expect(driven.authOf()).toBeUndefined();
        });

        it('A3 optionalAuth: authenticates as before, with scheme bearer', async () =>
        {
            admitUserToken();
            const driven = contextFor(bearer('a-user-token'));

            expect(await run(optionalAuth, driven)).toBeNull();
            expect(driven.authOf()).toMatchObject({ userId: String(USER_ID), scheme: 'bearer' });
        });
    });

    describe('a machine token in a registered namespace, valid', () =>
    {
        it('B1 authenticate: refused BEFORE the token is decoded or a key is looked up', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));

            const refusal = await refusalOf(await run(authenticate, driven));

            expect(refusal.status).toBe(401);
            expect(refusal.message).toBe('Invalid token: missing keyId');
            expect(decodeToken).not.toHaveBeenCalled();
            expect(keysRepository.findActiveByKeyId).not.toHaveBeenCalled();
            expect(driven.authOf()).toBeUndefined();
            expect(driven.next).not.toHaveBeenCalled();
        });

        it('B2 machineAuth: admits it into machinePrincipal, leaving AuthContext unset', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));

            expect(await run(machineAuth, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
            expect(driven.principalOf()).toEqual({
                subjectType: 'account',
                subjectId: 'acct-42',
                scopes: ['events:write'],
                claims: { tokenId: 'tok_1' },
                scheme: 'opaqueMachineV1',
            });
            expect(driven.authOf()).toBeUndefined();
        });

        it('B2 machineAuth: admits a JWS matched on its kid prefix', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_JWS));

            expect(await run(machineAuth, driven)).toBeNull();
            expect(driven.principalOf()).toMatchObject({
                subjectType: 'service',
                subjectId: 'svc-9',
                scheme: 'runtimeJwsV1',
            });
        });

        it('B2 machineAuth: the scheme is the registry\'s id, not what the verifier claimed', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));
            await run(machineAuth, driven);

            expect(driven.principalOf()?.scheme).toBe('opaqueMachineV1');
        });

        it('B3 optionalAuth: refused — presented-but-wrong is not the same as absent', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));

            expect((await refusalOf(await run(optionalAuth, driven))).status).toBe(401);
            expect(driven.next).not.toHaveBeenCalled();
            expect(driven.authOf()).toBeUndefined();
            expect(driven.principalOf()).toBeNull();
        });
    });

    describe('a machine token whose verifier rejects it', () =>
    {
        it('C1 authenticate: 401, and the verifier is never consulted here', async () =>
        {
            const driven = contextFor(bearer(REJECTED_MACHINE_TOKEN));
            const refusal = await refusalOf(await run(authenticate, driven));

            expect(refusal.status).toBe(401);
            expect(refusal.message).toBe('Invalid token: missing keyId');
        });

        it('C2 machineAuth: 401, and the verifier\'s own words are not on the wire', async () =>
        {
            const driven = contextFor(bearer(REJECTED_MACHINE_TOKEN));
            const refusal = await refusalOf(await run(machineAuth, driven));

            expect(refusal.status).toBe(401);
            expect(refusal.message).not.toContain('revoked');
            expect(driven.principalOf()).toBeNull();
        });

        it('C3 optionalAuth: 401 rather than anonymous passage', async () =>
        {
            const driven = contextFor(bearer(REJECTED_MACHINE_TOKEN));

            expect((await refusalOf(await run(optionalAuth, driven))).status).toBe(401);
            expect(driven.next).not.toHaveBeenCalled();
        });
    });

    describe('a machine-shaped token in a namespace nobody registered', () =>
    {
        it('D1 authenticate: 401 through the existing invalid-token path', async () =>
        {
            vi.mocked(decodeToken).mockReturnValue(null as never);
            const driven = contextFor(bearer(UNREGISTERED_MACHINE_TOKEN));
            const refusal = await refusalOf(await run(authenticate, driven));

            expect(refusal.status).toBe(401);
            expect(refusal.message).toBe('Invalid token: missing keyId');
            expect(decodeToken).toHaveBeenCalled();
        });

        it.each([
            ['an opaque secret', UNREGISTERED_MACHINE_TOKEN],
            ['a JWS with an unregistered kid namespace', UNREGISTERED_MACHINE_JWS],
        ])('D2 machineAuth: 401 for %s', async (_label, token) =>
        {
            const driven = contextFor(bearer(token));

            expect((await refusalOf(await run(machineAuth, driven))).status).toBe(401);
            expect(driven.principalOf()).toBeNull();
        });

        // The one cell that reads differently from the design table, and it has
        // to: a token in a namespace nobody registered is not a machine
        // credential as far as this code can tell — it is an invalid Bearer
        // token, and optionalAuth has always continued anonymously for those.
        // Refusing it would mean refusing every unusable Bearer token, which is
        // the behaviour change defect 1 forbids. B3/C3 are the cells where the
        // registry *does* know a machine credential was presented, and those
        // refuse.
        it('D3 optionalAuth: continues anonymously, as it does for any unusable Bearer token', async () =>
        {
            vi.mocked(decodeToken).mockReturnValue(null as never);
            const driven = contextFor(bearer(UNREGISTERED_MACHINE_TOKEN));

            expect(await run(optionalAuth, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
            expect(driven.authOf()).toBeUndefined();
        });
    });

    describe('a profile header mixed with Bearer credentials', () =>
    {
        it.each([
            ['E1 authenticate', authenticate],
            ['E3 optionalAuth', optionalAuth],
        ])('%s: refused as the mixture, unchanged by this work', async (_label, middleware) =>
        {
            const driven = contextFor({
                ...bearer(VALID_MACHINE_TOKEN),
                [CLIENT_PROOF_HEADERS.profile]: 'clientProofV1',
            });
            const refusal = await refusalOf(await run(middleware, driven));

            expect(refusal.message).toContain('must not be mixed');
        });

        // The message alone would pass with the refusal thrown at the generic
        // error handler, which answers the same status and code without a
        // requestId and without the contract headers. What is pinned is the
        // envelope: machineAuth is a refusal surface like the other two, and it
        // builds its answer through clientProofRefusalResponse.
        it('E2 machineAuth: refused as the mixture, in the contract\'s own envelope', async () =>
        {
            const driven = contextFor({
                ...bearer(VALID_MACHINE_TOKEN),
                [CLIENT_PROOF_HEADERS.profile]: 'clientProofV1',
            });
            const answer = await run(machineAuth, driven);

            expect(answer).toBeInstanceOf(Response);

            const response = answer as Response;
            const body = await response.clone().json() as { error: { code: string; message: string; requestId: string } };

            expect(response.status).toBe(400);
            expect(body.error.code).toBe('PROFILE_REJECTED');
            expect(body.error.message).toContain('must not be mixed');
            expect(body.error.requestId).toMatch(/^[0-9a-f]{32}$/);
            expect(response.headers.get(SERVER_CONTRACT_HEADERS.version)).toBe(CONTRACT_VERSION);
            expect(response.headers.get(SERVER_CONTRACT_HEADERS.supportedRange)).toBe(CONTRACT_SUPPORTED_RANGE);
            expect(driven.principalOf()).toBeNull();
            expect(driven.next).not.toHaveBeenCalled();
        });
    });

    describe('no credential at all', () =>
    {
        it('F1 authenticate: 401, unchanged', async () =>
        {
            const driven = contextFor();

            expect((await refusalOf(await run(authenticate, driven))).message)
                .toContain('Authentication header missing or invalid');
        });

        it('F2 machineAuth: 401', async () =>
        {
            const driven = contextFor();

            expect((await refusalOf(await run(machineAuth, driven))).status).toBe(401);
            expect(driven.next).not.toHaveBeenCalled();
        });

        it('F3 optionalAuth: continues with no auth context', async () =>
        {
            const driven = contextFor();

            expect(await run(optionalAuth, driven)).toBeNull();
            expect(driven.next).toHaveBeenCalled();
            expect(driven.authOf()).toBeUndefined();
        });
    });

    describe('requireMachineScope', () =>
    {
        it('G2: a valid principal short of a required scope is 403, and the route is not reached', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));
            const { answer, reached } = await runScoped(driven, ['events:write', 'events:admin']);
            const refusal = await refusalOf(answer);

            expect(refusal.status).toBe(403);
            expect(refusal.message).toContain('events:admin');
            expect(refusal.message).not.toContain('events:write');
            expect(reached).toBe(false);
        });

        it('H2: a valid principal carrying every required scope reaches the route', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));
            const { answer, reached } = await runScoped(driven, ['events:write']);

            expect(answer).toBeNull();
            expect(reached).toBe(true);
        });

        it('fails closed with 401 when no machineAuth ran before it (middleware misordering)', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));
            const handler = vi.fn(async () => undefined);
            const guard = requireMachineScope('events:write');

            const answer = await guard(driven.c, handler).then(res => res ?? null, (error: unknown) => error);

            expect((await refusalOf(answer)).status).toBe(401);
            expect(handler).not.toHaveBeenCalled();
        });

        it('matches scopes exactly — a literal \'*\' grants only itself', async () =>
        {
            const driven = contextFor(bearer(VALID_MACHINE_TOKEN));
            const { answer } = await runScoped(driven, ['*']);

            expect((await refusalOf(answer)).status).toBe(403);
        });
    });

    describe('a verifier that fails in a way its author did not intend', () =>
    {
        it('answers the generic 401 and logs the real error — never a 500, never a pass', async () =>
        {
            const logged = vi.spyOn(authLogger.middleware, 'error').mockImplementation(() => undefined);
            const driven = contextFor(bearer(`${BUGGY_PREFIX}${'d'.repeat(32)}`));

            const refusal = await refusalOf(await run(machineAuth, driven));

            expect(refusal.status).toBe(401);
            expect(refusal.message).not.toContain(REGISTRANT_INTERNALS);
            expect(driven.next).not.toHaveBeenCalled();
            expect(driven.principalOf()).toBeNull();
            expect(logged).toHaveBeenCalledWith(
                expect.stringContaining('buggyMachineV1'),
                expect.objectContaining({ message: REGISTRANT_INTERNALS }),
            );

            logged.mockRestore();
        });

        it('refuses a verifier that resolves no principal rather than routing it as admitted', async () =>
        {
            const logged = vi.spyOn(authLogger.middleware, 'error').mockImplementation(() => undefined);
            const driven = contextFor(bearer(`${NO_PRINCIPAL_PREFIX}${'e'.repeat(32)}`));

            expect((await refusalOf(await run(machineAuth, driven))).status).toBe(401);
            expect(driven.next).not.toHaveBeenCalled();
            expect(driven.principalOf()).toBeNull();
            expect(logged).toHaveBeenCalled();

            logged.mockRestore();
        });

        // Reading the result is part of the verification: a principal that
        // throws when it is read fails inside the same containment its verifier
        // does. Outside it, this is a 500 carrying registrant text on a route
        // whose whole answer vocabulary is one generic 401.
        it.each([
            ['a getter that throws', UNREADABLE_PREFIX, 'unreadableMachineV1'],
            ['a Proxy that refuses every read', PROXY_PREFIX, 'proxyMachineV1'],
        ])('refuses a resolved principal that cannot be read — %s', async (_label, prefix, id) =>
        {
            const logged = vi.spyOn(authLogger.middleware, 'error').mockImplementation(() => undefined);
            const driven = contextFor(bearer(`${prefix}${'f'.repeat(32)}`));

            const refusal = await refusalOf(await run(machineAuth, driven));
            const generic = await refusalOf(await run(machineAuth, contextFor()));

            expect(refusal).toEqual(generic);
            expect(refusal.status).toBe(401);
            expect(refusal.message).not.toContain(REGISTRANT_INTERNALS);
            expect(driven.next).not.toHaveBeenCalled();
            expect(driven.principalOf()).toBeNull();
            expect(logged).toHaveBeenCalledWith(
                expect.stringContaining(id),
                expect.objectContaining({ message: REGISTRANT_INTERNALS }),
            );

            logged.mockRestore();
        });
    });

    describe('what the context holds is this package\'s own object', () =>
    {
        it('copies the declared fields, drops the rest, and does not follow later mutation', async () =>
        {
            const driven = contextFor(bearer(`${COPY_PREFIX}${'g'.repeat(32)}`));

            expect(await run(machineAuth, driven)).toBeNull();

            const principal = driven.principalOf()!;

            expect(Object.keys(principal).sort()).toEqual(['claims', 'scheme', 'scopes', 'subjectId', 'subjectType']);
            expect(principal).toEqual({
                subjectType: 'account',
                subjectId: 'acct-77',
                scopes: ['events:write'],
                claims: { tokenId: 'tok_9', issuer: { region: 'eu' } },
                scheme: 'copyMachineV1',
            });

            RETAINED_RESULT.scopes.push('events:admin');
            (RETAINED_RESULT.claims!.issuer as { region: string }).region = 'us';
            try
            {
                expect(principal.scopes).toEqual(['events:write']);
                expect(principal.claims).toEqual({ tokenId: 'tok_9', issuer: { region: 'eu' } });
            }
            finally
            {
                RETAINED_RESULT.scopes.pop();
                (RETAINED_RESULT.claims!.issuer as { region: string }).region = 'eu';
            }
        });

        it('reads each declared field once, so it cannot store an identity it never validated', async () =>
        {
            subjectIdReads = 0;
            const driven = contextFor(bearer(`${SHIFTING_PREFIX}${'h'.repeat(32)}`));

            expect(await run(machineAuth, driven)).toBeNull();
            expect(subjectIdReads).toBe(1);
            expect(driven.principalOf()?.subjectId).toBe('acct-first');
        });
    });

    describe('the refusals are indistinguishable from one another', () =>
    {
        it('an unknown namespace, a rejected token and a user session share one status and one message', async () =>
        {
            admitUserToken();
            const logged = vi.spyOn(authLogger.middleware, 'error').mockImplementation(() => undefined);
            const answers = await Promise.all([
                refusalOf(await run(machineAuth, contextFor(bearer(UNREGISTERED_MACHINE_TOKEN)))),
                refusalOf(await run(machineAuth, contextFor(bearer(UNREGISTERED_MACHINE_JWS)))),
                refusalOf(await run(machineAuth, contextFor(bearer(REJECTED_MACHINE_TOKEN)))),
                refusalOf(await run(machineAuth, contextFor(bearer(`${BUGGY_PREFIX}x`)))),
                refusalOf(await run(machineAuth, contextFor(bearer(`${UNREADABLE_PREFIX}x`)))),
                refusalOf(await run(machineAuth, contextFor(bearer(`${PROXY_PREFIX}x`)))),
                refusalOf(await run(machineAuth, contextFor(bearer(`${NO_PRINCIPAL_PREFIX}x`)))),
                refusalOf(await run(machineAuth, contextFor(bearer('a-user-token')))),
                refusalOf(await run(machineAuth, contextFor())),
            ]);

            expect(new Set(answers.map(a => `${a.status} ${a.message}`)).size).toBe(1);

            logged.mockRestore();
        });

        it('on the user path, a registered machine namespace answers what an unregistered one does', async () =>
        {
            vi.mocked(decodeToken).mockReturnValue(null as never);
            const registered = await refusalOf(await run(authenticate, contextFor(bearer(VALID_MACHINE_TOKEN))));
            const unregistered = await refusalOf(await run(authenticate, contextFor(bearer(UNREGISTERED_MACHINE_TOKEN))));

            expect(registered).toEqual(unregistered);
        });
    });
});
