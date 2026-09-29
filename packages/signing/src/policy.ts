/**
 * The claim policies a caller opts into: `issuedWithinSec`, `issuer` and
 * `audience`.
 *
 * They run after every check `verifyJws()` made before they existed, so they
 * never change the reason a token was already refused for — they only turn
 * some tokens that were `ok` into refusals. A caller that sets none of them
 * never reaches this file's token half: `aud` and `iss` are not even read.
 *
 * The options themselves are configuration and are read first, before the
 * token: an unanchored `rest` throws on every call, not only on the calls
 * whose token happened to get that far.
 */

import type {
    AudiencePrefix,
    JwsPayload,
    VerifyFailureReason,
    VerifyOptions,
} from './types';

/** The options, checked and compiled. */
export interface ClaimPolicy
{
    issuedWithinSec?: number;
    issuers?: readonly string[];
    audiences?: readonly string[];
    prefix?: AudiencePrefix;
}

/** What the policy says about a token: a refusal, or the `aud` value it matched. */
export type PolicyVerdict = { ok: false; reason: VerifyFailureReason } | { audience?: string };

/** `rest` as it is evaluated — `^(?:source)$` — compiled once per expression. */
const COMPILED_REST = new WeakMap<RegExp, RegExp>();

/** A source that ends in a `$` no backslash escapes. */
const ENDS_ANCHORED = /(?:^|[^\\])(?:\\\\)*\$$/;

function configError(problem: string): Error
{
    return new Error(`verifyJws: ${problem}`);
}

/** A string or a non-empty list of them, every one non-empty. */
function stringList(value: unknown, option: string): readonly string[]
{
    const list = typeof value === 'string' ? [value] : value;
    const valid = Array.isArray(list)
        && list.length > 0
        && list.every((item) => typeof item === 'string' && item !== '');

    if (!valid)
    {
        throw configError(`${option} must be a non-empty string or a non-empty array of them`);
    }

    return list as readonly string[];
}

/**
 * Check `rest` and compile the form it is evaluated in.
 *
 * The source check is the contract — an unanchored expression is refused, so
 * `…/register/x/../report` cannot pass a pattern that only had to *contain*
 * a match. The wrapper is the guarantee: `^a|b$` starts and ends with anchors
 * and still matches anything ending in `b`, so the expression runs as
 * `^(?:^a|b$)$`. Only `u` or `v` may be set: `g` and `y` make `test()`
 * stateful, `m` lets `$` stop at a newline inside the remainder, `i` and `s`
 * widen what a character class the caller wrote admits, and `d` is not a
 * matching flag at all.
 */
function compiledRest(rest: unknown): RegExp
{
    const valid = rest instanceof RegExp
        && rest.source.startsWith('^')
        && ENDS_ANCHORED.test(rest.source)
        && /^[uv]?$/.test(rest.flags);

    if (!valid)
    {
        throw configError('audience.rest must be a RegExp anchored as ^…$, with no flag but u or v');
    }

    const compiled = COMPILED_REST.get(rest) ?? new RegExp(`^(?:${rest.source})$`, rest.flags);

    COMPILED_REST.set(rest, compiled);

    return compiled;
}

function audiencePolicy(audience: NonNullable<VerifyOptions['audience']>): ClaimPolicy
{
    if (typeof audience === 'string' || Array.isArray(audience))
    {
        return { audiences: stringList(audience, 'audience') };
    }

    const { prefix, rest } = (audience ?? {}) as AudiencePrefix;

    if (typeof prefix !== 'string' || prefix === '')
    {
        throw configError('audience.prefix must be a non-empty string');
    }

    return { prefix: { prefix, rest: compiledRest(rest) } };
}

/**
 * Read the three options, or return `null` when none is set — which is what
 * keeps a caller who sets none of them on exactly the path they were on.
 */
export function readClaimPolicy(options: VerifyOptions): ClaimPolicy | null
{
    const { issuedWithinSec, issuer, audience } = options;

    if (issuedWithinSec === undefined && issuer === undefined && audience === undefined)
    {
        return null;
    }

    if (issuedWithinSec !== undefined && !(Number.isFinite(issuedWithinSec) && issuedWithinSec >= 0))
    {
        throw configError('issuedWithinSec must be a finite number of seconds, zero or more');
    }

    return {
        issuedWithinSec,
        ...(issuer === undefined ? {} : { issuers: stringList(issuer, 'issuer') }),
        ...(audience === undefined ? {} : audiencePolicy(audience)),
    };
}

/**
 * `issuedWithinSec`: `iat` no older than that, and no newer than the skew.
 *
 * `iat` is a finite number or absent by now — anything else was already
 * `invalid-claims`. A future `iat` is refused for the reason `maxAgeSec`
 * refuses one: a token dated ahead carries its acceptance window with it.
 */
function issuedFailure(
    payload: JwsPayload,
    within: number,
    nowSec: number,
    skew: number,
): VerifyFailureReason | null
{
    const iat = payload.iat as number | undefined;

    if (iat === undefined)
    {
        return 'no-expiry';
    }

    if (iat > nowSec + skew)
    {
        return 'not-yet-valid';
    }

    return nowSec - iat > within + skew ? 'too-old' : null;
}

function issuerFailure(payload: JwsPayload, issuers: readonly string[]): VerifyFailureReason | null
{
    if (payload.iss === undefined)
    {
        return 'no-issuer';
    }

    if (typeof payload.iss !== 'string')
    {
        return 'invalid-claims';
    }

    return issuers.includes(payload.iss) ? null : 'wrong-issuer';
}

/**
 * `aud` as a list (RFC 7519 §4.1.3 allows a string or an array of them), or
 * the reason it cannot be one. An empty array names nobody, so it is as
 * absent as no `aud` at all; one non-string member makes the claim broken.
 */
function audienceValues(aud: unknown): string[] | VerifyFailureReason
{
    const values = typeof aud === 'string' ? [aud] : aud;

    if (aud === undefined || (Array.isArray(values) && values.length === 0))
    {
        return 'no-audience';
    }

    return Array.isArray(values) && values.every((value) => typeof value === 'string')
        ? values
        : 'invalid-claims';
}

/** The remainder after `prefix`, which must be non-empty and match `rest` in full. */
function prefixMatches(value: string, { prefix, rest }: AudiencePrefix): boolean
{
    const remainder = value.slice(prefix.length);

    return value.startsWith(prefix) && remainder !== '' && rest.test(remainder);
}

function audienceVerdict(payload: JwsPayload, policy: ClaimPolicy): PolicyVerdict
{
    const values = audienceValues(payload.aud);

    if (!Array.isArray(values))
    {
        return { ok: false, reason: values };
    }

    const matched = values.find((value) => (policy.prefix
        ? prefixMatches(value, policy.prefix)
        : policy.audiences!.includes(value)));

    return matched === undefined ? { ok: false, reason: 'wrong-audience' } : { audience: matched };
}

/**
 * Apply the policy, in its order: `issuedWithinSec`, then `issuer`, then
 * `audience`. `nowSec` and `skew` are the ones the time claims were judged by.
 */
export function applyClaimPolicy(
    payload: JwsPayload,
    policy: ClaimPolicy,
    nowSec: number,
    skew: number,
): PolicyVerdict
{
    const within = policy.issuedWithinSec;
    const reason = (within === undefined ? null : issuedFailure(payload, within, nowSec, skew))
        ?? (policy.issuers ? issuerFailure(payload, policy.issuers) : null);

    if (reason)
    {
        return { ok: false, reason };
    }

    return policy.audiences || policy.prefix ? audienceVerdict(payload, policy) : {};
}
