/**
 * The machine-principal registry `machineAuth` dispatches on (#79).
 *
 * A machine credential is issued by a service to a non-interactive process and
 * its subject is an account or a tenant, not a person. Two things follow, and
 * both are structural here rather than a rule someone has to remember:
 *
 * A machine principal never enters `AuthContext`. It lives in its own context
 * key (`machinePrincipal`), is read by its own helper (`getMachinePrincipal`),
 * and is admitted by its own middleware. `getAuth(c)` keeps returning users
 * only, so a machine request cannot impersonate a user session — there is no
 * code path that would put it there. This generalizes `opsTokenAuth`, which is
 * the same shape hand-written for one credential (and which keeps its own
 * context key; it is not implemented on this registry).
 *
 * Ownership is not authentication. Who issued a machine token, and who may
 * revoke or audit it, is the registrant's data-level concern. What the request
 * acts as is the token's own subject and scopes, and nothing resolves a machine
 * subject to a user.
 *
 * Discrimination is by registered prefix — a raw `tokenPrefix` for opaque
 * secrets (the `spfn_ops_` shape) or a `kidPrefix` on the JOSE header of a JWS
 * (the `machine:runtime:` shape). Conflicts are refused at registration, so
 * first-match ambiguity is impossible by construction rather than resolved per
 * request. `authenticate` and `optionalAuth` consult the same discriminators to
 * refuse a machine credential before the user path examines it.
 *
 * Registration is a boot-time API. The registry is module state read on every
 * dispatch, so a verifier registered after requests started is simply a
 * verifier the requests before it did not have — the same contract
 * `registerAuthProfile` states, and for the same reason: an auth surface that
 * can be rearranged at runtime is a surface an app bug can rearrange. There is
 * no unregistration and no reset.
 *
 * @module server/middleware/machine-principals
 */
import type { Context, Next } from 'hono';
import { decodeProtectedHeader } from 'jose';

import { defineMiddleware, defineMiddlewareFactory } from '@spfn/core/route';
import { ForbiddenError, UnauthorizedError } from '@spfn/core/errors';

import { clientProofRefusalResponse } from '../client-proof/refusal-response';
import { authLogger } from '../logger';
import { optionKeys, readOptions } from '@spfn/core/options';
import { clientProofRefusalOf, selectAuthProfile } from './auth-profiles';

/** What a verified machine request acts as. Not a user, by construction. */
export interface MachinePrincipal
{
    /** e.g. 'account' | 'service' | registrant-defined */
    subjectType: string;
    subjectId: string;
    scopes: string[];
    /** verifier-defined extras (claims, token id for audit, …) */
    claims?: Record<string, unknown>;
    /** which registered verifier admitted it */
    scheme: string;
}

export interface MachineVerifierRegistration
{
    /** unique id; becomes MachinePrincipal.scheme */
    id: string;
    /** exactly one discriminator */
    match: { tokenPrefix: string } | { kidPrefix: string };
    verify(token: string, c: Context): Promise<MachinePrincipal>;
}

// Extend Hono context with the machine principal — a key of its own, never `auth`.
declare module 'hono'
{
    interface ContextVariableMap
    {
        machinePrincipal: MachinePrincipal;
    }
}

/** Read the verified machine principal a handler runs under. */
export function getMachinePrincipal(c: Context): MachinePrincipal | null
{
    return (c.get('machinePrincipal') as MachinePrincipal | undefined) ?? null;
}

// ---- the registry ----------------------------------------------------------

/** A registration normalized to what the dispatch needs: one prefix, one verify. */
interface MachineVerifierEntry
{
    id: string;
    prefix: string;
    verify(token: string, c: Context): Promise<MachinePrincipal>;
}

/** Kept apart so a request pays for the JOSE peek only when a kidPrefix exists. */
const TOKEN_PREFIX_VERIFIERS: MachineVerifierEntry[] = [];
const KID_PREFIX_VERIFIERS: MachineVerifierEntry[] = [];
const REGISTERED_IDS = new Set<string>();

type DiscriminatorKind = 'tokenPrefix' | 'kidPrefix';

/** Every key a `match` may name, either of the two discriminators. */
interface MatchOptions
{
    tokenPrefix?: unknown;
    kidPrefix?: unknown;
}

