/**
 * @spfn/auth - Verification Service
 *
 * Handles OTP code generation, validation, and delivery
 */

import crypto from 'crypto';
import { env } from '@spfn/auth/config';
import { PHONE_PATTERN } from '@spfn/auth';
import { InvalidVerificationCodeError } from '@spfn/auth/errors';
import { ValidationError } from '@spfn/core/errors';
import jwt from 'jsonwebtoken';
import { Value } from '@sinclair/typebox/value';
import { authLogger } from '../logger';
import { normalizeEmail } from '../helpers/email';
import { accountExistsNoticesRepository, verificationCodesRepository, usersRepository } from '../repositories';
import { deliverLinkMail } from '../lib/link-mail-delivery';
import { sendAccountExistsNotice, sendVerificationCode, VERIFICATION_CODE_EXPIRY_MINUTES } from './link-mail.service';
import { EmailSchema, type VerificationTargetType, type VerificationPurpose } from '../routes/schema';

/**
 * How long to suppress repeat "account already exists" notices to the same target.
 * Bounds the notice to ~once per window so the signup endpoint can't be used to
 * email-bomb an existing account's owner.
 */
const ACCOUNT_EXISTS_NOTICE_DEDUPE_MINUTES = 60;

/**
 * The code stored for a registration on an address that already has an account.
 *
 * The row exists so the verify route reads, counts and refuses exactly as it
 * does for an address without one. It is never sent, and the verify route only
 * accepts six digits, so nothing submitted can match it.
 */
const NEVER_SENT_CODE = 'never-sent';

/**
 * Verification token expiry (15 minutes), and with it the code row the token spends.
 *
 * The two lifetimes of a code are tied here so they cannot drift. A code can be
 * verified until its own expiry; the token verifying it mints outlives that,
 * and the code's row is what makes the token single-use (`spendToken` deletes
 * it). So verifying moves the row's `expiresAt` to the token's expiry
 * (`markCodeAsUsed`), the token is signed to expire at that same moment, and
 * `deleteExpired`, which sweeps by `expiresAt`, removes an unverified row at
 * its own expiry and a verified one once its token can no longer be presented.
 */
const VERIFICATION_TOKEN_EXPIRY_MINUTES = 15;

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
 * Phone numbers are already canonical (E.164 is validated before a code is
 * sent, see `assertDeliverableTarget`) and have no case, so only email is folded.
 *
 * @param target - Email address or E.164 phone number as supplied
 * @param targetType - Which of the two it is
 */
function normalizeVerificationTarget(target: string, targetType: VerificationTargetType): string
{
    return targetType === 'email' ? normalizeEmail(target) : target.trim();
}

/**
 * The longest address a mailer takes: RFC 5321's 256-octet path less its two
 * angle brackets.
 */
const EMAIL_TARGET_MAX_LENGTH = 254;

/**
 * Refuse a target its type cannot be delivered to, before anything is stored or sent.
 *
 * The route declares `target` as a plain string because its shape depends on
 * `targetType`. Unchecked, an SMS went to whatever string was named, which is
 * an SMS-pumping surface: a phone target must be E.164.
 *
 * An email target for a registration must be what `/_auth/register` accepts
 * (`EmailSchema`): a code for an address that can never sign up is useless.
 * For every other purpose it addresses an account's existing e-mail, which
 * this system may have stored with no format check — from an OAuth provider,
 * from an invitation — and for an account with no password a code to that
 * address is the only way to delete it. So those are held only to
 * `isAddressable`, which plus-addressing and internationalised domains pass.
 */
function assertDeliverableTarget(target: string, targetType: VerificationTargetType, purpose: VerificationPurpose): void
{
    const deliverable = targetType === 'phone'
        ? new RegExp(PHONE_PATTERN).test(target)
        : isAddressable(target) && (purpose !== 'registration' || Value.Check(EmailSchema, target));

    if (!deliverable)
    {
        const shape = targetType === 'phone' ? 'a phone number in E.164 format' : 'an email address';
        throw new ValidationError({ message: `target must be ${shape} when targetType is ${targetType}` });
    }
}

