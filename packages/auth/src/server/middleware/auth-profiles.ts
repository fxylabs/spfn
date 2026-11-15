/**
 * The auth-profile registry the authenticate middleware dispatches on.
 *
 * A request that names `x-spfn-auth-profile` is answered by the verifier
 * registered for that profile — an O(1) map lookup, never a per-profile if
 * chain in the middleware body. A request that names no profile falls through
 * to the existing Bearer path untouched.
 *
 * A verifier only establishes who presented what: it answers an identity —
 * the account and the key — and `runAuthProfile` hands that to
 * `admitPrincipal`, which decides whether the person may be let in and builds
 * the same `AuthContext` the Bearer path sets. Downstream permission/tenant
 * code consumes one principal shape and never branches on how it was
 * authenticated.
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
import { keyLiveness } from '../lib/key-liveness';
import {
    SerializableError,
    ServiceUnavailableError,
    UnauthorizedError,
    type SerializedError,
} from '@spfn/core/errors';

import { authLogger, keysRepository } from '@spfn/auth/server';
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
import {
    admissionRefusalError,
    admitPrincipal,
    authContextFor,
    type AdmissionRefusal,
    type AuthContext,
    type AuthScheme,
} from '../services/admission.service';

export type { AuthContext } from '../services/admission.service';

/**
 * Who a profile's verifier found behind the request: the account, the key it
 * names for it, and the scheme. Not a principal — `runAuthProfile` admits it.
 */
export interface AuthProfileIdentity
{
    userId: string;
    keyId: string;
    /**
     * How the principal was authenticated. Informational — downstream code
     * never branches on it. The union stays open for the profiles an app
     * registers itself.
     */
    scheme: AuthScheme;
}

/** A profile's verifier: establishes who presented the request, or throws. */
export interface AuthProfileVerifier
{
    verify(c: Context): Promise<AuthProfileIdentity>;
}

/** A registered profile: admits the request it names and answers the principal, or throws. */
export interface AuthProfile
{
    admit(c: Context): Promise<AuthContext>;
}

/**
 * Routes a request to its profile.
 *
 * - no profile header → null: the caller continues on the Bearer path;
 * - profile header + Authorization header → rejected (mixing prohibited);
 * - unknown profile value → rejected (unknownProfilePolicy: reject).
 *
 * Shared by authenticate and optionalAuth so "presented but invalid" refuses
 * identically on both — only the "presented nothing" outcome differs.
 */
