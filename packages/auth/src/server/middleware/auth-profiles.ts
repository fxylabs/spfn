/**
 * The auth-profile registry the authenticate middleware dispatches on.
 *
 * A request that names `x-spfn-auth-profile` is answered by the verifier
 * registered for that profile — an O(1) map lookup, never a per-profile if
 * chain in the middleware body. A request that names no profile falls through
 * to the existing Bearer path untouched.
 *
 * Every verifier converges on the same `AuthContext` the Bearer path sets, so
 * downstream permission/tenant code consumes one principal shape and never
 * branches on how it was authenticated.
 *
 * An app adds its own scheme with `registerAuthProfile` at boot. The dispatch
 * it joins is the one below, unchanged: a name nobody registered is still
 * refused, and profile credentials mixed with an Authorization header are
 * still refused before either path runs.
 *
 * The clientProofV1 verifier reuses the phase-1 admission pieces (header
 * shape, canonical body, proof-input assembly, ECDSA verification) with two
 * production substitutions: the key directory is `user_public_keys` via
 * `keysRepository`, and the replay ledger is the pluggable store from
 * `client-proof/replay-store` (memory default, Redis opt-in). The admission
 * order is the contract's — revocation → session → expiry → replay → proof —
 * and the non-disclosure rule holds: an unregistered keyId shares
 * PROOF_INVALID with a failed signature, while a revoked or expired key
 * answers SESSION_REVOKED before the proof is ever examined.
 *
 * @module server/middleware/auth-profiles
 */
import type { Context } from 'hono';

import { attestedClientIp } from '../lib/device-provenance';
import {
    SerializableError,
    ServiceUnavailableError,
    UnauthorizedError,
    type SerializedError,
} from '@spfn/core/errors';

import type { User } from '@spfn/auth/server';
import {
    authLogger,
    keysRepository,
    findUserWithEffectiveRole,
    userProfilesRepository,
    getPendingDeletionInfo,
} from '@spfn/auth/server';
import { AccountDisabledError, AccountPendingDeletionError } from '@spfn/auth/errors';

import {
    CLIENT_PROOF_HEADERS,
    isRequestContentType,
    readCredentials,
    type ClientProofCredentials,
} from '../client-proof/admission';
import { isCanonicalBytes, parseCanonicalJson, type CanonicalValue } from '../client-proof/canonical-json';
import {
    ABSENT_BODY_SHA256,
    CLIENT_PROOF_PROFILE,
    DEFAULT_REPLAY_WINDOW_MILLIS,
    ProofInputError,
    parseClientProofPublicKey,
    sha256Hex,
    verifyClientProof,
    type ClientProofInput,
} from '../client-proof/proof';
import { ClientProofRefusal } from '../client-proof/refusal';
import { clientProofRefusalResponse } from '../client-proof/refusal-response';
import { getClientProofReplayStore } from '../client-proof/replay-store';
import { readContextClientIdentity } from '../client-proof/version-middleware';

/** What a verified request leaves in the context — one shape for every scheme. */
export interface AuthContext
{
    user: User;
    userId: string;
    keyId: string;
    role: string | null;
    locale: string;

    /**
     * How the principal was authenticated. Informational — downstream code
     * never branches on it. The union stays open for the profiles an app
     * registers itself: the built-in names keep their autocomplete, and a
     * registered profile names its own scheme without editing this file.
     */
    scheme: 'bearer' | 'clientProofV1' | 'oneTimeToken' | (string & {});
}

/** A profile's verifier: admits the request and returns the principal, or throws. */
export interface AuthProfileVerifier
{
    verify(c: Context): Promise<AuthContext>;
}

/**
 * Routes a request to its profile verifier.
 *
 * - no profile header → null: the caller continues on the Bearer path;
 * - profile header + Authorization header → rejected (mixing prohibited);
 * - unknown profile value → rejected (unknownProfilePolicy: reject).
 *
 * Shared by authenticate and optionalAuth so "presented but invalid" refuses
 * identically on both — only the "presented nothing" outcome differs.
 */
