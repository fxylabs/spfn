/**
 * @spfn/auth - Auth Service
 *
 * Core authentication logic: registration, login, logout, password management
 */

import { ConflictError, ValidationError } from '@spfn/core/errors';
import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import {
    InvalidCredentialsError,
    AccountAlreadyExistsError,
    InvalidVerificationTokenError,
    VerificationTokenPurposeMismatchError,
    VerificationTokenTargetMismatchError,
} from '@spfn/auth/errors';

import { usersRepository } from '../repositories';
import { runBeforeRegister } from '../lib/config';
import { assertPasskeyProven, type PasskeyProof } from '../lib/passkey-proof';
import { type KeyAlgorithmType, type KeyPlatformType } from '../types';
import {
    hashPassword,
    verifyPassword,
    getDummyPasswordHash,
    isLegacyPasswordHash,
    legacyHashProvesWholePassword,
    normalizeEmail,
} from '../helpers';
import { validateVerificationToken } from './verification.service';
import { endEverySessionExcept, registerPublicKeyService, revokeKeyService } from './key.service';
import { assertStepUp, mfaEnrolledForUser } from './mfa.service';
import { secondFactorEnrolmentFields } from './second-factor-policy.service';
import { updateLastLoginService } from './user.service';
import { accountRefusalReason, signingKeyOf, type PrincipalCredential } from './admission.service';
import { admitSignIn, assertOwnsTransactions, failedCredentialAnswer } from './sign-in-guard.service';
import { signInGuard, type SignInAttempt } from '../lib/sign-in-guard';
import type { User } from '../entities/users';
import { authLoginEvent, authRegisterEvent } from '../events';

export interface RegisterParams
{
    email?: string;
    phone?: string;
    verificationToken: string;
    password: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    deviceName?: string;
    platform?: KeyPlatformType;
    metadata?: Record<string, unknown>;
    /** Client address of the request, from `deviceProvenance` at the route. */
    ip?: string;
    /** `user-agent` of the request, already truncated at the route. */
    userAgent?: string;
    /**
     * Whether proxy-guard recognised the trusted Next.js proxy, from the same
     * helper. A brand-new account is on the default `session_binding: 'none'`,
     * so its first key is never bound — but it is recorded as a web key, which
     * turning binding on later binds.
     */
    webProxy?: boolean;
}

/**
 * What `createVerifiedAccount` needs once ownership has been proven.
 *
 * `channel` is the one field the two entry points do not share: both arrive
 * here having proved the address, one with a six-digit code and one with an
 * emailed link, and the device event has to be able to say which.
 */
export type CreateVerifiedAccountParams = Omit<RegisterParams, 'verificationToken'> & {
    channel: 'register' | 'signup-link';
};

export interface RegisterResult
{
    userId: string;
    publicId: string;
    email?: string;
    phone?: string;
    /** As on `LoginResult`: a new account under a required second factor may only enrol one. */
    secondFactorEnrolmentRequired?: boolean;
}

export interface LoginParams
{
    email?: string;
    phone?: string;
    password: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    /**
     * The sign-in body's `replacementProof`: a short JWT signed by the key this
     * one replaces. `registerPublicKeyService` alone decides whether it holds;
     * absent or not, the password was proved and the sign-in goes ahead.
     */
    replacementProof?: string;
    algorithm?: KeyAlgorithmType;
    deviceName?: string;
    platform?: KeyPlatformType;
    /** Client address of the request, from `deviceProvenance` at the route. */
    ip?: string;
    /** `user-agent` of the request, already truncated at the route. */
    userAgent?: string;
    /** Whether proxy-guard recognised the trusted Next.js proxy, from the same helper. */
    webProxy?: boolean;
}

/**
 * The sign-in answer shapes, re-exported from where they are defined.
 *
 * `login-result.ts` holds them because `key.service` and `mfa.service` read them
 * and this file reads those; they are re-exported here because this is where
 * every consumer has always imported `LoginResult` from.
 */