export function selectAuthProfile(c: Context): AuthProfile | null
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
    const registered = AUTH_PROFILES.get(profile);
    if (registered === undefined)
    {
        throw refusalError(ClientProofRefusal.profileRejected());
    }

    return registered;
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
 * Bearer path. A contract refusal comes back as a built response rather than a
 * throw: the answer a proven call gets is the contract's own envelope, and an
 * error handed to the generic error handler is classified by its class name
 * instead.
 *
 * Every profile — built-in or registered by the app — is admitted through
 * `admitPrincipal`, with this request as the route (#309): a person who may
 * only enrol is refused with a throw of 403 `SECOND_FACTOR_ENROLMENT_REQUIRED`
 * except on an enrolment route reached through the global `authenticate`, and
 * `optionalAuth` reads that refusal as anonymous. A credential that is not a
 * person belongs in a machine principal (`registerMachineVerifier`), which
 * never comes here.
 *
 * @throws SecondFactorEnrolmentRequiredError, AccountDisabledError, AccountPendingDeletionError
 */
export async function runAuthProfile(c: Context): Promise<AuthProfileOutcome>
{
    try
    {
        const registered = selectAuthProfile(c);

        return registered === null ? { kind: 'none' } : { kind: 'authenticated', auth: await registered.admit(c) };
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
 * An app profile's identity, admitted. The verifier only says who presented
 * the request; whether that person may be let in is `admitPrincipal`'s.
 *
 * What the verifier resolved has to name an account. `null` is the JS idiom
 * for "no user", and taken at face value it would set `auth` to null and call
 * the route: authenticated everywhere downstream, a 500 in the handler. A
 * resolve that names no account is a refusal, and it leaves here as one — the
 * same throw the verifier's own refusal takes, so `optionalAuth` cannot
 * downgrade it to anonymous passage.
 */
async function admitAppProfile(c: Context, profile: string, verifier: AuthProfileVerifier): Promise<AuthContext>
{
    const identity = await verifier.verify(c);
    const userId = Number(identity?.userId);

    if (!Number.isSafeInteger(userId) || userId <= 0)
    {
        throw new UnauthorizedError({ message: 'Auth profile verifier returned no principal' });
    }

    const admission = await admitPrincipal({
        userId,
        credential: { kind: 'appProfile', profile, keyId: identity.keyId },
        route: c,
    });

    if ('refused' in admission)
    {
        throw admissionRefusalError(admission.refused);
    }

    return authContextFor(admission.admitted, identity.scheme);
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
async function admitClientProofProfile(c: Context): Promise<AuthContext>
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
    //    registered and is no longer live — revoked, of an ended key
    //    generation, or aged past its TTL (`keyLiveness`) — answers
    //    SESSION_REVOKED here. A keyId that was *never* registered does not:
    //    it falls through to the proof step and shares PROOF_INVALID with a
    //    failed signature, so whether a keyId exists is not inferable from
    //    the refusal (the same non-disclosure the dev surface keeps).
    const keyRecord = await keysRepository.findWithAccountEpochOnPrimary(credentials.keyId);
    if (keyRecord !== null && keyLiveness(keyRecord) !== 'live')
    {
        throw refusalError(ClientProofRefusal.sessionRevoked());
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

    // 7. The admission every door takes: the account's status, the key's
    //    liveness on the same read, and the second-factor policy. A key that
    //    died since step 1 answers SESSION_REVOKED, as it would have there.
    const admission = await admitPrincipal({
        userId: keyRecord.userId,
        credential: { kind: 'deviceKey', keyId: credentials.keyId },
        route: c,
    });

    if ('refused' in admission)
    {
        throw clientProofAdmissionRefusal(admission.refused);
    }

    // Fire-and-forget, as the Bearer path does — and with the address under the
    // same rule, so this surface neither erases `last_seen_ip` on every throttle
    // window nor writes one a proxy did not attest.
    keysRepository.updateLastUsedById(keyRecord.id, readContextClientIdentity(c), attestedClientIp(c))
        .catch((err: unknown) => authLogger.middleware.error('Failed to update lastUsedAt', err));

    authLogger.middleware.info('API access', {
        userId: admission.admitted.user.id,
        email: admission.admitted.user.email,
        keyId: credentials.keyId,
        scheme: CLIENT_PROOF_PROFILE,
        method: c.req.method,
        path: c.req.path,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        userAgent: c.req.header('user-agent'),
    });

    return authContextFor(admission.admitted, 'clientProofV1');
}

/**
 * An admission refusal on the proven surface: a key that stopped being live is
 * the contract's SESSION_REVOKED; the account refusals are the errors the
 * Bearer path answers, as they have always been here.
 */
function clientProofAdmissionRefusal(refusal: AdmissionRefusal): Error
{
    return refusal.reason === 'credentialRevoked' || refusal.reason === 'credentialExpired'
        ? refusalError(ClientProofRefusal.sessionRevoked())
        : admissionRefusalError(refusal);
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

/** profile name → profile. Registration is the only way to add a scheme. */
const AUTH_PROFILES: Map<string, AuthProfile> = new Map([
    [CLIENT_PROOF_PROFILE, { admit: admitClientProofProfile }],
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
 * The verifier establishes who presented the request and refuses by throwing:
 * it answers an `AuthProfileIdentity` — the account id, the key id it names
 * for it, the scheme — and never a principal. `admitPrincipal` then decides
 * whether that person may be let in (account status on the primary, the
 * second-factor policy) and builds the `AuthContext` the Bearer path sets, so
 * an app profile cannot admit a suspended account or skip a rule added later.
 * A resolve that names no account is refused as a throw too — "no user" is a
 * refusal, never a principal. A throw is not caught here:
 * `runAuthProfile` answers the internal clientProofV1 contract refusal and
 * nothing else, so a verifier's own error reaches the app's generic error
 * handler exactly as the Bearer path's `UnauthorizedError` does — and never
 * becomes anonymous passage, not even under `optionalAuth`.
 *
 * @example
 * ```typescript
 * registerAuthProfile('acmeDeviceV1', {
 *     verify: async (c) =>
 *     {
 *         const device = await verifyAcmeDevice(c.req.header('x-acme-device-proof'));
 *         if (device === null)
 *         {
 *             throw new UnauthorizedError({ message: 'Invalid device proof' });
 *         }
 *
 *         return { userId: String(device.userId), keyId: device.id, scheme: 'acmeDeviceV1' };
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
    if (AUTH_PROFILES.has(profileId))
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
    const verify = verifier.verify.bind(verifier);

    AUTH_PROFILES.set(profileId, { admit: c => admitAppProfile(c, profileId, { verify }) });
}