export function selectAuthProfile(c: Context): AuthProfileVerifier | null
{
    const profile = c.req.header(CLIENT_PROOF_HEADERS.profile);
    if (profile === undefined)
    {
        return null;
    }
    if (c.req.header('Authorization') !== undefined)
    {
        throw refusalError(ClientProofRefusal.credentialsMixed());
    }
    const verifier = AUTH_PROFILE_VERIFIERS.get(profile);
    if (verifier === undefined)
    {
        throw refusalError(ClientProofRefusal.profileRejected());
    }

    return verifier;
}

/**
 * Loads the user for an authenticated key and applies the account-status
 * rules. One implementation for every scheme: the Bearer path and the profile
 * verifiers call this, so a status added here gates both identically.
 */
export async function resolveAuthenticatedUser(userId: number): Promise<{
    user: User;
    role: string | null;
    locale: string;
}>
{
    const [result, locale] = await Promise.all([
        findUserWithEffectiveRole(userId),
        userProfilesRepository.findLocaleByUserId(userId),
    ]);
    if (!result)
    {
        throw new UnauthorizedError({ message: 'User not found' });
    }

    const { user, role } = result;

    // Status can be: active, inactive, suspended, pending_deletion, deleted
    if (user.status !== 'active')
    {
        if (user.status === 'pending_deletion')
        {
            const pending = await getPendingDeletionInfo(user.id);
            throw new AccountPendingDeletionError({ purgeScheduledAt: pending?.purgeScheduledAt.toISOString() });
        }

        throw new AccountDisabledError({ status: user.status });
    }

    return { user, role: role?.name ?? null, locale };
}

// ---- clientProofV1 ---------------------------------------------------------

/**
 * A contract refusal travelling as a throw.
 *
 * The verifier is a function that returns a principal, so a refusal has to
 * leave it as an exception — but a proven call is answered by a generated SDK
 * that classifies by `error.code` alone. Wrapping the refusal in an ordinary
 * error class made `error.code` read `UnauthorizedError`, a code no SDK knows
 * (#106). `runAuthProfile` catches this carrier and answers with the contract
 * envelope instead, so the wrapper never reaches the wire.
 *
 * It is a SerializableError all the same, for a caller that drives
 * `selectAuthProfile` itself and lets the throw escape: `__type` carries the
 * contract code rather than this class's name, because the error handler mints
 * `error.code` from `__type` and the contract code is the only value that
 * classifies this failure.
 */
class ClientProofRefusalError extends SerializableError
{
    readonly statusCode: number;

    constructor(readonly refusal: ClientProofRefusal)
    {
        super(refusal.message);
        this.name = 'ClientProofRefusalError';
        this.statusCode = refusal.httpStatus;
    }

    toJSON(): SerializedError
    {
        return { __type: this.refusal.code, message: this.message };
    }
}

/** The contract refusal as the middleware's error vocabulary. */
function refusalError(refusal: ClientProofRefusal): Error
{
    return new ClientProofRefusalError(refusal);
}

/**
 * The contract refusal a throw from `selectAuthProfile` carries, or null.
 *
 * For a surface that drives the dispatch itself rather than through
 * `runAuthProfile` — `machineAuth` does, because running a profile verifier on
 * a route that admits machines only would authenticate a user there. Such a
 * surface still answers through `clientProofRefusalResponse` like every other:
 * letting the carrier escape produces the same status and the same code, but
 * through the generic error handler, so without `requestId` and without the
 * server's contract headers (see refusal-response).
 */
export function clientProofRefusalOf(err: unknown): ClientProofRefusal | null
{
    return err instanceof ClientProofRefusalError ? err.refusal : null;
}

/** What the profile path produced for one request. */
export type AuthProfileOutcome =
    | { kind: 'none' }
    | { kind: 'authenticated'; auth: AuthContext }
    | { kind: 'refused'; response: Response };