export type { LoginBindingFields, LoginResult, MfaChallengeHandle } from './login-result';
export { loginBindingFields } from './login-result';

import { loginBindingFields, type LoginResult } from './login-result';

export interface LogoutParams
{
    userId: number;
    /** The key the request signs with (`signingKeyOf`). Null — an application profile — revokes nothing. */
    keyId: string | null;
}

export interface ChangePasswordParams
{
    userId: number;
    /**
     * The credential this request presented (`getAuth(c).credential`).
     *
     * Only read to measure the second-factor window of an enrolled account —
     * an account with nothing enrolled is answered exactly as before, so this
     * adds no refusal for anybody who has not opted in.
     */
    credential: PrincipalCredential;
    currentPassword?: string;
    newPassword: string;
    passwordHash?: string; // Optional: pass user's password hash to avoid re-fetch
    /**
     * A verified passkey assertion made for this procedure (`passwordSet`,
     * `checkPasskeyProof`), which an account with session binding on must
     * show to set its first password (`assertPasskeyProven`).
     */
    passkeyProof?: PasskeyProof | null;
    /**
     * true ends the caller's session too ("this device is compromised").
     * Default false: the key the request signs with (`signingKeyOf`) is spared,
     * as `revoke-all` spares it.
     */
    includeCurrent?: boolean;
}

/**
 * Register a new user account
 */
export async function registerService(
    params: RegisterParams,
): Promise<RegisterResult>
{
    const { email, verificationToken } = params;
    // Trimmed once, here, so the token comparison, the duplicate check and the
    // stored row all mean the same number. Trimming at the comparison alone
    // would let a padded number past a check it used to fail and then store the
    // padding, and `findByPhone` matches the raw column. The trimmed value is
    // what `createVerifiedAccount` receives below, so the check and the row
    // downstream see it too.
    const phone = params.phone?.trim();

    // Validate verification token
    const tokenPayload = validateVerificationToken(verificationToken);
    if (!tokenPayload)
    {
        throw new InvalidVerificationTokenError();
    }

    // Verify that token purpose is registration
    if (tokenPayload.purpose !== 'registration')
    {
        throw new VerificationTokenPurposeMismatchError({ expected: 'registration', actual: tokenPayload.purpose });
    }

    // Verify that token target matches provided email/phone.
    // Compared in canonical form on both sides: the token carries the address as
    // the verification step normalized it, so a user who retypes their address
    // with different capitalization here would otherwise be told the token is
    // for a different address than the one they just proved.
    // The phone is compared trimmed too: the verification step stores the target
    // trimmed, so comparing an untrimmed one here would refuse a code the caller
    // just proved.
    const providedTarget = email ? normalizeEmail(email) : phone;
    if (tokenPayload.target !== providedTarget)
    {
        throw new VerificationTokenTargetMismatchError();
    }

    // Verify that token targetType matches
    const providedTargetType = email ? 'email' : 'phone';
    if (tokenPayload.targetType !== providedTargetType)
    {
        throw new VerificationTokenTargetMismatchError();
    }

    return await createVerifiedAccount({ ...params, phone, channel: 'register' });
}

/**
 * Create an account whose owner has already been proven.
 *
 * Everything after the proof: the existence check, the app's pre-registration
 * policy, the password hash, the user row, the device key, and the register
 * event. It does NOT decide whether the caller proved ownership — each entry
 * point does that in its own way and then arrives here.
 *
 * Two entry points share it today: `/_auth/register`, which proves ownership
 * with a six-digit-code verification token, and the verified-email signup
 * flow, which proves it with a confirmed link and its setup session. Keeping
 * one body means an account is created identically either way — the same
 * duplicate refusal, the same policy hook, the same event — instead of two
 * paths that drift.
 *
 * Call it inside a transaction. The user row and the device key must land
 * together or not at all.
 */
