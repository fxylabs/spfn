/**
 * What `registerMachineVerifier` refuses to register, and what the dispatch
 * does with what it accepted (#79).
 *
 * The claim under test is that first-match ambiguity is impossible by
 * construction: two verifiers a single token could match are refused at boot,
 * so no request ever has to be resolved by registration order. Equality is the
 * degenerate case of shadowing, so a duplicate discriminator is refused by the
 * same rule.
 *
 * Also here: the JOSE header peek is not paid for by a deployment that
 * registered no kidPrefix verifier — asserted on the jose call itself, since
 * that is the cost the design promises nobody pays.
 *
 * The registry is module-global and has no reset (removing a verifier at
 * runtime is the same rearrangement registering over one would be), so every
 * test registers ids and prefixes of its own.
 */
import { describe, it, expect, vi } from 'vitest';

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

    // The real implementation, observed: the guard under test is whether it is
    // called at all, not what it answers.
    return { ...actual, decodeProtectedHeader: vi.fn(actual.decodeProtectedHeader) };
});

import { decodeProtectedHeader } from 'jose';

import {
    findMachineVerifier,
    matchesMachineDiscriminator,
    registerMachineVerifier,
    type MachinePrincipal,
    type MachineVerifierRegistration,
} from '@/server/middleware/machine-principals';

/** A verifier that admits everything — these tests never run one. */
async function admitting(): Promise<MachinePrincipal>
{
    return { subjectType: 'account', subjectId: 'acct-1', scopes: [], scheme: 'unused' };
}

let idCounter = 0;
function uniqueId(): string
{
    idCounter += 1;

    return `machineVerifierV${idCounter}`;
}

/** A compact JWS whose protected header names `kid`. Only the header is read. */
function jwsWithKid(kid: string): string
{
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    return `${segment({ alg: 'RS256', kid })}.${segment({ sub: 'acct-1' })}.not-a-real-signature`;
}

function register(match: MachineVerifierRegistration['match'], id = uniqueId()): string
{
    registerMachineVerifier({ id, match, verify: admitting });

    return id;
}

describe('registerMachineVerifier — what it refuses to register', () =>
{
    it('refuses a duplicate id', () =>
    {
        const id = register({ tokenPrefix: 'dup_id_first_' });

        expect(() => registerMachineVerifier({
            id,
            match: { tokenPrefix: 'dup_id_second_' },
            verify: admitting,
        })).toThrow(/already registered/);
    });

    it('refuses a duplicate tokenPrefix', () =>
    {
        register({ tokenPrefix: 'dup_token_prefix_' });

        expect(() => register({ tokenPrefix: 'dup_token_prefix_' })).toThrow(/shadow/);
    });

    it('refuses a duplicate kidPrefix', () =>
    {
        register({ kidPrefix: 'machine:dupkid:' });

        expect(() => register({ kidPrefix: 'machine:dupkid:' })).toThrow(/shadow/);
    });

    it.each([
        ['the new tokenPrefix extends a registered one', 'shadow_token_', 'shadow_token_narrow_'],
        ['the new tokenPrefix swallows a registered one', 'swallow_token_narrow_', 'swallow_token_'],
    ])('refuses prefix shadowing when %s', (_label, first, second) =>
    {
        register({ tokenPrefix: first });

        expect(() => register({ tokenPrefix: second })).toThrow(/shadow/);
    });

    it.each([
        ['the new kidPrefix extends a registered one', 'machine:shadow:', 'machine:shadow:narrow:'],
        ['the new kidPrefix swallows a registered one', 'machine:swallow:narrow:', 'machine:swallow:'],
    ])('refuses kidPrefix shadowing when %s', (_label, first, second) =>
    {
        register({ kidPrefix: first });

        expect(() => register({ kidPrefix: second })).toThrow(/shadow/);
    });

    it('does not treat a tokenPrefix and a kidPrefix as colliding — they discriminate different things', () =>
    {
        register({ tokenPrefix: 'cross_kind_' });

        expect(() => register({ kidPrefix: 'cross_kind_' })).not.toThrow();
    });

    it.each([
        ['both discriminators', { tokenPrefix: 'both_', kidPrefix: 'both:' }],
        ['neither discriminator', {}],
        ['an empty tokenPrefix', { tokenPrefix: '' }],
        ['an empty kidPrefix', { kidPrefix: '' }],
        ['a non-string tokenPrefix', { tokenPrefix: 7 }],
    ])('refuses a match naming %s', (_label, match) =>
    {
        expect(() => registerMachineVerifier({
            id: uniqueId(),
            match: match as MachineVerifierRegistration['match'],
            verify: admitting,
        })).toThrow(/exactly one non-empty discriminator/);
    });

    it.each([
        ['an empty id', ''],
        ['a non-string id', 7],
    ])('refuses %s', (_label, id) =>
    {
        expect(() => registerMachineVerifier({
            id: id as string,
            match: { tokenPrefix: 'bad_id_' },
            verify: admitting,
        })).toThrow(/non-empty string/);
    });

    it('refuses a verifier without a callable verify', () =>
    {
        expect(() => registerMachineVerifier({
            id: uniqueId(),
            match: { tokenPrefix: 'no_verify_' },
            verify: undefined as unknown as MachineVerifierRegistration['verify'],
        })).toThrow(/callable verify/);
    });

    it('leaves nothing behind when it refuses: the prefix still matches no verifier', () =>
    {
        expect(() => registerMachineVerifier({
            id: uniqueId(),
            match: { tokenPrefix: 'left_behind_' },
            verify: undefined as unknown as MachineVerifierRegistration['verify'],
        })).toThrow();

        expect(matchesMachineDiscriminator('left_behind_token')).toBe(false);
    });
});