/**
 * The profile path from dispatch to answer — what `authenticate` and
 * `optionalAuth` both run before their own Bearer code.
 *
 * `none` means the request named no profile and the caller continues on the
 * Bearer path. A refusal comes back as a built response rather than a throw:
 * the answer a proven call gets is the contract's own envelope, and an error
 * handed to the generic error handler is classified by its class name instead.
 */
export async function runAuthProfile(c: Context): Promise<AuthProfileOutcome>
{
    try
    {
        const verifier = selectAuthProfile(c);
        if (verifier === null)
        {
            return { kind: 'none' };
        }

        // What the verifier resolved has to be a principal. `null` is the JS
        // idiom for "no user", and taken at face value it would set `auth` to
        // null and call the route: authenticated everywhere downstream, a 500
        // in the handler. A resolve that carries no userId is a refusal, and
        // it leaves here as one — the same throw the verifier's own refusal
        // takes, so `optionalAuth` cannot downgrade it to anonymous passage.
        const auth = await verifier.verify(c);
        if (!auth?.userId)
        {
            throw new UnauthorizedError({ message: 'Auth profile verifier returned no principal' });
        }

        return { kind: 'authenticated', auth };
    }
    catch (err)
    {
        if (err instanceof ClientProofRefusalError)
        {
            return { kind: 'refused', response: clientProofRefusalResponse(c, err.refusal) };
        }

        throw err;
    }
}

/**
 * The replay store, fail-closed: a store that cannot answer refuses the
 * request. An auth surface does not fail open when its ledger is unreachable.
 */
async function failClosed<T>(operation: () => Promise<T>): Promise<T>
{
    try
    {
        return await operation();
    }
    catch (err)
    {
        authLogger.middleware.error('client-proof replay store unavailable — refusing (fail-closed)', err);
        throw new ServiceUnavailableError({ message: 'Authentication is temporarily unavailable' });
    }
}

/**
 * The middleware surface is sessionless: a proof admits exactly one request,
 * so `x-spfn-session` never travels here and `requiresSession` is false for
 * every operation authenticated this way.
 */