export async function createVerifiedAccount(
    params: CreateVerifiedAccountParams,
): Promise<RegisterResult>
{
    const { email, phone, password, publicKey, keyId, fingerprint, algorithm, metadata } = params;

    // The device key is injected by the proxy interceptor, so its absence means
    // the request did not come through one. Refusing here keeps that a 400: left
    // unchecked, the undefined keyId reaches the key lookup and surfaces as a
    // driver-level 500 that names a column list instead of the problem.
    if (!publicKey || !keyId || !fingerprint)
    {
        throw new ValidationError({ message: 'Device key material is required to register' });
    }

    // Check if user already exists — an address stored in another case counts
    if (await accountExists(email, phone))
    {
        const identifierType = email ? 'email' : 'phone';
        throw new AccountAlreadyExistsError({ identifier: email || phone!, identifierType });
    }

    // App-level pre-registration policy gate — throws to reject
    await runBeforeRegister({ channel: 'credentials', email, phone, metadata });

    // Hash password
    const passwordHash = await hashPassword(password);

    // Get default user role
    const { getRoleByName } = await import('./role.service');
    const userRole = await getRoleByName('user');

    if (!userRole)
    {
        throw new Error('Default user role not found. Run initializeAuth() first.');
    }

    // Create user
    //
    // The verified-at column of the target that was proven is stamped here,
    // because both entry points proved it before arriving: the six-digit-code
    // path verified a code sent to it, the link path confirmed a link sent to
    // it. The proven target is the email when there is one — the link path has
    // only an email, and `registerService` checks the token against the email
    // first — and otherwise the phone. Left unstamped, a password account is
    // indistinguishable from one whose address nobody proved, and every
    // predicate written against the column is wrong about it.
    const verifiedAt = new Date();
    const newUser = await usersRepository.create({
        email: email || null,
        phone: phone || null,
        emailVerifiedAt: email ? verifiedAt : null,
        phoneVerifiedAt: email ? null : verifiedAt,
        passwordHash,
        passwordChangeRequired: false,
        roleId: userRole.id,
        status: 'active',
    });

    // Register public key
    await registerPublicKeyService({
        userId: newUser.id,
        keyId,
        publicKey,
        fingerprint,
        algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
        channel: params.channel,
        ip: params.ip,
        userAgent: params.userAgent,
        webProxy: params.webProxy,
    });

    const result = {
        userId: String(newUser.id),
        publicId: newUser.publicId,
        email: newUser.email || undefined,
        phone: newUser.phone || undefined,
        ...await secondFactorEnrolmentFields(newUser.id),
    };

    // After the commit: both routes that reach here run under `Transactional()`,
    // and an inline emit would announce an account another connection cannot
    // read yet, or one a rollback then erased.
    onAfterCommit(() => authRegisterEvent.emit({
        userId: result.userId,
        provider: email ? 'email' : 'phone',
        email: result.email,
        phone: result.phone,
        metadata,
    }));

    return result;
}

/**
 * Whether an account already holds the email or phone a signup names.
 *
 * The email is looked up in any stored case, unlike `findByEmailOrPhoneOnPrimary`, which
 * login and account deletion share and which must keep finding exactly one
 * account to act as.
 */
async function accountExists(email?: string, phone?: string): Promise<boolean>
{
    if (email)
    {
        return (await usersRepository.findByFoldedEmail(email)).kind !== 'none';
    }

    return phone ? !!(await usersRepository.findByPhone(phone)) : false;
}

