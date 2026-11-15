/**
 * @spfn/auth - Link Mail Service
 *
 * The four messages that leave through the `auth.link-mail` job: a signup
 * confirmation link, a password reset link, the "you already have an account"
 * notice, and a verification code. Each is also callable directly, which is what the request
 * path does when jobs are not in use — one code path for the send, two for who
 * runs it.
 *
 * They live here rather than beside the request services that also call them
 * because the job imports them and those services enqueue the job: putting them
 * in the service files would make the request path, the queue and the worker one
 * import cycle.
 *
 * The link token is minted here, moments before the mail goes out, and never on
 * the request that wrote the row. That is the whole point of the queue carrying
 * a row id: the plaintext credential exists in the mail and nowhere else — not
 * in `pgboss.job`, not in a log line. Nothing in this file logs a URL or a token.
 */

import { env } from '@spfn/auth/config';
import { sendEmail, sendSMS } from '@spfn/notification/server';
import { authLogger } from '../logger';
import { buildConfirmUrl, mintCredential } from '../lib/link-credentials';
import { passwordResetTokensRepository, signupLinkTokensRepository, verificationCodesRepository } from '../repositories';
import type { VerificationTargetType } from '../routes/schema';

/**
 * Verification code expiry (5 minutes)
 */
export const VERIFICATION_CODE_EXPIRY_MINUTES = 5;

/**
 * Mint the signup link for a pending row and mail it.
 *
 * A row that was superseded, consumed, completed or expired between the request
 * and this call is not issued and gets no mail: `issue` decides that in the same
 * statement that would write the hash, so a stale row can never be handed a
 * credential.
 *
 * A failed send throws, which is what makes pg-boss retry, and the retry mints
 * again — the token of the failed attempt stops matching the row. Nothing runs
 * after the send that could throw and so retry a mail already delivered.
 *
 * @param rowId - `signup_link_tokens` row written by the request
 */
export async function issueSignupLink(rowId: number): Promise<void>
{
    const { secret, hash } = mintCredential();
    const row = await signupLinkTokensRepository.issue(rowId, hash);

    if (!row)
    {
        authLogger.service.info('Signup link not issued', { reason: 'no longer deliverable' });

        return;
    }

    const result = await sendEmail({
        to: row.email,
        template: 'signup-link',
        data: {
            confirmUrl: buildConfirmUrl(env.SPFN_AUTH_SIGNUP_CONFIRM_PATH || '/signup/confirm', secret),
            expiresInMinutes: env.SPFN_AUTH_SIGNUP_LINK_TTL_MINUTES ?? 30,
        },
    });

    if (!result.success)
    {
        authLogger.email.error('Failed to send signup link email', { email: row.email, error: result.error });

        throw new Error(`[auth.link-mail] signup-link row ${rowId} could not be sent`);
    }
}

/**
 * Mint the reset link for a pending row and mail it.
 *
 * Same shape and same reasoning as `issueSignupLink` above, on the other table.
 *
 * @param rowId - `password_reset_tokens` row written by the request
 */
export async function issuePasswordResetLink(rowId: number): Promise<void>
{
    const { secret, hash } = mintCredential();
    const row = await passwordResetTokensRepository.issue(rowId, hash);

    if (!row)
    {
        authLogger.service.info('Password reset link not issued', { reason: 'no longer deliverable' });

        return;
    }

    const result = await sendEmail({
        to: row.email,
        template: 'password-reset',
        data: {
            confirmUrl: buildConfirmUrl(env.SPFN_AUTH_PASSWORD_RESET_CONFIRM_PATH || '/password/reset', secret),
            expiresInMinutes: env.SPFN_AUTH_PASSWORD_RESET_LINK_TTL_MINUTES ?? 30,
        },
    });

    if (!result.success)
    {
        authLogger.email.error('Failed to send password reset email', { email: row.email, error: result.error });

        throw new Error(`[auth.link-mail] password-reset row ${rowId} could not be sent`);
    }
}

/**
 * Notify the owner that someone tried to sign up with their (already-registered)
 * address — instead of sending a usable signup code. UX hint + security tripwire.
 *
 * Carries no credential, so a failure is logged rather than thrown: retrying a
 * notice that says only "someone tried" would be more mail to a mailbox the
 * dedupe window exists to protect.
 */
export async function sendAccountExistsNotice(
    target: string,
    targetType: VerificationTargetType,
): Promise<void>
{
    const result = targetType === 'email'
        ? await sendEmail({ to: target, template: 'account-exists', data: {} })
        : await sendSMS({ to: target, template: 'account-exists', data: {} });

    if (!result.success)
    {
        const log = targetType === 'email' ? authLogger.email : authLogger.sms;
        log.error('Failed to send account-exists notice', { target, error: result.error });
    }
}

/**
 * Send the verification code a request stored, by the channel its target names.
 *
 * The request that stored the code does not wait for this: whether a send for
 * an address with an account (a notice, or nothing inside the notice window)
 * and one without (a code) reach a provider must not show in how long the
 * request took. A code superseded, used or expired by now is not sent.
 *
 * A refused send throws, so the worker retries it; the code is the same row and
 * stays valid until it expires.
 *
 * @param rowId - `verification_codes` row written by the request
 */
export async function sendVerificationCode(rowId: number): Promise<void>
{
    const row = await verificationCodesRepository.findDeliverable(rowId);

    if (!row)
    {
        authLogger.service.info('Verification code not sent', { reason: 'no longer deliverable' });

        return;
    }

    const result = row.targetType === 'email'
        ? await sendEmail({
            to: row.target,
            template: 'verification-code',
            data: { code: row.code, purpose: row.purpose, expiresInMinutes: VERIFICATION_CODE_EXPIRY_MINUTES },
        })
        : await sendSMS({
            to: row.target,
            template: 'verification-code',
            data: { code: row.code, expiresInMinutes: VERIFICATION_CODE_EXPIRY_MINUTES },
        });

    if (!result.success)
    {
        const log = row.targetType === 'email' ? authLogger.email : authLogger.sms;
        log.error('Failed to send verification code', { purpose: row.purpose, error: result.error });

        throw new Error(`[auth.link-mail] verification-code row ${rowId} could not be sent`);
    }
}
