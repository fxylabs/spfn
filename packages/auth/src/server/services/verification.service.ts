/**
 * @spfn/auth - Verification Service
 *
 * Handles OTP code generation, validation, and delivery
 */

import crypto from 'crypto';
import { env } from '@spfn/auth/config';
import { InvalidVerificationCodeError } from '@spfn/auth/errors';
import jwt from 'jsonwebtoken';
import { sendEmail, sendSMS } from '@spfn/notification/server';
import { authLogger } from '../logger';
import { normalizeEmail } from '../helpers/email';
import { verificationCodesRepository, usersRepository } from '../repositories';
import { deliverLinkMail } from '../lib/link-mail-delivery';
import { sendAccountExistsNotice } from './link-mail.service';
import type { VerificationTargetType, VerificationPurpose } from '../routes/schema';

/**
 * How long to suppress repeat "account already exists" notices to the same target.
 * Bounds the notice to ~once per window so the signup endpoint can't be used to
 * email-bomb an existing account's owner.
 */
const ACCOUNT_EXISTS_NOTICE_DEDUPE_MINUTES = 60;

/**
 * Verification token expiry (15 minutes)
 */
const VERIFICATION_TOKEN_EXPIRY = '15m';

/**
 * Verification code expiry (5 minutes)
 */
const VERIFICATION_CODE_EXPIRY_MINUTES = 5;

/**
 * Maximum verification attempts before code expires
 */
const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * Verification token payload
 */
export interface VerificationTokenPayload
{
    target: string;
    targetType: VerificationTargetType;
    purpose: VerificationPurpose;
    codeId: number;
}

/**
 * Canonical form of a verification target.
 *
 * A code is stored under the target it was sent to and looked up by the target
 * typed at the verify step, both by exact match. Without this, a user who typed
 * their address one way to request the code and another way to enter it gets a
 * valid code refused as invalid — the address is the lookup key, so the two
 * spellings address different rows.
 *
 * Phone numbers are already canonical (E.164 is validated on the way in) and
 * have no case, so only email is folded.
 *
 * @param target - Email address or E.164 phone number as supplied
 * @param targetType - Which of the two it is
 */
function normalizeVerificationTarget(target: string, targetType: VerificationTargetType): string
{
    return targetType === 'email' ? normalizeEmail(target) : target.trim();
}

/**
 * Generate a random 6-digit verification code
 *
 * @returns 6-digit code as string
 */
export function generateVerificationCode(): string
{
    // Generate random 6-digit number (000000 - 999999) using a CSPRNG —
    // Math.random() is predictable and must never gate auth/reset codes
    return crypto.randomInt(0, 1000000)
        .toString()
        .padStart(6, '0');
}

/**
 * Store verification code in database
 *
 * @param target - Email or phone number
 * @param targetType - Type of target (email or phone)
 * @param code - 6-digit verification code
 * @param purpose - Purpose of verification
 * @returns Created verification code record
 */
async function storeVerificationCode(
    target: string,
    targetType: VerificationTargetType,
    code: string,
    purpose: VerificationPurpose,
)
{
    // Calculate expiry time
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + VERIFICATION_CODE_EXPIRY_MINUTES);

    // Invalidate previous codes for same target/purpose
    await verificationCodesRepository.invalidatePreviousCodes(target, purpose);

    // Create verification code record
    return await verificationCodesRepository.create({
        target,
        targetType,
        code,
        purpose,
        expiresAt,
        attempts: 0,
    });
}

/**
 * Validate verification code
 *
 * @param target - Email or phone number
 * @param code - 6-digit code to validate
 * @param purpose - Purpose of verification
 * @returns Validation result with code ID if valid
 */