/**
 * Authenticate user and create session
 *
 * The password is checked outside any transaction and outside the account
 * lock, and the session is written in a transaction of this function's own.
 * With the app's `signIn` guard configured:
 *
 * 1. `admit` is asked before the password is compared, without the lock. An
 *    account it refuses is compared against the dummy hash — never its own —
 *    and answered `SignInRefusedError` whatever the password was, so the
 *    refusal is neither a password oracle nor, by timing, an account oracle;
 * 2. a failure is told to `settled` in a transaction of its own, under the
 *    account lock, committed before the answer — a wrong password with
 *    `admit` asked again there, a refusal from step 1 without
 *    (`failedCredentialAnswer`);
 * 3. a right password meets the deciding `admit` under the lock in the
 *    session's transaction (`registerPublicKeyService`), whose refusal is told
 *    once that transaction has rolled back.
 *
 * An account the package refuses — disabled, pending deletion, purged — is
 * answered exactly as a wrong password, whatever the password: its own hash is
 * still compared, and the refusal is read from the row's columns
 * (`accountRefusalReason`), so neither the answer nor the time it takes tells
 * a caller the password was right. Only `settled` learns why: a right
 * password is told with the refusal's reason (`accountDisabled`,
 * `pendingDeletion`), a wrong one as `credential`. The session's write asks
 * again under the account lock and answers the same way.
 *
 * @throws Error when the guard is configured and the caller holds a transaction
 */
export async function loginService(
    params: LoginParams,
): Promise<LoginResult>
{
    const { email, phone, password } = params;

    assertOwnsTransactions('loginService');

    // Find user — on the primary: a password changed a moment ago is the one
    // that has to match.
    const user = await usersRepository.findByEmailOrPhoneOnPrimary(email, phone);

    if (!email && !phone)
    {
        throw new ValidationError({ message: 'Either email or phone must be provided' });
    }

    const attempt = signInGuard() && passwordAttempt(user, params);
    const refusal = attempt && await admitSignIn(attempt);

    // An unknown account, one without a password and one the app refused spend
    // the time of the real verify path against the dummy hash, so none of the
    // three can be told apart from a wrong password by response timing. The
    // dummy hash is computed once and reused.
    const comparedHash = refusal || !user?.passwordHash ? await getDummyPasswordHash() : user.passwordHash;
    const isValid = await verifyPassword(password, comparedHash);
    const accountRefused = user && accountRefusalReason(user);

    if (refusal || !user?.passwordHash || !isValid || accountRefused)
    {
        throw await failedCredentialAnswer(attempt, refusal, () => new InvalidCredentialsError(), {
            keyId: params.keyId,
            reason: isValid && accountRefused ? accountRefused : 'credential',
        });
    }

    // Hashed before the account lock is taken: the hash is the slow step.
    const upgradedHash = await upgradedPasswordHash(password, user.passwordHash);

    return await runInTransaction(
        () => startPasswordSession(user, params, upgradedHash),
        { context: 'auth:login' },
    );
}

/** The attempt a password sign-in is, as the app's `signIn` guard sees it. */
function passwordAttempt(user: User | null, params: LoginParams): SignInAttempt
{
    return {
        user,
        channel: 'password',
        stage: 'credential',
        identifier: params.email ? { email: params.email } : { phone: params.phone },
        ip: params.ip,
        userAgent: params.userAgent,
        webProxy: params.webProxy === true,
    };
}

/**
 * The session of a password sign-in whose password was right: the key, the
 * re-encoded hash, `lastLoginAt` and the login event — one transaction, under
 * the account lock the key write takes.
 */
