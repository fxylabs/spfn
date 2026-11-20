/**
 * @spfn/auth - Account Deletion Routes
 *
 * - POST /_auth/deletion/request: self-service deletion request (authenticated,
 *   step-up and recent authentication gated — revokes all sessions on success)
 * - POST /_auth/deletion/cancel: recovery within the grace period (credential-based,
 *   public — sessions were revoked at request time so there's no Bearer token)
 */

import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { defineRouter, route } from '@spfn/core/route';

import { EmailSchema, PhoneSchema } from '../schema';
import { getAuth } from '../../helpers';
import { requestAccountDeletionService, cancelAccountDeletionService } from '../../services';
import { byIpAndAccount } from '../../lib/rate-limit-keys';
import { deviceProvenance } from '../../lib/device-provenance';

/**
 * POST /_auth/deletion/request - Request account deletion (authenticated)
 *
 * The gates every sensitive change passes: an account with a second factor
 * re-proves it on this device (403 `STEP_UP_REQUIRED`), and the session's
 * credential authenticated recently — never an application profile's — or the
 * body carries the account `password` (403 `RECENT_AUTH_REQUIRED`); a
 * passwordless account signs in again.
 *
 * On success: the account's deletion -> pending (its status is left as it is),
 * all sessions revoked, purge scheduled `deletion.gracePeriodDays` days out (or
 * immediately, if `immediate: true` and the server has
 * `deletion.allowSelfImmediate` enabled).
 */
export const requestAccountDeletion = route.post('/_auth/deletion/request')
    .input({
        body: Type.Object({
            password: Type.Optional(Type.String({ minLength: 1, description: 'Current password, for a session that did not authenticate recently' })),
            reason: Type.Optional(Type.String({ maxLength: 500, description: 'Optional free-text reason' })),
            immediate: Type.Optional(Type.Boolean({ description: 'Skip the grace period — requires deletion.allowSelfImmediate on the server' })),
        }),
    })
    .use([rateLimitPolicy('auth-deletion-request', { limit: 5, windowMs: 60_000 }), Transactional()])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId, credential } = getAuth(c);

        const result = await requestAccountDeletionService(Number(userId), {
            requestedBy: 'self',
            credential,
            password: body.password,
            reason: body.reason,
            immediate: body.immediate,
        });

        return {
            purgeScheduledAt: result.purgeScheduledAt.toISOString(),
        };
    });

/**
 * POST /_auth/deletion/cancel - Cancel a pending deletion (recovery, public)
 *
 * Credential-based since the account's sessions were revoked when deletion was
 * requested: email/phone, and the password or a verification token (purpose
 * `account_deletion`, from `/_auth/codes` + `/_auth/codes/verify`) for the
 * account's e-mail or phone — either one, whether or not the account has a
 * password. A token cancels once. On success the deletion is cleared and the
 * status left as it is; the user still needs to log in separately afterward.
 *
 * No `Transactional()`, for `login`'s reason: with the app's `signIn` guard
 * configured a wrong password is recorded, and the record has to survive the
 * 401. The service claims the cancellation in a transaction of its own.
 */
export const cancelAccountDeletion = route.post('/_auth/deletion/cancel')
    .input({
        body: Type.Object({
            email: Type.Optional(EmailSchema),
            phone: Type.Optional(PhoneSchema),
            password: Type.Optional(Type.String({ minLength: 1 })),
            verificationToken: Type.Optional(Type.String({ description: 'Verification token (purpose: account_deletion) for the account\'s e-mail or phone; single use' })),
        }, {
            minProperties: 2, // email/phone + password|verificationToken
            description: 'Email or phone must be provided with password or verificationToken',
        }),
    })
    .use([rateLimitPolicy('auth-deletion-cancel', { limit: 10, windowMs: 60_000, by: byIpAndAccount({ ipLimit: 50 }) })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        await cancelAccountDeletionService({ ...body, ...deviceProvenance(c.raw) });

        return c.noContent();
    });

// Export router
export const deletionRouter = defineRouter({
    requestAccountDeletion: requestAccountDeletion,
    cancelAccountDeletion: cancelAccountDeletion,
});
