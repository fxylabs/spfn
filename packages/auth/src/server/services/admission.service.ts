/**
 * @spfn/auth - Admission
 *
 * "May this person be let in now" is one question, and this module is the one
 * place it is answered. Every door that produces a person principal — the
 * Bearer path of `authenticate` and `optionalAuth`, every auth profile, the
 * one-time token, renewal, the OAuth 2.1 access token and token endpoint, the
 * new-device challenge, device-code / device-link collection — extracts its
 * credential and calls `admitPrincipal`; the completion of a two-step procedure
 * (`admitDeferred`) and a write that asks again under the account lock whether
 * its session is still let in (the deletion request) call `admitCompletion`,
 * the same decision with a named route's enrolment class in place of a
 * request. None of them carries a rule of its own, so a rule added here holds
 * at every door and a door cannot keep a copy that has drifted.
 *
 * The decision, in order:
 *
 * 1. the account — its deletion and its status, read on the write primary, so
 *    a suspension or a deletion request is refused on the next request and
 *    not once a replica catches up;
 * 2. the credential is live — a device key by `keyLiveness`, a renewal key by
 *    the renewal grace rule, a grant by not being revoked;
 * 3. the second-factor policy (#309) — except for renewal, below.
 *
 * The principal it answers with is a `Principal`, and the two shapes the doors
 * hand on — `AuthContext` on the request, `VerifiedOAuth2AccessToken` to
 * `@spfn/mcp` — are built from one here and nowhere else. All three carry a
 * brand and a sealed constructor. The brand is a compile-time guarantee only —
 * a private member no value outside the class can have, so an object literal
 * or a spread of another principal does not compile as one; it is not on the
 * object at run time and nothing checks it there. The sealed constructor makes
 * a `new` outside this module throw, and what is left — a cast — is refused by
 * the source scan in the one-admission-point suite (T2).
 *
 * @module server/services/admission.service
 */

import type { Context } from 'hono';
import { UnauthorizedError } from '@spfn/core/errors';
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    KeyExpiredError,
    SecondFactorEnrolmentRequiredError,
} from '@spfn/auth/errors';

import type { User } from '../entities/users';
import type { UserPublicKey } from '../entities/user-public-keys';
import type { OAuth2Grant } from '../entities/oauth2-grants';
import type { UserStatus } from '../types';
import { usersRepository, userSettingsRepository, accountDeletionRequestsRepository } from '../repositories';
import type { UserWithStoredRole } from '../repositories/users.repository';
import { isLiveGrant } from '../repositories/oauth2-grants.repository';
import { keyLiveness, type KeyLiveness } from '../lib/key-liveness';
import { getBoundKeyRenewGraceMs } from '../lib/config';
import { profileLocale } from '../lib/profile-locale';
import { applyRoleEmailDomainPolicy } from './role-email-domain.service';
import { secondFactorAdmits } from './second-factor-policy.service';
import { isMethodListed } from '../lib/second-factor-policy';
import type { RouteEnrolment } from '../routes/channels';

/**
 * What a door presents. Closed: a kind added here does not compile until
 * `readAdmission` says how its liveness is read and `signingKeyOf` what it
 * signs with.
 *
 * `appProfile` is a credential an application's registered auth profile
 * verified with its own scheme. The package holds no record of it, so it is
 * live exactly when the registered verifier admitted it on this request.
 *
 * A procedure's completion is no kind of its own: it presents the credential
 * the procedure was started with, to `admitCompletion`, which the package
 * entry does not export — so no caller of `admitPrincipal` can claim a
 * completing route's enrolment class.
 */
export type PrincipalCredential =
    | { kind: 'deviceKey'; keyId: string }
    | { kind: 'oneTimeToken'; issuedByKeyId: string }
    | { kind: 'oauth2Grant'; grantId: number }
    | { kind: 'renewal'; keyId: string }
    | { kind: 'appProfile'; profile: string; keyId: string };

/**
 * Why a person was not let in. Each door answers each reason in its own vocabulary.
 *
 * A purged account (`deletion: 'deleted'`) is answered as a disabled one, with
 * `'deleted'` where the status goes — the answer it has always had.
 */
export type AdmissionRefusal =
    | { reason: 'accountMissing' }
    | { reason: 'accountDisabled'; status: Exclude<UserStatus, 'active'> | 'deleted' }
    | { reason: 'pendingDeletion'; purgeScheduledAt: string | undefined }
    | { reason: 'credentialRevoked' }
    | { reason: 'credentialExpired' }
    | { reason: 'enrolmentRequired' };

export type Admission = { admitted: Principal } | { refused: AdmissionRefusal };

export interface AdmitPrincipalParams
{
    userId: number;
    credential: PrincipalCredential;
    /** The matched request, for the #309 enrolment-route exception; null where there is none. */
    route: Context | null;
}