async function startPasswordSession(user: User, params: LoginParams, upgradedHash: string | null): Promise<LoginResult>
{
    const { email } = params;

    // Register new public key
    const registered = await registerPublicKeyService({
        userId: user.id,
        keyId: params.keyId,
        publicKey: params.publicKey,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
        channel: 'password',
        inactiveAccount: () => new InvalidCredentialsError(),
        missingAccount: () => new InvalidCredentialsError(),
        ip: params.ip,
        userAgent: params.userAgent,
        webProxy: params.webProxy,
        identifier: email ? { email } : { phone: params.phone },
        replaces: params.replacementProof ? { proof: params.replacementProof } : undefined,
        loginEvent: {
            provider: email ? 'email' : 'phone',
            email: user.email || undefined,
            phone: user.phone || undefined,
        },
    });

    // Under the account lock the key write took, which this transaction holds
    // until it commits.
    if (upgradedHash)
    {
        await usersRepository.replaceVerifiedPasswordHash(user.id, user.passwordHash!, upgradedHash);
    }

    // An enrolled account on a device it has never seen gets a challenge instead
    // of a session (#95). Nothing below this line runs: the sign-in has not
    // happened yet, so `lastLoginAt` does not move and no login event is
    // announced — an attacker holding only the password must not be able to
    // produce either. Both happen at `POST /_auth/mfa/verify`.
    if (registered.pending)
    {
        return { mfaRequired: true, challenge: registered.challenge };
    }

    // Update last login
    await updateLastLoginService(user.id);

    const result: LoginResult = {
        mfaRequired: false,
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
        ...loginBindingFields(registered),
        ...await secondFactorEnrolmentFields(user.id),
    };

    // After the commit, with `mfaEnrolled` read before the callback is queued
    // so that the read runs in this transaction and the callback stays synchronous.
    const mfaEnrolled = await mfaEnrolledForUser(user.id);

    onAfterCommit(() => authLoginEvent.emit({
        userId: String(user.id),
        provider: email ? 'email' : 'phone',
        email: result.email,
        phone: result.phone,
        mfaEnrolled,
        secondFactorEnrolmentRequired: result.secondFactorEnrolmentRequired === true,
    }));

    return result;
}

/**
 * The pre-hashed replacement for a legacy `bcrypt(password)` hash the password
 * has just been proven against, or null for a hash already in the new format:
 * the legacy format is never written back. Null as well for a password the
 * legacy hash did not prove whole (72 bytes or more): that hash stays until
 * a password change or reset writes a new one.
 *
 * Computed outside the account lock; the sign-in writes it under the lock, in
 * its own transaction, so it lands only with a sign-in that commits — and only
 * over the hash that was verified (`replaceVerifiedPasswordHash`): a password
 * changed since stays changed.
 */
async function upgradedPasswordHash(password: string, verifiedHash: string): Promise<string | null>
{
    return isLegacyPasswordHash(verifiedHash) && legacyHashProvesWholePassword(password)
        ? await hashPassword(password)
        : null;
}

/**
 * Logout user (revoke current key)
 */
export async function logoutService(
    params: LogoutParams,
): Promise<void>
{
    const { userId, keyId } = params;

    if (keyId)
    {
        await revokeKeyService({
            userId,
            keyId,
            reason: 'Revoked by logout',
        });
    }
}

/**
 * Change user password
 *
 * An enrolled account steps up first (#95): a stolen session must not be able
 * to take the account over by setting a new password. An unenrolled account is
 * unaffected — including the OAuth-only account with no password and a key
 * older than ten minutes, which still sets a first password and gets a 200.
 *
 * Every other session ends with it, and every way back in
 * (`endEverySessionExcept`) — the rule `revoke-all` follows: the key the
 * request signs with is spared and moves into the new key generation, unless
 * `includeCurrent`. A one-time token spares the key that issued it; an
 * application profile or a grant holds no key to spare.
 *
 * Setting a first password on an account with session binding on asks a
 * passkey proof (`lib/passkey-proof.ts`): it is a first factor the session
 * would otherwise hand out with nothing but itself, and a sign-in with it
 * outside the proxy is an unbound 90-day key. Changing an existing password
 * proves that password, and is not asked.
 *
 * The new password must differ from the current one, so re-typing a seeded
 * password does not clear `passwordChangeRequired` (#362). The change clears
 * it in the same transaction, under the account lock, as it writes the hash.
 *
 * @throws PasskeyProofRequiredError when a bound account sets its first password without the proof
 * @throws ValidationError when the new password is the current one
 */
