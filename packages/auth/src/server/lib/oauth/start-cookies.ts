/**
 * Per-start OAuth cookie names (#126)
 *
 * Every OAuth start writes two cookies — the sealed pending session and the CSRF
 * nonce — and each start gets its own pair, so a second tab's start no longer
 * overwrites the first's. The name is `<base>.<issuedAt>.<id>`:
 *
 * - `<base>` is `COOKIE_NAMES.OAUTH_PENDING` / `COOKIE_NAMES.OAUTH_CSRF`, port
 *   suffix included,
 * - `<issuedAt>` is the start time in seconds, base-36,
 * - `<id>` is the first 16 hex characters of SHA-256 over the start's keyId.
 *
 * Both halves stay inside the cookie-name token grammar, and neither the keyId
 * nor the nonce appears in a name. This module is the only place that builds or
 * reads such a name; every reader and writer goes through it.
 *
 * The callback runs in the API process, which may run under another `SPFN_PORT`
 * than the Next.js process that set the cookie, so lookups by keyId accept any
 * port suffix on the base. Listing for the cap and for logout does not: those
 * expire cookies, and a cookie under another suffix belongs to another instance.
 */

import { createHash } from 'node:crypto';

import { COOKIE_NAMES, OAUTH_COOKIE_STEMS } from '../config';

/** Which of the two cookies a start writes. */
export type OAuthStartCookieKind = keyof typeof OAUTH_COOKIE_STEMS;

/** A per-start cookie found in a jar. */
export interface OAuthStartCookie
{
    name: string;
    value: string;
    /** The base the name was built on, port suffix included. */
    base: string;
    /** Start time, seconds since the epoch. */
    issuedAt: number;
    /** First 16 hex characters of SHA-256 over the start's keyId. */
    id: string;
}

/** A cookie jar in any of the shapes the callers hold one: a Map, a record, `getAll()`. */
export type CookieJar = Iterable<readonly [string, string]> | Record<string, string>;

/** At most this many starts per base live in one browser at once. */
export const MAX_OAUTH_STARTS = 5;

/** Built once per kind: the stem, an optional port suffix, base-36 time, 16 hex. */
const NAME_PATTERNS: Record<OAuthStartCookieKind, RegExp> = {
    pending: new RegExp(`^(${OAUTH_COOKIE_STEMS.pending}(?:_\\d+)?)\\.([0-9a-z]{1,11})\\.([0-9a-f]{16})$`),
    csrf: new RegExp(`^(${OAUTH_COOKIE_STEMS.csrf}(?:_\\d+)?)\\.([0-9a-z]{1,11})\\.([0-9a-f]{16})$`),
};

/** The legacy fixed name under any port suffix. */
const LEGACY_PATTERNS: Record<OAuthStartCookieKind, RegExp> = {
    pending: new RegExp(`^${OAUTH_COOKIE_STEMS.pending}(?:_\\d+)?$`),
    csrf: new RegExp(`^${OAUTH_COOKIE_STEMS.csrf}(?:_\\d+)?$`),
};

/** The base under this process's port suffix — the legacy fixed name. */
export function startCookieBase(kind: OAuthStartCookieKind): string
{
    return kind === 'pending' ? COOKIE_NAMES.OAUTH_PENDING : COOKIE_NAMES.OAUTH_CSRF;
}

/** The `<id>` segment for a start's keyId. */
export function startCookieId(keyId: string): string
{
    return createHash('sha256').update(keyId).digest('hex').slice(0, 16);
}

/** The name a start made at `issuedAtMs` writes its `kind` cookie under. */
export function buildStartCookieName(kind: OAuthStartCookieKind, keyId: string, issuedAtMs: number = Date.now()): string
{
    const issuedAt = Math.floor(issuedAtMs / 1000).toString(36);

    return `${startCookieBase(kind)}.${issuedAt}.${startCookieId(keyId)}`;
}

/** A per-start name taken apart, or null for anything else. Never throws. */
export function parseStartCookieName(
    kind: OAuthStartCookieKind,
    name: string,
): Pick<OAuthStartCookie, 'base' | 'issuedAt' | 'id'> | null
{
    const match = NAME_PATTERNS[kind].exec(name);

    return match ? { base: match[1], issuedAt: parseInt(match[2], 36), id: match[3] } : null;
}