async function validateVerificationCode(
    target: string,
    code: string,
    purpose: VerificationPurpose,
): Promise<{ valid: boolean; codeId?: number; error?: string }>
{
    // Find the verification code
    const record = await verificationCodesRepository.findValidByTargetAndPurpose(target, purpose);

    if (!record)
    {
        return { valid: false, error: 'Invalid verification code' };
    }

    // Enforce the attempt cap on EVERY attempt — BEFORE the code comparison.
    // Previously this ran only after a correct match (the wrong-code branch returns
    // early), so it was dead code: wrong guesses incremented `attempts` forever but
    // were never blocked — unlimited OTP brute force (account takeover via
    // password_reset). findValidByTargetAndPurpose does not filter on attempts, so
    // the cap must be enforced here.
    if (record.attempts >= MAX_VERIFICATION_ATTEMPTS)
    {
        return { valid: false, error: 'Too many attempts, please request a new code' };
    }

    // Check if code matches
    if (record.code !== code)
    {
        // Increment attempt count
        await verificationCodesRepository.incrementAttempts(record.id);

        return { valid: false, error: 'Invalid verification code' };
    }

    // Check if code is already used
    if (record.usedAt)
    {
        return { valid: false, error: 'Verification code already used' };
    }

    // Check if code is expired
    if (new Date() > new Date(record.expiresAt))
    {
        return { valid: false, error: 'Verification code expired' };
    }

    return { valid: true, codeId: record.id };
}

/**
 * Mark verification code as used
 *
 * @param codeId - Verification code ID
 */
async function markCodeAsUsed(codeId: number): Promise<void>
{
    await verificationCodesRepository.markAsUsed(codeId);
}

/**
 * Create verification token (JWT)
 *
 * @param payload - Token payload
 * @returns Signed JWT token
 */
export function createVerificationToken(payload: VerificationTokenPayload): string
{
    return jwt.sign(payload, env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET!, {
        expiresIn: VERIFICATION_TOKEN_EXPIRY,
        issuer: 'spfn-auth',
        audience: 'spfn-client',
    });
}

/**
 * Validate verification token (JWT)
 *
 * @param token - JWT token to validate
 * @returns Decoded payload if valid, null otherwise
 */
export function validateVerificationToken(token: string): VerificationTokenPayload | null
{
    try
    {
        const decoded = jwt.verify(token, env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET!, {
            issuer: 'spfn-auth',
            audience: 'spfn-client',
        });

        // Validate that decoded has required properties
        if (
            typeof decoded === 'object' &&
            decoded !== null &&
            'target' in decoded &&
            'targetType' in decoded &&
            'purpose' in decoded &&
            'codeId' in decoded
        )
        {
            return decoded as VerificationTokenPayload;
        }

        return null;
    }
    catch (error)
    {
        authLogger.service.error('Failed to validate verification token', { error });

        return null;
    }
}

/**
 * Send verification code via email
 *
 * @param email - Email address
 * @param code - 6-digit verification code
 * @param purpose - Purpose of verification
 */
async function sendVerificationEmail(
    email: string,
    code: string,
    purpose: string,
): Promise<void>
{
    const result = await sendEmail({
        to: email,
        template: 'verification-code',
        data: {
            code,
            purpose,
            expiresInMinutes: VERIFICATION_CODE_EXPIRY_MINUTES,
        },
    });

    if (!result.success)
    {
        authLogger.email.error('Failed to send verification email', {
            email,
            purpose,
            error: result.error,
        });
    }
}

/**
 * Send verification code via SMS
 *
 * @param phone - Phone number in E.164 format
 * @param code - 6-digit verification code
 * @param purpose - Purpose of verification
 */
async function sendVerificationSMS(
    phone: string,
    code: string,
    purpose: string,
): Promise<void>
{
    const result = await sendSMS({
        to: phone,
        template: 'verification-code',
        data: {
            code,
            expiresInMinutes: VERIFICATION_CODE_EXPIRY_MINUTES,
        },
    });

    if (!result.success)
    {
        authLogger.sms.error('Failed to send verification SMS', {
            phone,
            purpose,
            error: result.error,
        });
    }
}

/**
 * Whether an account already exists for the given target.
 */
async function accountExistsForTarget(
    target: string,
    targetType: VerificationTargetType,
): Promise<boolean>
{
    const user = targetType === 'email'
        ? await usersRepository.findByEmail(target)
        : await usersRepository.findByPhone(target);

    return !!user;
}

