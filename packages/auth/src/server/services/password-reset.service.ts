/**
 * @spfn/auth - Password Reset Service
 *
 * Getting back into an account whose password is gone, using the address the
 * account already proved:
 *
 *   request  -> a one-time link is emailed
 *   confirm  -> the link is exchanged for a short-lived password-setup session
 *   complete -> the new password is written, everything else is signed out,
 *               and the browser that reset is signed in on a fresh device key
 *
 * Mirrors the verified-email signup slice deliberately — same credentials, same
 * hashing, same supersede-on-resend, same interceptor moves — with two
 * differences that matter.
 *
 * First, the request answers identically for *every* input and sends mail only
 * to an account that can be reset. Signup can afford to tell an existing owner
 * "you already have an account"; a reset cannot send anything to a stranger's
 * mailbox, because the mail itself would be the answer to "does this address
 * have an account here".
 *
 * Second, completing it is a credential change on a live account, so it carries
 * the same blast radius as `changePasswordService`: pending device
 * authorizations are denied and every active key is revoked. Whoever was signed
 * in on the old password is signed out, including the attacker the reset was
 * needed for.
 */

import crypto from 'crypto';
import { env } from '@spfn/auth/config';
import { PasswordResetLinkError, PasswordResetSessionError } from '@spfn/auth/errors';
import { ValidationError } from '@spfn/core/errors';
import { onAfterCommit } from '@spfn/core/db';
import { sendEmail } from '@spfn/notification/server';
import { authLogger } from '../logger';
import {
    deviceAuthorizationsRepository,
    keysRepository,
    passwordResetTokensRepository,
    usersRepository,
} from '../repositories';
import type { PasswordResetToken } from '../entities/password-reset-tokens';
import { hashPassword, normalizeEmail } from '../helpers';
import { authPasswordResetEvent } from '../events';
import { registerPublicKeyService } from './key.service';
import { updateLastLoginService } from './user.service';
import type { RegisterResult } from './auth.service';
import type { KeyAlgorithmType, KeyPlatformType } from '../types';

/**
 * Bytes of entropy in the link token and the setup secret.
 *
 * The same 32 bytes the signup link uses, for the same reason: there is nothing
 * to brute force, so neither credential carries an attempt counter and the rate
 * limits bound request volume and mail sending rather than guessing.
 */
const CREDENTIAL_BYTES = 32;

/**
 * Mint a bearer credential and the value stored for it.
 *
 * The secret is returned once, to be emailed or set as a cookie, and is then
 * unrecoverable — only `hash` reaches the database.
 */
function mintCredential(): { secret: string; hash: string }
{
    const secret = crypto.randomBytes(CREDENTIAL_BYTES).toString('base64url');

    return { secret, hash: hashCredential(secret) };
}

/**
 * Hash a presented credential the same way it was stored.
 *
 * SHA-256 without a salt or a work factor, deliberately: the input is 32 random
 * bytes rather than a human-chosen secret, so there is no dictionary to slow
 * down, and lookup has to be a plain equality match on an indexed column.
 */
function hashCredential(secret: string): string
{
    return crypto.createHash('sha256').update(secret).digest('base64url');
}

/**
 * Absolute URL of the app page the reset link opens.
 */
function buildConfirmUrl(token: string): string
{
    const appUrl = (env.NEXT_PUBLIC_SPFN_APP_URL || env.SPFN_APP_URL || '').replace(/\/$/, '');
    const path = env.SPFN_AUTH_PASSWORD_RESET_CONFIRM_PATH || '/password/reset';

    return `${appUrl}${path}?token=${encodeURIComponent(token)}`;
}

async function sendPasswordResetEmail(
    email: string,
    confirmUrl: string,
    expiresInMinutes: number,
): Promise<void>
{
    const result = await sendEmail({
        to: email,
        template: 'password-reset',
        data: { confirmUrl, expiresInMinutes },
    });

    if (!result.success)
    {
        authLogger.email.error('Failed to send password reset email', {
            email,
            error: result.error,
        });
    }
}

/**
 * The account behind a row, if a reset may still land on it.
 *
 * Re-read at every step, not only at request time: an account can be disabled
 * or asked to be deleted while a link sits in a mailbox, and a link issued
 * before that must not still open it.
 */