/** The scheme an `AuthContext` names. Informational — downstream code never branches on it. */
export type AuthScheme = 'bearer' | 'clientProofV1' | 'oneTimeToken' | (string & {});

const SEAL: unique symbol = Symbol('spfn.auth.admission');

function assertSealed(seal: typeof SEAL): void
{
    if (seal !== SEAL)
    {
        throw new Error('A principal is produced by admitPrincipal and nothing else');
    }
}

interface PrincipalFields
{
    user: User;
    role: string | null;
    locale: string;
    chosenLocale: string | null;
    credential: PrincipalCredential;
}

/** A person `admitPrincipal` let in. Only this module can make one. */
export class Principal
{
    /** The brand: compile time only (see the module header). */
    declare private readonly admitted: true;
    readonly user: User;
    readonly userId: string;
    readonly role: string | null;
    /** The person's language choice, or `'en'` when they never made one. */
    readonly locale: string;
    /** The person's language choice, or `null` when they never made one. */
    readonly chosenLocale: string | null;
    /** What the person presented — on a principal so a handler can bind to the same credential. */
    readonly credential: PrincipalCredential;

    constructor(seal: typeof SEAL, fields: PrincipalFields)
    {
        assertSealed(seal);
        this.user = fields.user;
        this.userId = String(fields.user.id);
        this.role = fields.role;
        this.locale = fields.locale;
        this.chosenLocale = fields.chosenLocale;
        this.credential = fields.credential;
    }
}

/**
 * What a verified request leaves in the context — one shape for every scheme,
 * so permission and tenant code consumes one principal and never branches on
 * how it was authenticated.
 */
export class AuthContext extends Principal
{
    /** The device key the request was signed with — for a one-time token, the key that issued it. */
    readonly keyId: string;
    readonly scheme: AuthScheme;

    constructor(seal: typeof SEAL, principal: Principal, scheme: AuthScheme)
    {
        super(seal, principal);
        this.keyId = sessionKeyOf(principal.credential);
        this.scheme = scheme;
    }
}

/** What a verified OAuth 2.1 access token authorizes — `verifyAccessToken`'s answer. */
export class VerifiedOAuth2AccessToken
{
    /** The brand: compile time only (see the module header). */
    declare private readonly admitted: true;
    /** The public `client_id` of the CLI holding the token. */
    readonly clientId: string;
    /** Scope names, as granted or as the refresh that minted it narrowed them to. */
    readonly scopes: string[];
    /** Expiry as seconds since the epoch — the unit every OAuth field uses. */
    readonly expiresAt: number;
    /** The account the CLI is acting for. */
    readonly userId: string;

    constructor(seal: typeof SEAL, principal: Principal, token: { clientId: string; scopes: string[]; expiresAt: number })
    {
        assertSealed(seal);
        this.clientId = token.clientId;
        this.scopes = token.scopes;
        this.expiresAt = token.expiresAt;
        this.userId = principal.userId;
    }
}

/** The principal as the request context carries it. */
export function authContextFor(principal: Principal, scheme: AuthScheme): AuthContext
{
    return new AuthContext(SEAL, principal, scheme);
}

/** The principal as `verifyAccessToken` answers it. */
export function accessTokenPrincipalFor(
    principal: Principal,
    token: { clientId: string; scopes: string[]; expiresAt: number },
): VerifiedOAuth2AccessToken
{
    return new VerifiedOAuth2AccessToken(SEAL, principal, token);
}

/**
 * The device key a credential signs with: the key itself, or for a one-time
 * token the key that issued it. Null for a credential that is no device key —
 * a grant, or an application profile's own scheme.
 */
export function signingKeyOf(credential: PrincipalCredential): string | null
{
    switch (credential.kind)
    {
        case 'deviceKey':
        case 'renewal':
            return credential.keyId;
        case 'oneTimeToken':
            return credential.issuedByKeyId;
        case 'oauth2Grant':
        case 'appProfile':
            return null;
        default:
            return unreachable(credential);
    }
}

/**
 * The key id a session is known by (`AuthContext.keyId`): the device key it
 * signs with, the key id an application profile reported, `''` for a grant.
 */
export function sessionKeyOf(credential: PrincipalCredential): string
{
    return signingKeyOf(credential) ?? (credential.kind === 'appProfile' ? credential.keyId : '');
}

/**
 * The error the cookie/Bearer surfaces answer an admission refusal with — the
 * same one per reason `authenticate` has always answered — and what a write
 * that re-admits its session under the account lock answers with, so a
 * session refused there is told what its next request would be told.
 */
