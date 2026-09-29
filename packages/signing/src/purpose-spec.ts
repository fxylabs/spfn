/**
 * The rules a `PurposeSpec` is held to, shared by the registry that signs
 * (`definePurposes`) and the verifier that checks (`purposeVerifier`).
 *
 * Types only, and no `node:` import: this file sits under both entry points.
 */

import type { PurposeSpec } from './types';

/** Two is one rotation in flight, as for a `KeyRing`. */
export const DEFAULT_PURPOSE_MAX_KEYS = 2;

const KID_PREFIX = /^[a-z]{2,8}$/;

/** A scope is appended after `:`; printable ASCII, no whitespace, no control characters. */
const SCOPE = /^[\x21-\x7e]{1,128}$/;

function purposeError(label: string, problem: string): Error
{
    return new Error(`Purpose ${label}: ${problem}`);
}

function isPositiveInteger(value: unknown): boolean
{
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Throw unless `spec` is a purpose this package can sign and verify for. */
export function assertPurposeSpec(label: string, spec: PurposeSpec): void
{
    if (!KID_PREFIX.test(spec.kidPrefix))
    {
        throw purposeError(label, 'kidPrefix must be 2-8 lowercase letters');
    }

    if (typeof spec.audience !== 'string' || spec.audience === '')
    {
        throw purposeError(label, 'audience must be a non-empty string');
    }

    if (!isPositiveInteger(spec.maxTtlSec))
    {
        throw purposeError(label, 'maxTtlSec must be a positive whole number of seconds');
    }

    if (spec.maxKeys !== undefined && !isPositiveInteger(spec.maxKeys))
    {
        throw purposeError(label, 'maxKeys must be a positive whole number');
    }

    if (spec.typ !== undefined && (typeof spec.typ !== 'string' || spec.typ === ''))
    {
        throw purposeError(label, 'typ must be a non-empty string when given');
    }
}

/**
 * The `aud` of a purpose's tokens: its audience, or `<audience>:<scope>` for
 * a scoped purpose. A scoped purpose without a scope, or an unscoped one given
 * a scope, is a caller mixing up two purposes — refused rather than guessed.
 */
export function purposeAudience(label: string, spec: PurposeSpec, scope: string | undefined): string
{
    if (!spec.scoped)
    {
        if (scope !== undefined)
        {
            throw purposeError(label, 'is not scoped, and was given a scope');
        }

        return spec.audience;
    }

    if (scope === undefined || !SCOPE.test(scope))
    {
        throw purposeError(label, 'is scoped: a scope of 1-128 printable ASCII characters is required');
    }

    return `${spec.audience}:${scope}`;
}

/**
 * Throw unless `kids` all belong to the purpose — `<kidPrefix>-…` — and there
 * are no more of them than it may hold.
 *
 * The dash is the boundary: without it `api` would claim `apix-1` as well.
 * The kids are counted, not quoted: a key configuration written in the wrong
 * order puts key material where the kid should be.
 */
export function assertPurposeKids(label: string, spec: PurposeSpec, kids: readonly string[]): void
{
    const owned = `${spec.kidPrefix}-`;
    const foreign = kids.filter((kid) => !kid.startsWith(owned) || kid.length === owned.length);
    const maxKeys = spec.maxKeys ?? DEFAULT_PURPOSE_MAX_KEYS;

    if (foreign.length > 0)
    {
        throw purposeError(label, `${foreign.length} of its kids do not start with "${owned}"`);
    }

    if (kids.length > maxKeys)
    {
        throw purposeError(label, `${kids.length} keys, and it may hold at most ${maxKeys}`);
    }
}
