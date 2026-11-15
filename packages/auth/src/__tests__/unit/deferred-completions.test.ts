/**
 * T7 (audit bundle 4, w-x8xt9): every completion is admitted.
 *
 * The cause bundle 4 removes is a completion that wrote what its start
 * authorised without asking the account again. This holds the next two-step
 * procedure to the rule from the source: every exported service function that
 * — directly or through the functions it calls — writes a second factor, a
 * passkey or a social link, or completes a challenge, reaches `admitDeferred`
 * or `admitPrincipal`, or is named below with why it completes nothing a
 * signed-in person started.
 *
 * The writes are derived from the repositories, not listed: every classified
 * (`accountWrites`, not exempt) method of an `AccountStateRepository` that
 * writes one of those tables and whose statement adds a way in or spends a
 * pending record — an insert into
 * `passkeys`, `mfa_recovery_codes` or `user_social_accounts`, a passkey marked
 * as a second factor, an enrolment confirmed (`confirmed_at`), a WebAuthn
 * challenge spent (`consumed_at`). A write method added later in one of those
 * shapes is a writer the first time this runs.
 *
 * What it does not see: a call through a variable or a callback the scan
 * cannot name (`repo[name]()`, a function passed as an argument), and a
 * function nested inside another, whose calls count as its parent's.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import * as repositories from '@/server/repositories';
import { AccountStateRepository, ownMethods } from '@/server/repositories/account-state.repository';

const SERVER_ROOT = resolve(import.meta.dirname, '../../server');

/** A write on one of the tables the row names: a second factor, a passkey, a social link, a WebAuthn challenge. */
const NAMED_TABLE_WRITE = /\.(?:insert|update)\s*\(\s*(?:\(0,\s*)?(?:[\w$]+\.)?(?:passkeys|mfaTotp|mfaRecoveryCodes|userSocialAccounts|webauthnChallenges)\b/;

/** The statement shapes that add a way in or spend a pending record, in compiled method source. */
const ADDING_SHAPES: RegExp[] = [
    /\.insert\s*\(\s*(?:\(0,\s*)?(?:[\w$]+\.)?(?:passkeys|mfaRecoveryCodes|userSocialAccounts)\b/,
    /\.set\s*\(\s*\{[^}]*\bsecondFactor\b(?!\s*:\s*false)/,
    /\bconfirmedAt\s*:\s*(?:\/\*[^*]*\*\/\s*)?new Date\b/,
    /\bconsumedAt\s*:\s*(?:\/\*[^*]*\*\/\s*)?new Date\b/,
];

/** The functions a completion is admitted by. */
const ADMISSIONS = new Set(['admitDeferred', 'admitPrincipal']);

/** Exported functions that reach such a write and complete nothing a signed-in person started, and why. */
const NOT_A_COMPLETION: Record<string, string> = {
    'webauthn-challenge.service.ts spendChallenge': 'the spend primitive itself: each function that calls it is checked here',
    'passkey.service.ts finishPasskeyLoginService': 'a sign-in: nobody is signed in, the challenge names no account (D3), and the key it writes is admitted by registerPublicKeyService',
    'mfa.service.ts regenerateRecoveryCodesService': 'one step, decided on its own request: the route asks assertStepUp of the account as it is',
    'mfa.service.ts markPasskeySecondFactorService': 'one step, decided on its own request: the route asks assertStepUp of the account as it is',
    'oauth.service.ts createOrLinkUser': 'a sign-in (web and native): the identity it attaches is the one signing in, and the key it writes is admitted by registerPublicKeyService',
    'oauth.service.ts oauthCallbackService': 'the web sign-in callback, through createOrLinkUser (a sign-in); a link callback goes to oauthLinkCallbackService, which is admitted',
    'oauth-native.service.ts oauthNativeService': 'the native sign-in, through createOrLinkUser (a sign-in)',
};

interface SourceFunction
{
    id: string;
    name: string;
    exported: boolean;
    body: string;
}

/** Every non-test source file under `src/server/services` and `src/server/lib`. */
function sources(directory: string): string[]
{
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const path = join(directory, entry.name);

        if (entry.isDirectory())
        {
            return entry.name === '__tests__' ? [] : sources(path);
        }

        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });
}

/** The top-level functions of a file, each with its body — up to the next line that starts with `}`. */
function functionsOf(path: string): SourceFunction[]
{
    const file = path.slice(path.lastIndexOf('/') + 1);
    const pattern = /^(export\s+)?(?:async\s+)?function\s+([\w$]+)[\s\S]*?^\}/gm;

    return [...readFileSync(path, 'utf8').matchAll(pattern)].map(match => ({
        id: `${file} ${match[2]}`,
        name: match[2]!,
        exported: match[1] !== undefined,
        body: match[0],
    }));
}

/** `instance.method` for every classified write of a repository whose statement has an adding shape. */
function addingWriters(): Set<string>
{
    const instances = Object.entries(repositories as Record<string, unknown>)
        .filter((entry): entry is [string, AccountStateRepository] => entry[1] instanceof AccountStateRepository);

    return new Set(instances.flatMap(([instance, repository]) =>
    {
        const declared = (repository.constructor as typeof AccountStateRepository).accountWrites;

        return [...ownMethods(Object.getPrototypeOf(repository))]
            .filter(([name, method]) => declared[name] && !('exempt' in declared[name]!)
                && NAMED_TABLE_WRITE.test(method.toString())
                && ADDING_SHAPES.some(shape => shape.test(method.toString())))
            .map(([name]) => `${instance}.${name}`);
    }));
}

/** Whether a function, or any function it calls by name, satisfies `direct`. */
function reaches(fn: SourceFunction, byName: Map<string, SourceFunction[]>, direct: (body: string) => boolean): boolean
{
    const seen = new Set<string>();
    const pending = [fn];

    while (pending.length > 0)
    {
        const next = pending.pop()!;

        if (seen.has(next.id))
        {
            continue;
        }

        seen.add(next.id);

        if (direct(next.body))
        {
            return true;
        }

        const called = [...next.body.matchAll(/\b([\w$]+)\s*\(/g)].map(match => match[1]!);

        pending.push(...called.flatMap(name => byName.get(name) ?? []));
    }

    return false;
}

describe('T7 every completion is admitted', () =>
{
    const functions = [...sources(join(SERVER_ROOT, 'services')), ...sources(join(SERVER_ROOT, 'lib'))].flatMap(functionsOf);
    const byName = new Map<string, SourceFunction[]>();

    functions.forEach(fn => byName.set(fn.name, [...byName.get(fn.name) ?? [], fn]));

    const writers = addingWriters();
    const writes = (body: string) => [...body.matchAll(/\b([\w$]+Repository)\s*\.\s*([\w$]+)\s*\(/g)]
        .some(match => writers.has(`${match[1]}.${match[2]}`));
    const admits = (body: string) => [...body.matchAll(/\b([\w$]+)\s*\(/g)].some(match => ADMISSIONS.has(match[1]!));
    const completions = functions.filter(fn => fn.exported && reaches(fn, byName, writes));

    it('derives the writers from the repositories: a passkey, a marked factor, a confirmed enrolment, recovery codes, a social link, a spent challenge', () =>
    {
        expect([...writers].sort()).toEqual([
            'mfaRecoveryCodesRepository.createGeneration',
            'mfaTotpRepository.confirm',
            'passkeysRepository.create',
            'passkeysRepository.markSecondFactorByIdAndUserId',
            'socialAccountsRepository.createIfAbsent',
            'webauthnChallengesRepository.consume',
        ]);
    });

    it('finds every exported function that writes one admitted, or named with why it completes nothing deferred', () =>
    {
        const unadmitted = completions
            .filter(fn => !NOT_A_COMPLETION[fn.id] && !reaches(fn, byName, admits))
            .map(fn => fn.id);

        expect(unadmitted).toEqual([]);
    });

    it('names no function that no longer writes one, and none that is admitted after all', () =>
    {
        const ids = new Set(completions.map(fn => fn.id));
        const stale = Object.keys(NOT_A_COMPLETION).filter(id => !ids.has(id));
        const admitted = Object.keys(NOT_A_COMPLETION)
            .filter(id => ids.has(id) && reaches(completions.find(fn => fn.id === id)!, byName, admits));

        expect(stale).toEqual([]);
        expect(admitted).toEqual([]);
    });

    it('fails a new two-step completion that asks neither', () =>
    {
        const probe: SourceFunction = {
            id: 'probe.service.ts completeThingService',
            name: 'completeThingService',
            exported: true,
            body: 'export async function completeThingService(userId)\n{\n    await passkeysRepository.create({ userId });\n}',
        };

        expect(reaches(probe, byName, writes)).toBe(true);
        expect(reaches(probe, byName, admits)).toBe(false);
    });
});
