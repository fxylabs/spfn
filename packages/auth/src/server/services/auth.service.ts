/**
 * @spfn/auth - Auth Service
 *
 * Core authentication logic: registration, login, logout, password management
 */

import { ValidationError } from '@spfn/core/errors';
import {
    InvalidCredentialsError,
    AccountDisabledError,
    AccountPendingDeletionError,
    AccountAlreadyExistsError,
    InvalidVerificationTokenError,
    VerificationTokenPurposeMismatchError,
    VerificationTokenTargetMismatchError,
} from '@spfn/auth/errors';

import { usersRepository, keysRepository, deviceAuthorizationsRepository } from '../repositories';
import { runBeforeRegister } from '../lib/config';
import { type KeyAlgorithmType, type KeyPlatformType } from '../types';
import { hashPassword, verifyPassword, getDummyPasswordHash, normalizeEmail } from '../helpers';
import { validateVerificationToken } from './verification.service';
import { registerPublicKeyService, revokeKeyService } from './key.service';
import { updateLastLoginService } from './user.service';
import { getPendingDeletionInfo } from './account-deletion.service';
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
}

export interface RegisterResult
{
    userId: string;
    publicId: string;
    email?: string;
    phone?: string;
}

export interface LoginParams
{
    email?: string;
    phone?: string;
    password: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    oldKeyId?: string;
    algorithm?: KeyAlgorithmType;
    deviceName?: string;
    platform?: KeyPlatformType;
}

export interface LoginResult
{
    userId: string;
    publicId: string;
    email?: string;
    phone?: string;
    passwordChangeRequired: boolean;
}

export interface LogoutParams
{
    userId: number;
    keyId: string;
}

export interface ChangePasswordParams
{
    userId: number;
    currentPassword?: string;
    newPassword: string;
    passwordHash?: string; // Optional: pass user's password hash to avoid re-fetch
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

    return await createVerifiedAccount({ ...params, phone });
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
    params: Omit<RegisterParams, 'verificationToken'>,
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

    // Check if user already exists
    const existingUser = await usersRepository.findByEmailOrPhone(email, phone);

    if (existingUser)
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
    // `emailVerifiedAt` is stamped here because both entry points proved the
    // address before arriving: the six-digit-code path verified a code sent to
    // it, the link path confirmed a link sent to it. It went unstamped for a
    // long time, which left password accounts indistinguishable from accounts
    // whose provider reported the address unverified — and made every predicate
    // written against the column wrong about them.
    const newUser = await usersRepository.create({
        email: email || null,
        phone: phone || null,
        emailVerifiedAt: email ? new Date() : null,
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
    });

    const result = {
        userId: String(newUser.id),
        publicId: newUser.publicId,
        email: newUser.email || undefined,
        phone: newUser.phone || undefined,
    };

    // Emit register event
    await authRegisterEvent.emit({
        userId: result.userId,
        provider: email ? 'email' : 'phone',
        email: result.email,
        phone: result.phone,
        metadata,
    });

    return result;
}

/**
 * Authenticate user and create session
 */
export async function loginService(
    params: LoginParams,
): Promise<LoginResult>
{
    const { email, phone, password, publicKey, keyId, fingerprint, oldKeyId, algorithm } = params;

    // Find user
    const user = await usersRepository.findByEmailOrPhone(email, phone);

    if (!email && !phone)
    {
        throw new ValidationError({ message: 'Either email or phone must be provided' });
    }

    if (!user || !user.passwordHash)
    {
        // Spend the same time as the real verify path so a non-existent account
        // can't be told apart from a wrong password by response timing (user
        // enumeration). The dummy hash is computed once and reused.
        await verifyPassword(password, await getDummyPasswordHash());
        throw new InvalidCredentialsError();
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid)
    {
        throw new InvalidCredentialsError();
    }

    // Check if user is active
    if (user.status !== 'active')
    {
        if (user.status === 'pending_deletion')
        {
            const pending = await getPendingDeletionInfo(user.id);
            throw new AccountPendingDeletionError({ purgeScheduledAt: pending?.purgeScheduledAt.toISOString() });
        }

        throw new AccountDisabledError({ status: user.status });
    }

    // Revoke old key if provided
    if (oldKeyId)
    {
        await revokeKeyService({
            userId: user.id,
            keyId: oldKeyId,
            reason: 'Replaced by new key on login',
        });
    }

    // Register new public key
    await registerPublicKeyService({
        userId: user.id,
        keyId,
        publicKey,
        fingerprint,
        algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
    });

    // Update last login
    await updateLastLoginService(user.id);

    const result = {
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
        passwordChangeRequired: user.passwordChangeRequired,
    };

    // Emit login event
    await authLoginEvent.emit({
        userId: result.userId,
        provider: email ? 'email' : 'phone',
        email: result.email,
        phone: result.phone,
    });

    return result;
}

/**
 * Logout user (revoke current key)
 */
export async function logoutService(
    params: LogoutParams,
): Promise<void>
{
    const { userId, keyId } = params;

    await revokeKeyService({
        userId,
        keyId,
        reason: 'Revoked by logout',
    });
}

/**
 * Change user password
 */
export async function changePasswordService(
    params: ChangePasswordParams,
): Promise<void>
{
    const { userId, currentPassword, newPassword, passwordHash: providedHash } = params;

    // Get user's password hash (either provided or fetch from DB)
    let passwordHash: string | null;
    if (providedHash)
    {
        passwordHash = providedHash;
    }
    else
    {
        const user = await usersRepository.findById(userId);
        if (!user)
        {
            throw new ValidationError({ message: 'User not found' });
        }
        passwordHash = user.passwordHash;
    }

    // Verify current password (skip for OAuth-only users setting password for the first time)
    if (passwordHash)
    {
        if (!currentPassword)
        {
            throw new ValidationError({ message: 'Current password is required' });
        }
        const isValid = await verifyPassword(currentPassword, passwordHash);
        if (!isValid)
        {
            throw new InvalidCredentialsError({ message: 'Current password is incorrect' });
        }
    }

    // Hash new password
    const newPasswordHash = await hashPassword(newPassword);

    // Update password and clear passwordChangeRequired flag
    await usersRepository.updatePassword(userId, newPasswordHash, true);

    // The device-code requests still in flight are keys that have not been handed
    // out yet: a poll on an approved one would register a fresh active key moments
    // after the revocation below, defeating the "log me out everywhere" this call
    // exists for.
    //
    // Refused first, and this route is the reason the order is worth a thought —
    // it is the one revoke-all path with no surrounding transaction, so the two
    // statements can be interrupted between. Losing the second leaves a device
    // still signed in, which the user can see and revoke; losing them the other
    // way round leaves a live approval that hands out a key nothing revoked.
    await deviceAuthorizationsRepository.denyAllActiveByUserId(userId);

    // Revoke all existing sessions on password change (incident-response intent:
    // "change password" should log the user out everywhere). authenticate verifies
    // against active keys only, so revoked keys' requests immediately fail — no
    // per-request cost beyond what auth already pays. The user re-authenticates.
    await keysRepository.revokeAllActiveByUserId(userId, 'Revoked by password change');
}