function entriesOf(jar: CookieJar): Iterable<readonly [string, string]>
{
    return Symbol.iterator in jar
        ? jar as Iterable<readonly [string, string]>
        : Object.entries(jar as Record<string, string>);
}

/** Every per-start cookie of `kind` in the jar, any port suffix, oldest first. */
export function listStartCookies(kind: OAuthStartCookieKind, jar: CookieJar): OAuthStartCookie[]
{
    const found: OAuthStartCookie[] = [];

    for (const [name, value] of entriesOf(jar))
    {
        const parsed = parseStartCookieName(kind, name);

        if (parsed)
        {
            found.push({ name, value, ...parsed });
        }
    }

    return found.sort((a, b) => a.issuedAt - b.issuedAt || a.name.localeCompare(b.name));
}

/** The per-start cookies of `kind` under this process's own base, oldest first. */
export function listOwnStartCookies(kind: OAuthStartCookieKind, jar: CookieJar): OAuthStartCookie[]
{
    const base = startCookieBase(kind);

    return listStartCookies(kind, jar).filter(cookie => cookie.base === base);
}

/** The start cookie of `kind` written for `keyId`, under any port suffix and any issuedAt. */
export function findStartCookie(kind: OAuthStartCookieKind, jar: CookieJar, keyId: string): OAuthStartCookie | undefined
{
    const id = startCookieId(keyId);

    return listStartCookies(kind, jar).find(cookie => cookie.id === id);
}

/** Cookies under the legacy fixed name of `kind`, any port suffix. */
export function legacyStartCookies(kind: OAuthStartCookieKind, jar: CookieJar): { name: string; value: string }[]
{
    return [...entriesOf(jar)]
        .filter(([name]) => LEGACY_PATTERNS[kind].test(name))
        .map(([name, value]) => ({ name, value }));
}

/**
 * Every name of `kind` this process may expire: the legacy fixed name and each
 * per-start cookie under its own base. For logout and the clearing helpers.
 */
export function ownStartCookieNames(kind: OAuthStartCookieKind, jar: CookieJar): string[]
{
    return [startCookieBase(kind), ...listOwnStartCookies(kind, jar).map(cookie => cookie.name)];
}

/**
 * The pending cookie for `keyId`: that start's own, else the legacy fixed name
 * when the jar holds it. Whether the legacy cookie is for `keyId` is only known
 * once it is unsealed, so callers check the unsealed keyId themselves.
 */
export function pendingCookieFor(jar: CookieJar, keyId: unknown): { name: string; value: string } | undefined
{
    const perStart = typeof keyId === 'string' && keyId ? findStartCookie('pending', jar, keyId) : undefined;
    const legacyName = startCookieBase('pending');

    return perStart
        ? { name: perStart.name, value: perStart.value }
        : legacyStartCookies('pending', jar).find(cookie => cookie.name === legacyName);
}

/**
 * The names a start must expire so that, with its own pair added, at most
 * `MAX_OAUTH_STARTS` of `kind` remain: the oldest by `issuedAt`.
 */
export function namesEvictedByStart(kind: OAuthStartCookieKind, jar: CookieJar): string[]
{
    const own = listOwnStartCookies(kind, jar);
    const excess = own.length + 1 - MAX_OAUTH_STARTS;

    return excess > 0 ? own.slice(0, excess).map(cookie => cookie.name) : [];
}

/**
 * Every OAuth CSRF cookie candidate in the jar — the legacy name and every
 * per-start name, under any port suffix.
 *
 * @deprecated The callback routes pick the one cookie a state names
 * (`findStartCookie`); this list is kept for apps that imported it.
 */
export function matchOAuthCsrfCookies(cookies: Record<string, string>): { name: string; value: string }[]
{
    return [
        ...legacyStartCookies('csrf', cookies),
        ...listStartCookies('csrf', cookies).map(({ name, value }) => ({ name, value })),
    ];
}
