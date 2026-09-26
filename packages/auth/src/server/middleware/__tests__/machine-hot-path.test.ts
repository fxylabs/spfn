/**
 * The regression criterion for #79: with no machine verifier registered, the
 * user path is what it was.
 *
 * This file registers nothing, and nothing may register into it — vitest gives
 * each test file its own module registry, which is the only way to observe an
 * empty registry once another file has filled one. The claim is both halves of
 * "zero registrations add zero work and zero behaviour change": a
 * machine-shaped credential still takes the ordinary decode → key-lookup path,
 * and the unverified JOSE header peek is never performed.
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

vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, decodeProtectedHeader: vi.fn(actual.decodeProtectedHeader) };
});

import { decodeProtectedHeader } from 'jose';

import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import { findMachineVerifier } from '@/server/middleware/machine-principals';
import { decodeToken, verifyClientToken, keysRepository, findUserWithEffectiveRole } from '@spfn/auth/server';
import type { Context, Next } from 'hono';

const USER_ID = 11;
const KEY_ID = 'hot-path-key-0001';

/** A machine-shaped opaque secret and a machine-shaped JWS — neither registered. */
const OPAQUE_MACHINE_TOKEN = `spfn_mach_${'0'.repeat(32)}`;

function jwsWithKid(kid: string): string
{
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    return `${segment({ alg: 'RS256', kid })}.${segment({ sub: 'acct-1' })}.not-a-real-signature`;
}

const MACHINE_KID_TOKEN = jwsWithKid('machine:runtime:acct-1');

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
}

function contextFor(headers: Record<string, string> = {}): DrivenContext
{
    const headerMap = new Headers(headers);
    const vars = new Map<string, unknown>();
    const next = vi.fn(async () => undefined);

    const c = {
        req: {
            method: 'POST',
            path: '/v1/protected',
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

    return { c, next, authOf: () => vars.get('auth') as Record<string, unknown> | undefined };
}

type Middleware = typeof authenticate | typeof optionalAuth;

async function run(middleware: Middleware, driven: DrivenContext): Promise<unknown>
{
    return middleware.handler(driven.c, driven.next).then(res => res ?? null, (error: unknown) => error);
}

describe('with no machine verifier registered', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        vi.mocked(keysRepository.updateLastUsedById).mockResolvedValue(undefined as never);
        vi.mocked(findUserWithEffectiveRole).mockResolvedValue({
            user: { id: USER_ID, email: 'hot@example.com', status: 'active' },
            role: { name: 'user' },
        } as never);
    });

    it('the registry matches nothing, for either discriminator shape', () =>
    {
        expect(findMachineVerifier(OPAQUE_MACHINE_TOKEN)).toBeNull();
        expect(findMachineVerifier(MACHINE_KID_TOKEN)).toBeNull();
    });

    it('never peeks at a JOSE header — the cost only a kidPrefix registration buys', async () =>
    {
        vi.mocked(decodeToken).mockReturnValue(null as never);

        await run(authenticate, contextFor({ Authorization: `Bearer ${MACHINE_KID_TOKEN}` }));
        await run(optionalAuth, contextFor({ Authorization: `Bearer ${MACHINE_KID_TOKEN}` }));
        findMachineVerifier(MACHINE_KID_TOKEN);

        expect(decodeProtectedHeader).not.toHaveBeenCalled();
    });

    it.each([
        ['an opaque machine-shaped secret', OPAQUE_MACHINE_TOKEN],
        ['a machine-shaped JWS', MACHINE_KID_TOKEN],
    ])('authenticate still decodes %s itself and refuses it as an invalid token', async (_label, token) =>
    {
        vi.mocked(decodeToken).mockReturnValue(null as never);
        const driven = contextFor({ Authorization: `Bearer ${token}` });

        const answer = await run(authenticate, driven);

        expect((answer as Error).message).toBe('Invalid token: missing keyId');
        expect(decodeToken).toHaveBeenCalledWith(token);
        expect(driven.next).not.toHaveBeenCalled();
    });

    it('authenticate still admits a valid user token', async () =>
    {
        vi.mocked(decodeToken).mockReturnValue({ keyId: KEY_ID } as never);
        vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(validKeyRecord() as never);
        vi.mocked(verifyClientToken).mockReturnValue({ keyId: KEY_ID } as never);
        const driven = contextFor({ Authorization: 'Bearer user-token' });

        expect(await run(authenticate, driven)).toBeNull();
        expect(driven.authOf()).toMatchObject({ userId: String(USER_ID), scheme: 'bearer' });
    });

    it('optionalAuth still continues anonymously for a token it cannot use', async () =>
    {
        vi.mocked(decodeToken).mockReturnValue(null as never);
        const driven = contextFor({ Authorization: `Bearer ${OPAQUE_MACHINE_TOKEN}` });

        expect(await run(optionalAuth, driven)).toBeNull();
        expect(driven.next).toHaveBeenCalled();
        expect(driven.authOf()).toBeUndefined();
    });
});