/**
 * Tell the owner that someone tried to sign up with their address, at most once
 * per dedupe window.
 *
 * Every signup entry point routes its "account already exists" case here rather
 * than notifying on its own, so the window is shared. Two entry points with a
 * window each would let an attacker alternate between them and deliver twice as
 * many notices as either one permits — the email-bombing this dedupe exists to
 * prevent.
 *
 * The window is kept as an undelivered marker row in `verification_codes`: the
 * code it carries is never sent and is unusable, since registration refuses an
 * existing account regardless. Only its timestamp matters.
 *
 * Only the bookkeeping runs here. The notice itself leaves through
 * `auth.link-mail`, so the signup branch that finds an account costs the same as
 * the one that does not — the mail is what used to make the two distinguishable
 * by how long they took.
 *
 * @param target - Email address or E.164 phone number
 * @param targetType - Type of target (email or phone)
 */
export async function noticeAccountExistsOnce(
    target: string,
    targetType: VerificationTargetType,
): Promise<void>
{
    const recentNotice = await verificationCodesRepository.findValidByTargetAndPurpose(target, 'registration');

    if (recentNotice)
    {
        return;
    }

    const dedupeExpiresAt = new Date(Date.now() + ACCOUNT_EXISTS_NOTICE_DEDUPE_MINUTES * 60_000);
    await verificationCodesRepository.invalidatePreviousCodes(target, 'registration');
    await verificationCodesRepository.create({
        target,
        targetType,
        code: generateVerificationCode(),
        purpose: 'registration',
        expiresAt: dedupeExpiresAt,
        attempts: 0,
    });

    await deliverLinkMail(
        { kind: 'account-exists', target, targetType },
        () => sendAccountExistsNotice(target, targetType),
    );
}

export interface SendVerificationCodeParams
{
    target: string;
    targetType: VerificationTargetType;
    purpose: VerificationPurpose;
}

export interface SendVerificationCodeResult
{
    success: boolean;
    expiresAt: string;
}

export interface VerifyCodeParams
{
    target: string;
    targetType: VerificationTargetType;
    code: string;
    purpose: VerificationPurpose;
}

export interface VerifyCodeResult
{
    valid: boolean;
    verificationToken: string;
}

/**
 * Send verification code via email or SMS
 */
export async function sendVerificationCodeService(
    params: SendVerificationCodeParams,
): Promise<SendVerificationCodeResult>
{
    const { targetType, purpose } = params;
    const target = normalizeVerificationTarget(params.target, targetType);

    // Registration to an already-registered target: don't send a usable signup code
    // (the account exists). Notify the owner instead — but return the SAME response
    // as the new-account path so existence can't be probed (no enumeration), and
    // dedupe so this can't be used to email-bomb the owner.
    if (purpose === 'registration' && await accountExistsForTarget(target, targetType))
    {
        await noticeAccountExistsOnce(target, targetType);

        // Uniform response shape (indistinguishable from a real code send).
        return {
            success: true,
            expiresAt: new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MINUTES * 60_000).toISOString(),
        };
    }

    // Generate 6-digit verification code
    const code = generateVerificationCode();

    // Store code in database
    const codeRecord = await storeVerificationCode(target, targetType, code, purpose);

    // Send code via email or SMS
    if (targetType === 'email')
    {
        await sendVerificationEmail(target, code, purpose);
    }
    else
    {
        await sendVerificationSMS(target, code, purpose);
    }

    return {
        success: true,
        expiresAt: codeRecord.expiresAt.toISOString(),
    };
}

/**
 * Verify OTP code and return verification token
 */
export async function verifyCodeService(params: VerifyCodeParams)
{
    const { targetType, code, purpose } = params;
    const target = normalizeVerificationTarget(params.target, targetType);

    // Validate the verification code
    const validation = await validateVerificationCode(target, code, purpose);

    if (!validation.valid)
    {
        throw new InvalidVerificationCodeError({ message: validation.error || 'Invalid verification code' });
    }

    // Mark code as used
    await markCodeAsUsed(validation.codeId!);

    // Create verification token (15 min validity)
    const verificationToken = createVerificationToken({
        target,
        targetType,
        purpose,
        codeId: validation.codeId!,
    });

    return {
        valid: true,
        verificationToken,
    };
}