async function activeUserOf(userId: number)
{
    const user = await usersRepository.findByIdOnPrimary(userId);

    return user?.status === 'active' ? user : null;
}

/**
 * Whether an account may be reset by email.
 *
 * `emailVerifiedAt` set, or a password already on the row. The second half is
 * what makes the rule work on accounts that predate it: the register flows
 * proved the address and then never stamped the column, so every password
 * account would otherwise be locked out of the feature. An OAuth-only account
 * whose provider reported the address unverified has neither, and is excluded —
 * for it, a reset would be a way in built on an address nobody proved.
 */
function isResettable(user: { email: string | null; emailVerifiedAt: Date | null; passwordHash: string | null }): boolean
{
    return Boolean(user.email) && (user.emailVerifiedAt !== null || user.passwordHash !== null);
}

export interface RequestPasswordResetParams
{
    email: string;
    returnPath?: string;
}

export interface RequestPasswordResetResult
{
    success: boolean;
    expiresAt: string;
}

/**
 * Step 1 — issue a reset link for an address.
 *
 * Answers identically for every input: the same status, the same two fields, and
 * an `expiresAt` computed the same way whether or not a row was written. An
 * address with no account, an account that cannot be reset, and an account that
 * can are indistinguishable to the caller — only the first of the three gets
 * mail, and it goes to the owner.
 *
 * Requesting again is how a resend works: every live link for the account is
 * superseded first, so the newest link is the only one that opens, and any setup
 * session already opened from an older link dies with it.
 */
export async function requestPasswordResetService(
    params: RequestPasswordResetParams,
): Promise<RequestPasswordResetResult>
{
    const email = normalizeEmail(params.email);
    const ttlMinutes = env.SPFN_AUTH_PASSWORD_RESET_LINK_TTL_MINUTES ?? 30;

    // Computed before the branch and used by both, so the value cannot vary with
    // whether a row exists to expire.
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const uniformResponse = { success: true, expiresAt: expiresAt.toISOString() };

    // Unconditional: every branch pays for the lookup, and no branch returns
    // before it.
    const user = await usersRepository.findByEmail(email);

    if (!user || user.status !== 'active' || !isResettable(user))
    {
        authLogger.service.info('Password reset request answered without issuing a link');

        return uniformResponse;
    }

    await passwordResetTokensRepository.supersedeAllLiveByUserId(user.id);

    const { secret, hash } = mintCredential();

    await passwordResetTokensRepository.create({
        userId: user.id,
        email: user.email!,
        tokenHash: hash,
        returnPath: params.returnPath ?? null,
        expiresAt,
    });

    await sendPasswordResetEmail(user.email!, buildConfirmUrl(secret), ttlMinutes);

    return uniformResponse;
}

export interface ConfirmPasswordResetParams
{
    token: string;
}

export interface ConfirmPasswordResetResult
{
    email: string;
    returnPath: string | null;
    /** Handed to the proxy interceptor, which moves it into an HttpOnly cookie. */
    setupSecret: string;
    setupExpiresAt: string;
}

/**
 * Step 2 — exchange a link for a password-setup session.
 *
 * Nothing binds the row to a device or a browser, which is what lets someone ask
 * for the link on a laptop and open it on a phone.
 */
export async function confirmPasswordResetService(
    params: ConfirmPasswordResetParams,
): Promise<ConfirmPasswordResetResult>
{
    const row = await passwordResetTokensRepository.findLiveByTokenHash(hashCredential(params.token));

    if (!row)
    {
        authLogger.service.warn('Password reset link refused', { reason: 'unknown, spent or expired' });

        throw new PasswordResetLinkError();
    }

    if (!await activeUserOf(row.userId))
    {
        authLogger.service.warn('Password reset link refused', { reason: 'account is no longer active' });

        throw new PasswordResetLinkError();
    }

    const setupTtlMinutes = env.SPFN_AUTH_PASSWORD_RESET_SETUP_TTL_MINUTES ?? 15;
    const setupExpiresAt = new Date(Date.now() + setupTtlMinutes * 60_000);
    const setup = mintCredential();

    // Conditional update: two confirms racing on one link produce one winner.
    const claimed = await passwordResetTokensRepository.consume(row.id, setup.hash, setupExpiresAt);

    if (!claimed)
    {
        authLogger.service.warn('Password reset link refused', { reason: 'lost the claim race' });

        throw new PasswordResetLinkError();
    }

    return {
        email: claimed.email,
        returnPath: claimed.returnPath,
        setupSecret: setup.secret,
        setupExpiresAt: setupExpiresAt.toISOString(),
    };
}