/** The discriminator as (kind, prefix) — null unless exactly one is named. */
function readDiscriminator(match: MachineVerifierRegistration['match'] | undefined): { kind: DiscriminatorKind; prefix: string } | null
{
    if (match === undefined)
    {
        return null;
    }

    // Read once, by `readOptions` (#477): a `match` inheriting its prefix, or
    // naming another key beside it, is refused rather than read as stated.
    const { tokenPrefix, kidPrefix } = readOptions<MatchOptions>(
        'registerMachineVerifier: match',
        match,
        optionKeys<MatchOptions>({ tokenPrefix: true, kidPrefix: true }),
    );

    if (tokenPrefix !== undefined && kidPrefix !== undefined)
    {
        return null;
    }
    if (typeof tokenPrefix === 'string' && tokenPrefix.length > 0)
    {
        return { kind: 'tokenPrefix', prefix: tokenPrefix };
    }
    if (typeof kidPrefix === 'string' && kidPrefix.length > 0)
    {
        return { kind: 'kidPrefix', prefix: kidPrefix };
    }

    return null;
}

/**
 * Two prefixes one of which would shadow the other.
 *
 * Equality is the degenerate case, so this one rule covers a duplicate
 * discriminator as well as `machine:` swallowing `machine:runtime:`.
 */
function prefixesCollide(a: string, b: string): boolean
{
    return a.startsWith(b) || b.startsWith(a);
}

/**
 * Registers a verifier for one machine credential namespace. Call it at boot.
 *
 * Refused at registration: a duplicate `id`, a `match` that does not name
 * exactly one non-empty discriminator, a verifier without a callable `verify`,
 * and — the point of the check — a discriminator that shadows or is shadowed by
 * an already-registered one of the same kind. Two verifiers a token could match
 * would make admission depend on registration order; that is a boot-time bug,
 * not something the dispatch should resolve on every request.
 *
 * @example
 * ```typescript
 * registerMachineVerifier({
 *     id: 'runtimeJwsV1',
 *     match: { kidPrefix: 'machine:runtime:' },
 *     verify: async (token) =>
 *     {
 *         const { payload } = await jwtVerify(token, RUNTIME_JWKS);
 *
 *         return {
 *             subjectType: 'account',
 *             subjectId: String(payload.sub),
 *             scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
 *             scheme: 'runtimeJwsV1',
 *         };
 *     },
 * });
 * ```
 */
export function registerMachineVerifier(reg: MachineVerifierRegistration): void
{
    // Each member read once (#477): the id, discriminator and function checked
    // are the ones registered. `reg` may be a class instance — `verify` is
    // bound to it — so it is not held to the plain-object rule; `match` is
    // plain data, and is.
    const { id, match, verify } = reg ?? ({} as Partial<MachineVerifierRegistration>);

    if (typeof id !== 'string' || id.length === 0)
    {
        throw new Error('registerMachineVerifier: id must be a non-empty string');
    }
    if (typeof verify !== 'function')
    {
        throw new Error(`registerMachineVerifier: '${id}' needs a verifier with a callable verify(token, c)`);
    }

    const discriminator = readDiscriminator(match);
    if (discriminator === null)
    {
        throw new Error(`registerMachineVerifier: '${id}' needs exactly one non-empty discriminator — { tokenPrefix } or { kidPrefix }`);
    }
    if (REGISTERED_IDS.has(id))
    {
        throw new Error(`registerMachineVerifier: '${id}' is already registered`);
    }

    const peers = discriminator.kind === 'tokenPrefix' ? TOKEN_PREFIX_VERIFIERS : KID_PREFIX_VERIFIERS;
    const shadowed = peers.find(peer => prefixesCollide(peer.prefix, discriminator.prefix));
    if (shadowed !== undefined)
    {
        throw new Error(
            `registerMachineVerifier: '${id}' ${discriminator.kind} '${discriminator.prefix}' `
            + `collides with '${shadowed.id}' — one prefix would shadow the other`,
        );
    }

    // Stored as a bound copy, as the auth-profile registry does: the checks
    // above passed on this discriminator and this function, and neither should
    // stay reassignable through the registrant's own reference afterwards.
    peers.push({ id, prefix: discriminator.prefix, verify: verify.bind(reg) });
    REGISTERED_IDS.add(id);
}