describe('registerMachineVerifier — the dispatch over what it accepted', () =>
{
    it('matches a raw token prefix', () =>
    {
        const id = register({ tokenPrefix: 'dispatch_token_' });

        expect(findMachineVerifier('dispatch_token_abc')?.id).toBe(id);
        expect(findMachineVerifier('other_token_abc')).toBeNull();
    });

    it('matches a kid prefix on the unverified JOSE header', () =>
    {
        const id = register({ kidPrefix: 'machine:dispatch:' });

        expect(findMachineVerifier(jwsWithKid('machine:dispatch:acct-1'))?.id).toBe(id);
        expect(findMachineVerifier(jwsWithKid('machine:elsewhere:acct-1'))).toBeNull();
    });

    it('answers null for a token that is not a compact JWS rather than throwing', () =>
    {
        register({ kidPrefix: 'machine:notajws:' });

        expect(findMachineVerifier('not-a-jws-at-all')).toBeNull();
    });

    it('answers null for a JWS whose header carries no kid', () =>
    {
        register({ kidPrefix: 'machine:nokid:' });
        const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const token = `${segment({ alg: 'RS256' })}.${segment({ sub: 'x' })}.sig`;

        expect(findMachineVerifier(token)).toBeNull();
    });

    it('holds a bound copy, so reassigning the registrant\'s verify does not swap the admitting code', async () =>
    {
        const registered = vi.fn(admitting);
        const swapped = vi.fn(admitting);
        const registration = {
            id: uniqueId(),
            match: { tokenPrefix: 'bound_copy_' },
            verify: registered,
        };
        registerMachineVerifier(registration);

        registration.verify = swapped;
        await findMachineVerifier('bound_copy_token')!.verify('bound_copy_token', {} as never);

        expect(registered).toHaveBeenCalledTimes(1);
        expect(swapped).not.toHaveBeenCalled();
    });
});

describe('the JOSE header peek', () =>
{
    // Its other half — that the peek does not happen at all until a kidPrefix
    // verifier exists — needs a registry with none, which is a module state no
    // test in this file still has. It lives in machine-hot-path.test.ts.
    it('is performed once a kidPrefix verifier is registered', () =>
    {
        register({ kidPrefix: 'machine:peek:' });
        vi.mocked(decodeProtectedHeader).mockClear();

        expect(findMachineVerifier(jwsWithKid('machine:peek:acct-1'))).not.toBeNull();
        expect(decodeProtectedHeader).toHaveBeenCalledTimes(1);
    });
});