export interface CompletePasswordResetParams
{
    setupSecret?: string;
    password: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    deviceName?: string;
    platform?: KeyPlatformType;
}

/**
 * Write the new password onto the account and make this browser the only thing
 * signed in.
 *
 * The order is the whole point. Pending device authorizations are denied first,
 * because a poll on an approved one would hand out a fresh active key moments
 * after the revocation — the same reasoning `changePasswordService` records.
 * The revoke-all then runs BEFORE the new device key is registered, never after,
 * or the reset would sign out the browser that performed it.
 *
 * No `oldKeyId` is threaded through the way a login does. A login rotates one
 * key; this retires every one of them, the resetting browser's included, so
 * naming one would be a parameter nothing could change the outcome of.
 */
async function replaceCredentials(
    row: PasswordResetToken,
    user: { id: number; emailVerifiedAt: Date | null },
    params: CompletePasswordResetParams,
): Promise<void>
{
    await usersRepository.updateById(user.id, {
        passwordHash: await hashPassword(params.password),
        passwordChangeRequired: false,
        // The link proved the address; the column should have said so already
        // for accounts created before the register flows stamped it.
        ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
    });

    await deviceAuthorizationsRepository.denyAllActiveByUserId(user.id);
    await keysRepository.revokeAllActiveByUserId(user.id, 'Revoked by password reset');

    await registerPublicKeyService({
        userId: user.id,
        keyId: params.keyId,
        publicKey: params.publicKey,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
    });

    await updateLastLoginService(user.id);

    if (!await passwordResetTokensRepository.complete(row.id))
    {
        authLogger.service.warn('Password reset session refused', { reason: 'lost the claim race' });

        throw new PasswordResetSessionError();
    }
}

/**
 * Step 3 — set the new password, which is what completes the reset.
 *
 * Run under `Transactional()`: the password, the revocations, the new device key
 * and the completion mark commit together. A key registration that failed after
 * the revoke-all would otherwise leave an account with a new password and
 * nothing signed in.
 *
 * A refusal that is the user's to fix — a password the policy rejects, a body
 * with no device key — leaves the setup session usable, so the fix is retyping
 * the password rather than asking for a fresh email.
 */
export async function completePasswordResetService(
    params: CompletePasswordResetParams,
): Promise<RegisterResult>
{
    // Checked before anything is read or claimed. The device key is injected by
    // the proxy interceptor, so its absence means the request did not come
    // through one; left unchecked, the undefined keyId reaches the key lookup
    // and surfaces as a driver-level 500 that names a column list.
    if (!params.publicKey || !params.keyId || !params.fingerprint)
    {
        throw new ValidationError({ message: 'Device key material is required to reset a password' });
    }

    if (!params.setupSecret)
    {
        throw new PasswordResetSessionError();
    }

    const row = await passwordResetTokensRepository.findLiveSetupBySecretHash(hashCredential(params.setupSecret));

    if (!row)
    {
        authLogger.service.warn('Password reset session refused', { reason: 'unknown, spent or expired' });

        throw new PasswordResetSessionError();
    }

    const user = await activeUserOf(row.userId);

    if (!user)
    {
        authLogger.service.warn('Password reset session refused', { reason: 'account is no longer active' });

        throw new PasswordResetSessionError();
    }

    await replaceCredentials(row, user, params);

    onAfterCommit(() => authPasswordResetEvent.emit({
        userId: String(user.id),
        email: row.email,
    }));

    return {
        userId: String(user.id),
        publicId: user.publicId,
        email: user.email || undefined,
        phone: user.phone || undefined,
    };
}