export async function changePasswordService(
    params: ChangePasswordParams,
): Promise<void>
{
    const { userId } = params;

    await assertStepUp({ userId, credential: params.credential });

    const verifiedHash = await verifyCurrentPassword(params);
    await assertNewPasswordDiffers(params.newPassword, verifiedHash);
    // Hashed before the account lock is taken: the hash is the slow step.
    const change = {
        userId,
        newPasswordHash: await hashPassword(params.newPassword),
        spareKeyId: params.includeCurrent ? null : signingKeyOf(params.credential),
    };

    if (await replaceVerifiedPassword(change, verifiedHash, params.passkeyProof ?? null))
    {
        return;
    }

    // For an account that had none, the request sent no current password to be
    // wrong about: another request set the first one meanwhile.
    if (verifiedHash === null)
    {
        throw new ConflictError({ message: 'A password was set on this account by another request in the meantime. Send it as the current password to change it.' });
    }

    // A stored hash that moved since it was verified makes the proof stale, not
    // wrong: a sign-in re-encodes a legacy hash of the same password. Verified
    // again against what is stored now — outside the lock, since verifying is
    // the slow step — and the locked step runs once more. A hash that moves
    // again, or a password that no longer matches, is refused as before.
    const reverifiedHash = await verifyCurrentPassword({ ...params, passwordHash: undefined });

    if (!await replaceVerifiedPassword(change, reverifiedHash, null))
    {
        throw new InvalidCredentialsError({ message: 'Current password is incorrect' });
    }
}

/** What a password change writes, and the key it spares (null: none). */
interface PasswordChange
{
    userId: number;
    newPasswordHash: string;
    spareKeyId: string | null;
}

/**
 * The change itself, under the account lock, when the hash the current
 * password was verified against is still the one stored — read again under the
 * lock, since a change committed while it was being verified moves it. A first
 * password (`verifiedHash` null) spends the passkey proof a bound account owes.
 *
 * @returns false, with nothing written, when the stored hash moved
 */
async function replaceVerifiedPassword(
    change: PasswordChange,
    verifiedHash: string | null,
    passkeyProof: PasskeyProof | null,
): Promise<boolean>
{
    const { userId } = change;

    return await runInTransaction(async () =>
    {
        const account = await usersRepository.lockAccount(userId);
        if (!account)
        {
            throw new ValidationError({ message: 'User not found' });
        }

        if (account.passwordHash !== verifiedHash)
        {
            return false;
        }

        if (verifiedHash === null)
        {
            await assertPasskeyProven(account, passkeyProof, 'passwordSet');
        }

        await usersRepository.updatePassword(userId, change.newPasswordHash, true);
        await endEverySessionExcept(userId, change.spareKeyId, 'Revoked by password change');

        return true;
    }, { context: 'auth:change-password' });
}

/**
 * The current password checked against the hash the account holds — skipped
 * for an OAuth-only account setting its first password.
 *
 * @returns the hash it was checked against, or null for an account that had none
 */
async function verifyCurrentPassword(params: ChangePasswordParams): Promise<string | null>
{
    const passwordHash = params.passwordHash ?? await storedPasswordHash(params.userId);

    if (!passwordHash)
    {
        return null;
    }

    if (!params.currentPassword)
    {
        throw new ValidationError({ message: 'Current password is required' });
    }

    if (!await verifyPassword(params.currentPassword, passwordHash))
    {
        throw new InvalidCredentialsError({ message: 'Current password is incorrect' });
    }

    return passwordHash;
}

/**
 * Whether a new password may clear `passwordChangeRequired` (#362): not when it
 * is the current one, or the seeded password would survive the requirement.
 * One more hash compare; an account with no password has nothing to compare.
 *
 * The change holds every account to it. A reset holds only a flagged account:
 * resetting an unflagged account to the password it had stays allowed.
 *
 * @throws ValidationError when the new password is the current one
 */
export async function assertNewPasswordDiffers(newPassword: string, currentHash: string | null): Promise<void>
{
    if (currentHash !== null && await verifyPassword(newPassword, currentHash))
    {
        throw new ValidationError({ message: 'The new password must differ from the current one' });
    }
}

/** On the primary: it is compared, under the lock, with what the primary holds. */
async function storedPasswordHash(userId: number): Promise<string | null>
{
    const user = await usersRepository.findByIdOnPrimary(userId);
    if (!user)
    {
        throw new ValidationError({ message: 'User not found' });
    }

    return user.passwordHash;
}