export function admissionRefusalError(refusal: AdmissionRefusal): Error
{
    switch (refusal.reason)
    {
        case 'accountMissing':
            return new UnauthorizedError({ message: 'User not found' });
        case 'accountDisabled':
            return new AccountDisabledError({ status: refusal.status });
        case 'pendingDeletion':
            return new AccountPendingDeletionError({ purgeScheduledAt: refusal.purgeScheduledAt });
        case 'credentialRevoked':
            return new UnauthorizedError({ message: 'Invalid or revoked key' });
        case 'credentialExpired':
            return new KeyExpiredError();
        case 'enrolmentRequired':
            return new SecondFactorEnrolmentRequiredError();
    }
}

function unreachable(credential: never): never
{
    throw new Error(`Unknown credential kind: ${JSON.stringify(credential)}`);
}

/**
 * Whether a key may sign a renewal — the one rule renewal admits by.
 *
 * Bound, and within its grace. Early renewal is allowed, because a browser that
 * asks a minute before its key runs out should not have to wait for the failure
 * first; late renewal is allowed for the grace window, so a laptop closed over a
 * long weekend comes back to one prompt instead of a sign-in. Past it there is
 * nothing to continue, and an unbound key was never in this ceremony at all.
 */
export function admitsForRenewal(key: UserPublicKey): boolean
{
    return key.binding === 'passkey'
        && key.expiresAt !== null
        && Date.now() < key.expiresAt.getTime() + getBoundKeyRenewGraceMs();
}

/**
 * Let a person in, or say why not.
 *
 * Answers rather than throws, so each door turns a refusal into the answer
 * it has always given — a 401/403 on the Bearer path, a contract code on a
 * proven call, `invalid_grant` on the token endpoint, one uniform refusal on
 * renewal — without catching anything.
 *
 * The queries are the ones `authenticate` always made: one read of the
 * account, its role and the credential's row together, the locale beside it,
 * and the second-factor read only while the policy requires a factor.
 *
 * **Renewal and the second factor (au9-N8).** A `renewal` credential is not
 * held to the second-factor policy, deliberately. Renewal does not admit a
 * request to anything: it continues a key the person already holds into its
 * replacement, and the replacement is held to the policy on its first request
 * like any key. Refusing it here would turn an enrolment-only person's expired
 * key into a sign-in instead of a renewal, and enrol nothing.
 */
export async function admitPrincipal(params: AdmitPrincipalParams): Promise<Admission>
{
    return await admit(params, null);
}

export interface AdmitCompletionParams
{
    userId: number;
    /** The credential the procedure was started with — or, for a renewal, the renewal it completes. */
    credential: PrincipalCredential;
    /** The class in `ROUTE_ENROLMENT` (#309) of the route the credential is admitted for. */
    enrolment: RouteEnrolment;
}

/**
 * `admitPrincipal` asked again, with no request in front of it, of a
 * credential a named route admitted: for the completion of a two-step
 * procedure (`admitDeferred`), and for a write that re-admits its own session
 * under the account lock it holds (the deletion request), so a key revoked or
 * an account suspended or left enrolment-only while it waited is refused.
 * An application profile's credential is live here as it was on the request
 * its verifier admitted.
 *
 * The second-factor policy's enrolment-only state admits the credential
 * exactly as it admitted the route it came in on (`ROUTE_ENROLMENT`): under
 * `'always'` and `'unchecked'`, under a method while that method is listed,
 * and under `'none'` not at all. Not exported from the package entry: an
 * application that could name an enrolment class here could let any request
 * past the enrolment-only refusal.
 */
export async function admitCompletion(params: AdmitCompletionParams): Promise<Admission>
{
    return await admit({ userId: params.userId, credential: params.credential, route: null }, params.enrolment);
}

/** The decision both entries make; `enrolment` is a completing route's class, null for a door. */
async function admit(params: AdmitPrincipalParams, enrolment: RouteEnrolment | null): Promise<Admission>
{
    const [read, chosenLocale] = await Promise.all([
        readAdmission(params.userId, params.credential),
        userSettingsRepository.findLocaleByUserId(params.userId),
    ]);

    if (read === null)
    {
        return { refused: { reason: 'accountMissing' } };
    }

    // In the documented order; each step runs only when the one before it admitted.
    const refusal = await accountRefusal(read.account.user)
        ?? credentialRefusal(read.liveness)
        ?? await secondFactorRefusal(params, enrolment);

    if (refusal !== null)
    {
        return { refused: refusal };
    }

    const { user, role } = (await applyRoleEmailDomainPolicy(read.account))!;

    return {
        admitted: new Principal(SEAL, { user, role: role?.name ?? null, ...profileLocale(chosenLocale), credential: params.credential }),
    };
}

interface AdmissionRead
{
    account: UserWithStoredRole;
    liveness: KeyLiveness;
}