/**
 * What no account can hold as its address and no mailer should be handed:
 * anything but exactly one `@` between a non-empty local part and a non-empty
 * domain, any control character (CR and LF among them — a header injection
 * once the address reaches a mail header) or whitespace, any character that
 * makes the address display as another or is invisible — a bidi control
 * (marks, overrides, isolates) or any default-ignorable code point (zero-width
 * space, soft hyphen, variation selectors) — or more than
 * `EMAIL_TARGET_MAX_LENGTH` characters. Nothing stricter: a pattern here would
 * refuse addresses accounts already hold.
 *
 * ZWNJ and ZWJ (U+200C, U+200D) are default-ignorable but stay allowed:
 * IDNA2008 permits them inside Persian, Arabic and Indic domain labels, an
 * OAuth sign-up can store such an address, and for an account with no password
 * an `account_deletion` code to it is the only way to delete it.
 */
function isAddressable(target: string): boolean
{
    const parts = target.split('@');

    return target.length <= EMAIL_TARGET_MAX_LENGTH
        && !/[\p{Cc}\s\p{Bidi_Control}]|(?![\u200C\u200D])\p{Default_Ignorable_Code_Point}/u.test(target)
        && parts.length === 2
        && parts.every(part => part.length > 0);
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
 * Mark a verified code used, and keep its row for as long as the token minted
 * from it lives (`VERIFICATION_TOKEN_EXPIRY_MINUTES`).
 *
 * @param codeId - Verification code ID
 * @returns when the token minted from it expires
 */
async function markCodeAsUsed(codeId: number): Promise<Date>
{
    const tokenExpiresAt = verificationTokenExpiry();
    await verificationCodesRepository.markAsUsed(codeId, tokenExpiresAt);

    return tokenExpiresAt;
}

function verificationTokenExpiry(): Date
{
    return new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MINUTES * 60_000);
}

/**
 * Create verification token (JWT)
 *
 * @param payload - Token payload
 * @param expiresAt - When it expires: the expiry its code row was given. Rounded
 *   down to the second a JWT counts in, so the token never outlives the row.
 * @returns Signed JWT token
 */
export function createVerificationToken(payload: VerificationTokenPayload, expiresAt = verificationTokenExpiry()): string
{
    return jwt.sign({ ...payload, exp: Math.floor(expiresAt.getTime() / 1000) }, env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET!, {
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
 * Whether an account already exists for the given target.
 *
 * An address counts in any stored case, so a row the boot backfill left in
 * another case still answers "exists".
 */
async function accountExistsForTarget(
    target: string,
    targetType: VerificationTargetType,
): Promise<boolean>
{
    return targetType === 'email'
        ? (await usersRepository.findByFoldedEmail(target)).kind !== 'none'
        : !!(await usersRepository.findByPhone(target));
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
 * The window is a row of `account_exists_notices`, keyed by the folded address
 * so that writing it in another case is the same window. Nothing that verifies
 * a code reads it.
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
    const folded = normalizeVerificationTarget(target, targetType);

    if (!await accountExistsNoticesRepository.claimWindow(folded, ACCOUNT_EXISTS_NOTICE_DEDUPE_MINUTES * 60_000))
    {
        return;
    }

    await deliverLinkMail(
        { kind: 'account-exists', target: folded, targetType },
        () => sendAccountExistsNotice(folded, targetType),
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

    assertDeliverableTarget(target, targetType, purpose);

    // Registration to an already-registered target sends no usable code: the
    // owner gets a notice instead, deduped so this cannot mail-bomb them. A code
    // row is stored either way, so the answer here and every answer of the
    // verify route are the ones an address without an account gets. Neither
    // branch waits for a provider: the notice and the code both leave through
    // `auth.link-mail` or after the request, so the answer does not take longer
    // for the branch that sends something.
    const accountExists = purpose === 'registration' && await accountExistsForTarget(target, targetType);
    const code = accountExists ? NEVER_SENT_CODE : generateVerificationCode();
    const codeRecord = await storeVerificationCode(target, targetType, code, purpose);

    if (accountExists)
    {
        await noticeAccountExistsOnce(target, targetType);
    }
    else
    {
        await deliverLinkMail(
            { kind: 'verification-code', rowId: codeRecord.id },
            () => sendVerificationCode(codeRecord.id),
        );
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

    const verificationToken = createVerificationToken({
        target,
        targetType,
        purpose,
        codeId: validation.codeId!,
    }, await markCodeAsUsed(validation.codeId!));

    return {
        valid: true,
        verificationToken,
    };
}