async function verifyClientProofProfile(c: Context): Promise<AuthContext>
{
    const headers = c.req.raw.headers;
    const credentials = readCredentials(headers);
    if (credentials === null)
    {
        throw refusalError(ClientProofRefusal.malformedHeaders());
    }
    if (credentials.profile !== CLIENT_PROOF_PROFILE)
    {
        throw refusalError(ClientProofRefusal.profileRejected());
    }
    if (credentials.sessionId !== null)
    {
        throw refusalError(ClientProofRefusal.sessionHeaderMisplaced());
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    const proofInput: ClientProofInput = {
        method: c.req.method,
        path: c.req.path,
        clientId: credentials.clientId,
        keyId: credentials.keyId,
        nonce: credentials.nonce,
        issuedAtMillis: credentials.issuedAtMillis,
        bodySha256: admitBodySha256(headers, body),
    };

    // 1. Revocation, before anything the proof could explain. A key that was
    //    registered and then revoked — or aged past its TTL — answers
    //    SESSION_REVOKED here. A keyId that was *never* registered does not:
    //    it falls through to the proof step and shares PROOF_INVALID with a
    //    failed signature, so whether a keyId exists is not inferable from
    //    the refusal (the same non-disclosure the dev surface keeps).
    const keyRecord = await keysRepository.findByKeyId(credentials.keyId);
    if (keyRecord !== null)
    {
        if (!keyRecord.isActive)
        {
            throw refusalError(ClientProofRefusal.sessionRevoked());
        }
        if (keyRecord.expiresAt && new Date() > keyRecord.expiresAt)
        {
            throw refusalError(ClientProofRefusal.sessionRevoked());
        }
    }

    // 2. (Session — nothing to check: this surface is sessionless and the
    //    session header was already refused above.)

    // 3. The replay window, judged against this server's clock.
    const age = Date.now() - Number(credentials.issuedAtMillis);
    if (age < 0 || age > DEFAULT_REPLAY_WINDOW_MILLIS)
    {
        throw refusalError(ClientProofRefusal.proofExpired());
    }

    // 4. One acceptance per (clientId, nonce) inside that window.
    const replayStore = getClientProofReplayStore();
    if (await failClosed(() => replayStore.isSpent(credentials.clientId, credentials.nonce)))
    {
        throw refusalError(ClientProofRefusal.proofReplayed());
    }

    // 5. The proof itself, last, so the answers above stay distinguishable.
    if (keyRecord === null)
    {
        throw refusalError(ClientProofRefusal.proofInvalid());
    }
    // clientId identifies the key owner on this surface — the profile's
    // counterpart of the identity a web JWT carries. A proof presenting
    // someone else's key, however validly signed, shares PROOF_INVALID with
    // an unregistered keyId and a failed signature (non-disclosure: the
    // refusal reveals nothing about the key's existence or owner). Exact
    // string comparison, no normalization.
    if (credentials.clientId !== String(keyRecord.userId))
    {
        throw refusalError(ClientProofRefusal.proofInvalid());
    }
    verifyProofOrThrow(proofInput, credentials, keyRecord.publicKey);

    // 6. Spend the nonce — only now, on admission. `spend` is check-and-set:
    //    losing the race to a concurrent request with the same nonce is a
    //    replay, not a second acceptance.
    if (!await failClosed(() => replayStore.spend(credentials.clientId, credentials.nonce)))
    {
        throw refusalError(ClientProofRefusal.proofReplayed());
    }

    // 7. The same user-status path the Bearer scheme takes.
    const { user, role, locale } = await resolveAuthenticatedUser(keyRecord.userId);

    // Fire-and-forget, as the Bearer path does — and with the address under the
    // same rule, so this surface neither erases `last_seen_ip` on every throttle
    // window nor writes one a proxy did not attest.
    keysRepository.updateLastUsedById(keyRecord.id, readContextClientIdentity(c), attestedClientIp(c))
        .catch((err: unknown) => authLogger.middleware.error('Failed to update lastUsedAt', err));

    authLogger.middleware.info('API access', {
        userId: user.id,
        email: user.email,
        keyId: credentials.keyId,
        scheme: CLIENT_PROOF_PROFILE,
        method: c.req.method,
        path: c.req.path,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        userAgent: c.req.header('user-agent'),
    });

    return {
        user,
        userId: String(user.id),
        keyId: credentials.keyId,
        role,
        locale,
        scheme: 'clientProofV1',
    };
}

/**
 * `bodySha256` for the presented body: the canonical-bytes rule when a body
 * is present, the absent-body constant when it is not. A body without the
 * contract content type, or bytes that are not the canonical form of what
 * they parse to, are contract violations — the proof would bind bytes the
 * two ends disagree about.
 */
function admitBodySha256(headers: Headers, body: Uint8Array): string
{
    if (body.length === 0)
    {
        return ABSENT_BODY_SHA256;
    }
    if (!isRequestContentType(headers.get('content-type')))
    {
        throw refusalError(ClientProofRefusal.missingContentType());
    }

    let value: CanonicalValue;
    try
    {
        value = parseCanonicalJson(body);
    }
    catch
    {
        throw refusalError(ClientProofRefusal.bodyNotCanonical());
    }
    if (!isCanonicalBytes(body, value))
    {
        throw refusalError(ClientProofRefusal.bodyNotCanonical());
    }

    return sha256Hex(body);
}

function verifyProofOrThrow(
    proofInput: ClientProofInput,
    credentials: ClientProofCredentials,
    publicKeySpkiDerBase64: string,
): void
{
    let verified: boolean;
    try
    {
        // A registered key that is not P-256 (the directory also holds RS256
        // web keys) can never verify a clientProofV1 proof: PROOF_INVALID,
        // through the same catch as a malformed stored key.
        const publicKey = parseClientProofPublicKey(publicKeySpkiDerBase64);
        verified = verifyClientProof(proofInput, credentials.proof, publicKey);
    }
    catch (err)
    {
        if (err instanceof ProofInputError)
        {
            // A C0 control character in a header field makes the proof input
            // unassemblable — a contract violation, never a proof answer.
            throw refusalError(ClientProofRefusal.unprocessable());
        }
        throw refusalError(ClientProofRefusal.proofInvalid());
    }
    if (!verified)
    {
        throw refusalError(ClientProofRefusal.proofInvalid());
    }
}

/** profile name → verifier. Registration is the only way to add a scheme. */
const AUTH_PROFILE_VERIFIERS: Map<string, AuthProfileVerifier> = new Map([
    [CLIENT_PROOF_PROFILE, { verify: verifyClientProofProfile }],
]);

/**
 * Registers an app's own verifier under a profile name.
 *
 * Call it at boot, before the first request: the registry is a module-global
 * read on every dispatch, so a profile registered later is simply a profile
 * the requests before it did not have. There is no freeze and no
 * unregistration — an auth surface that can be rearranged at runtime is a
 * surface an app bug can rearrange.
 *
 * A duplicate name throws rather than replacing the verifier that holds it,
 * `clientProofV1` included. A silent override is how a second import order, or
 * a copied profile name, quietly swaps the code that decides who is admitted.
 *
 * The verifier must expose a callable `verify` — a value that cannot admit
 * anyone is refused at boot rather than becoming a registry entry the dispatch
 * reads as "no profile header", which is anonymous passage under
 * `optionalAuth` for a request that presented profile credentials.
 *
 * The verifier returns the same `AuthContext` the Bearer path sets and refuses
 * by throwing. A resolve that carries no `userId` is refused as a throw too —
 * "no user" is a refusal, never a principal. A throw is not caught here:
 * `runAuthProfile` answers the internal clientProofV1 contract refusal and
 * nothing else, so a verifier's own error reaches the app's generic error
 * handler exactly as the Bearer path's `UnauthorizedError` does — and never
 * becomes anonymous passage, not even under `optionalAuth`.
 *
 * @example
 * ```typescript
 * registerAuthProfile('serviceTokenV1', {
 *     verify: async (c) =>
 *     {
 *         const user = await authenticateServiceToken(c.req.header('x-acme-service-token'));
 *         if (user === null)
 *         {
 *             throw new UnauthorizedError({ message: 'Invalid service token' });
 *         }
 *
 *         return { user, userId: String(user.id), keyId: 'service', role: null, locale: 'en', scheme: 'serviceTokenV1' };
 *     },
 * });
 * ```
 */
export function registerAuthProfile(profileId: string, verifier: AuthProfileVerifier): void
{
    if (typeof profileId !== 'string' || profileId.length === 0)
    {
        throw new Error('registerAuthProfile: profileId must be a non-empty string');
    }
    if (typeof verifier?.verify !== 'function')
    {
        throw new Error(`registerAuthProfile: auth profile '${profileId}' needs a verifier with a callable verify(c)`);
    }
    if (AUTH_PROFILE_VERIFIERS.has(profileId))
    {
        throw new Error(`registerAuthProfile: auth profile '${profileId}' is already registered`);
    }

    // Stored as a bound copy, not the caller's object: `.set(profileId, verifier)`
    // would leave the admitting code reassignable through the registrant's own
    // reference, which is the silent override the duplicate-name throw exists
    // to prevent. The bind keeps `this` for a method-style or class verifier.
    // What the copy fixes is the `verify` function, not what it decides: a class
    // verifier that consults its own mutable state through that function still
    // changes behaviour when the registrant mutates it. This is a footgun guard
    // against an accidental reassignment, not an immutability guarantee.
    AUTH_PROFILE_VERIFIERS.set(profileId, { verify: verifier.verify.bind(verifier) });
}