/** The account and the liveness of what it presented, from one read of the primary. */
async function readAdmission(userId: number, credential: PrincipalCredential): Promise<AdmissionRead | null>
{
    switch (credential.kind)
    {
        case 'deviceKey':
        case 'oneTimeToken':
        case 'renewal':
            return keyAdmission(credential, await usersRepository.findByIdWithRoleAndKeyOnPrimary(userId, signingKeyOf(credential)!));
        case 'oauth2Grant':
            return grantAdmission(await usersRepository.findByIdWithRoleAndGrantOnPrimary(userId, credential.grantId));
        case 'appProfile':
            return accountOnly(await usersRepository.findByIdWithRoleOnPrimary(userId));
        default:
            return unreachable(credential);
    }
}

/**
 * A key's liveness against the account read with it. A key of an ended key
 * generation is a revoked key (`keyLiveness`). A renewal admits a bound key
 * past its expiry inside its grace, and nothing else: an unbound key, live or
 * not, was never in that ceremony.
 */
function keyAdmission(
    credential: PrincipalCredential,
    row: (UserWithStoredRole & { key: UserPublicKey | null }) | null,
): AdmissionRead | null
{
    if (row === null)
    {
        return null;
    }

    const liveness = row.key ? keyLiveness({ ...row.key, accountKeyEpoch: row.user.keyEpoch }) : 'revoked';

    if (credential.kind !== 'renewal')
    {
        return { account: row, liveness };
    }

    return { account: row, liveness: liveness !== 'revoked' && admitsForRenewal(row.key!) ? 'live' : 'revoked' };
}

/**
 * A grant is live by the one rule `isLiveGrant` states: not revoked, and not
 * past its lifetime. Its scope and resource rules are the token's, and stay
 * with the doors that apply them.
 */
function grantAdmission(row: (UserWithStoredRole & { grant: OAuth2Grant | null }) | null): AdmissionRead | null
{
    return row && { account: row, liveness: row.grant !== null && isLiveGrant(row.grant) ? 'live' : 'revoked' };
}

/** An application profile's credential was verified by its verifier on this request. */
function accountOnly(row: UserWithStoredRole | null): AdmissionRead | null
{
    return row && { account: row, liveness: 'live' };
}

/**
 * Whether an account may be let in: an operator lets it in (`active`) and no
 * deletion was asked for. The one rule every reader of the two facts applies —
 * a reader that needs no reason (a reset link, an operator report) asks this.
 */
export function admitsAccount(user: Pick<User, 'status' | 'deletion'>): boolean
{
    return user.status === 'active' && user.deletion === null;
}

/**
 * Step 1: an account that is not active, or whose deletion was asked for, is
 * refused, whatever it presented.
 *
 * The deletion is answered first: a pending deletion carries the purge date
 * and names the one door left open — `/_auth/deletion/cancel`, which admits a
 * pending account whatever its status — and a purged account is gone. A
 * sanction answers once no deletion is in the way.
 *
 * Exported for the doors that ask it before the credential half: a key write
 * (`registerPublicKeyService`), which asks it of the account row it has
 * locked, the sign-in channels, which ask it once the credential is proven,
 * and `mfa/verify`, which asks it before spending a proof.
 */
export async function accountRefusal(user: Pick<User, 'id' | 'status' | 'deletion'>): Promise<AdmissionRefusal | null>
{
    if (user.deletion === 'deleted')
    {
        return { reason: 'accountDisabled', status: 'deleted' };
    }

    if (user.deletion === 'pending')
    {
        const pending = await accountDeletionRequestsRepository.findPendingByUserIdOnPrimary(user.id);

        return { reason: 'pendingDeletion', purgeScheduledAt: pending?.purgeScheduledAt.toISOString() };
    }

    return user.status === 'active' ? null : { reason: 'accountDisabled', status: user.status };
}

/** Step 2. Revocation is told apart from expiry because some doors answer them differently. */
function credentialRefusal(liveness: KeyLiveness): AdmissionRefusal | null
{
    if (liveness === 'live')
    {
        return null;
    }

    return { reason: liveness === 'expired' ? 'credentialExpired' : 'credentialRevoked' };
}

/** Step 3, for every credential but renewal (see `admitPrincipal`). */
async function secondFactorRefusal(
    params: AdmitPrincipalParams,
    enrolment: RouteEnrolment | null,
): Promise<AdmissionRefusal | null>
{
    if (params.credential.kind === 'renewal' || (enrolment !== null && admitsEnrolmentOnly(enrolment)))
    {
        return null;
    }

    return await secondFactorAdmits(params.userId, params.route) ? null : { reason: 'enrolmentRequired' };
}

/** Whether a completing route admits an enrolment-only session, as `authenticate` reads its class. */
function admitsEnrolmentOnly(enrolment: RouteEnrolment): boolean
{
    if (enrolment === 'none')
    {
        return false;
    }

    return enrolment === 'always' || enrolment === 'unchecked' || isMethodListed(enrolment);
}