/**
 * The registered verifier a Bearer token belongs to, or null.
 *
 * With nothing registered this is two array-length checks — a deployment that
 * registers no machine verifier pays nothing and behaves exactly as before. The
 * JOSE header peek is unverified and runs only when a kidPrefix verifier is
 * registered; a token that is not a compact JWS names no namespace.
 */
export function findMachineVerifier(token: string): MachineVerifierEntry | null
{
    const byTokenPrefix = TOKEN_PREFIX_VERIFIERS.find(entry => token.startsWith(entry.prefix));
    if (byTokenPrefix !== undefined)
    {
        return byTokenPrefix;
    }
    if (KID_PREFIX_VERIFIERS.length === 0)
    {
        return null;
    }

    const kid = readProtectedKid(token);
    if (kid === null)
    {
        return null;
    }

    return KID_PREFIX_VERIFIERS.find(entry => kid.startsWith(entry.prefix)) ?? null;
}

/**
 * Whether a Bearer token names a registered machine namespace.
 *
 * What `authenticate` and `optionalAuth` ask before the user path decodes
 * anything. Machine kids are namespaced by convention (`machine:…`) and a user
 * session JWT never carries that shape, so the question has one answer per
 * token and no user credential is affected by it.
 */
export function matchesMachineDiscriminator(token: string): boolean
{
    return findMachineVerifier(token) !== null;
}

/** The `kid` of a compact JWS's protected header, unverified. */
function readProtectedKid(token: string): string | null
{
    try
    {
        const { kid } = decodeProtectedHeader(token);

        return typeof kid === 'string' ? kid : null;
    }
    catch
    {
        // Not a compact JWS, or a header that will not parse. Either way the
        // token names no machine namespace — the refusal is the caller's.
        return null;
    }
}

// ---- the middleware --------------------------------------------------------

/**
 * The one refusal this surface answers with.
 *
 * A missing credential, a user's session JWT, a token in a namespace nobody
 * registered, and a token whose verifier rejected all get this exact 401.
 * Whether a namespace is registered — and whether a presented token was ever
 * valid — is not inferable from the answer, the same non-disclosure rule the
 * ops-token table and the device-code NotFound design keep. 403 is reserved for
 * scope, where the caller is already authenticated.
 */
const MACHINE_REFUSAL_MESSAGE = 'Machine authentication required: Authorization: Bearer <token>';

function machineRefusal(): UnauthorizedError
{
    return new UnauthorizedError({ message: MACHINE_REFUSAL_MESSAGE });
}

/**
 * Admits a machine credential, or refuses. Sets `machinePrincipal`; `auth`
 * stays unset, so `getAuth(c)` is as empty here as on an anonymous request.
 *
 * Auto-skips the global 'auth' middleware, like `opsTokenAuth`.
 *
 * @example
 * ```typescript
 * export const ingest = route.post('/v1/ingest')
 *   .use([machineAuth, requireMachineScope('events:write')])
 *   .handler(async (c) => {
 *     const { subjectType, subjectId } = getMachinePrincipal(c.raw)!;
 *     // ...
 *   });
 * ```
 */
export const machineAuth = defineMiddleware('machineAuth', async (c, next) =>
{
    const refused = profileChannelRefusal(c);
    if (refused !== null)
    {
        return refused;
    }

    const token = extractBearer(c.req.header('Authorization'));
    if (token === null)
    {
        throw machineRefusal();
    }

    const entry = findMachineVerifier(token);
    if (entry === null)
    {
        throw machineRefusal();
    }

    const principal = await verifiedPrincipal(entry, token, c);
    if (principal === null)
    {
        throw machineRefusal();
    }

    c.set('machinePrincipal', principal);

    await next();

    return undefined;
}, { skips: ['auth'] });

/**
 * The profile channel's guard, reused rather than replicated: a request naming
 * `x-spfn-auth-profile` alongside a Bearer credential is refused as the mixture
 * before either channel looks at it. Null means the request is this
 * middleware's to answer — a verifier the dispatch selects belongs to the
 * profile channel and is never run here, because this middleware admits machine
 * tokens only and never produces an AuthContext.
 *
 * The refusal is built here rather than left to escape as a throw. Every
 * refusal surface answers through `clientProofRefusalResponse`, and a throw
 * would reach the generic error handler instead: the same status and the same
 * code, but without `requestId` and without the server's contract headers,
 * which is the divergence that rule exists to prevent (#106).
 */
