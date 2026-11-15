/**
 * @spfn/auth - Admission
 *
 * "May this person be let in now" is one question, and this module is the one
 * place it is answered. Every door that produces a person principal — the
 * Bearer path of `authenticate` and `optionalAuth`, every auth profile, the
 * one-time token, renewal, the OAuth 2.1 access token and token endpoint, the
 * new-device challenge and device-code / device-link collection — extracts its
 * credential and calls `admitPrincipal`. None of them carries a rule of its
 * own, so a rule added here holds at every door and a door cannot keep a copy
 * that has drifted.
 *
 * The decision, in order:
 *
 * 1. the account's status — read on the write primary, so a suspension is
 *    refused on the next request and not once a replica catches up;
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

/**
 * What a door presents. Closed: a kind added here does not compile until
 * `readAdmission` says how its liveness is read and `signingKeyOf` what it
 * signs with.
 *
 * `appProfile` is a credential an application's registered auth profile
 * verified with its own scheme. The package holds no record of it, so it is
 * live exactly when the registered verifier admitted it on this request.
 */
export type PrincipalCredential =
    | { kind: 'deviceKey'; keyId: string }
    | { kind: 'oneTimeToken'; issuedByKeyId: string }
    | { kind: 'oauth2Grant'; grantId: number }
    | { kind: 'renewal'; keyId: string }
    | { kind: 'appProfile'; profile: string; keyId: string };

/** Why a person was not let in. Each door answers each reason in its own vocabulary. */
export type AdmissionRefusal =
    | { reason: 'accountMissing' }
    | { reason: 'accountDisabled'; status: UserStatus }
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
        this.keyId = signingKeyOf(principal.credential) ?? appProfileKeyOf(principal.credential);
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

/** The key id an application profile reported, `''` for any other keyless credential. */
function appProfileKeyOf(credential: PrincipalCredential): string
{
    return credential.kind === 'appProfile' ? credential.keyId : '';
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
        ?? await secondFactorRefusal(params);

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
 * Step 1: an account that is not active is refused, whatever it presented.
 *
 * Exported for the doors that ask it before the credential half: a key write
 * (`registerPublicKeyService`), which asks it of the account row it has
 * locked, and `mfa/verify`, which asks it before spending a proof.
 */
export async function accountRefusal(user: Pick<User, 'id' | 'status'>): Promise<AdmissionRefusal | null>
{
    if (user.status === 'active')
    {
        return null;
    }

    if (user.status !== 'pending_deletion')
    {
        return { reason: 'accountDisabled', status: user.status };
    }

    const pending = await accountDeletionRequestsRepository.findPendingByUserIdOnPrimary(user.id);

    return { reason: 'pendingDeletion', purgeScheduledAt: pending?.purgeScheduledAt.toISOString() };
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
async function secondFactorRefusal(params: AdmitPrincipalParams): Promise<AdmissionRefusal | null>
{
    if (params.credential.kind === 'renewal' || await secondFactorAdmits(params.userId, params.route))
    {
        return null;
    }

    return { reason: 'enrolmentRequired' };
}