function profileChannelRefusal(c: Context): Response | null
{
    try
    {
        selectAuthProfile(c);

        return null;
    }
    catch (err)
    {
        const refusal = clientProofRefusalOf(err);
        if (refusal === null)
        {
            throw err;
        }

        return clientProofRefusalResponse(c, refusal);
    }
}

/**
 * The principal a registrant's verifier resolved, or null for every outcome
 * that is not one.
 *
 * A verifier that rejected, a verifier that threw a bug of its own, a verifier
 * that resolved something which is not a principal, and a principal this code
 * cannot even read are one answer here, and the caller turns all of them into
 * the same generic 401. The registrant's error is logged and never serialized —
 * a stack trace from registrant code is not an authentication answer, a 500
 * would both leak it and read as "the credential was fine", and a silent pass
 * would admit an unauthenticated request.
 *
 * Reading the result is part of the verification, so it happens inside this
 * `try` too: a principal whose `scopes` is a throwing getter, or a Proxy that
 * refuses every read, is registrant code failing at exactly the moment a
 * refusal is due, and it must be indistinguishable from any other refusal
 * rather than a 500 carrying the registrant's own text.
 */
async function verifiedPrincipal(entry: MachineVerifierEntry, token: string, c: Context): Promise<MachinePrincipal | null>
{
    try
    {
        const principal = copyPrincipal(await entry.verify(token, c), entry.id);
        if (principal === null)
        {
            authLogger.middleware.error(`machine verifier '${entry.id}' resolved no principal`);
        }

        return principal;
    }
    catch (err)
    {
        authLogger.middleware.error(`machine verifier '${entry.id}' refused or failed`, err);

        return null;
    }
}

/**
 * A verifier's result as an own, plain-object principal — null if it is not one.
 *
 * Every declared field is read exactly once and copied. What the context holds
 * is then this module's own object: not the registrant's, which may answer a
 * second read differently, may keep changing after admission, and may carry
 * keys this interface does not declare. A later scope check must see what the
 * verifier was admitted on, not what it says at the moment it is asked.
 *
 * The copy is as deep as the type is: `scopes` is a string list, and `claims`
 * is arbitrary registrant data, so it is cloned whole. A `claims` the
 * structured-clone algorithm cannot copy — a function, a live handle — is not
 * something an audit trail could have kept anyway, and it refuses like any
 * other unusable result. `scheme` is the registry's answer, never the
 * verifier's: a verifier naming another verifier's id would make the audit
 * trail lie about which code admitted the request.
 */
function copyPrincipal(resolved: MachinePrincipal | null | undefined, scheme: string): MachinePrincipal | null
{
    const subjectType = resolved?.subjectType;
    const subjectId = resolved?.subjectId;
    const scopes = resolved?.scopes;
    const claims = resolved?.claims;

    if (typeof subjectType !== 'string' || subjectType.length === 0
        || typeof subjectId !== 'string' || subjectId.length === 0
        || !Array.isArray(scopes))
    {
        return null;
    }

    return {
        subjectType,
        subjectId,
        scopes: [...scopes],
        claims: claims === undefined ? undefined : structuredClone(claims),
        scheme,
    };
}

/**
 * Require the verified machine principal to carry every named scope.
 *
 * Fails closed: no principal in the context is a 401, not a pass — a route that
 * mounted this without `machineAuth` refuses rather than running unauthenticated,
 * exactly as `requireOpsScope` does. Scopes match exactly; there is no wildcard,
 * because what a scope string means belongs to the verifier that issued it.
 *
 * @example
 * ```ts
 * export const ingest = route.post('/v1/ingest')
 *     .use([machineAuth, requireMachineScope('events:write')])
 *     .handler(async () => { ... });
 * ```
 */
export const requireMachineScope = defineMiddlewareFactory('machineScope',
    (...scopes: string[]) => async (c: Context, next: Next) =>
    {
        const principal = getMachinePrincipal(c);

        if (!principal)
        {
            throw machineRefusal();
        }

        const granted = new Set(principal.scopes);
        const missing = scopes.filter(scope => !granted.has(scope));

        if (missing.length > 0)
        {
            throw new ForbiddenError({ message: `Machine principal lacks scope: ${missing.join(', ')}` });
        }

        await next();
    });

function extractBearer(header: string | undefined): string | null
{
    if (!header || !header.startsWith('Bearer '))
    {
        return null;
    }

    return header.substring(7);
}
