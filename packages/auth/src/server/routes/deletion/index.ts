/**
 * @spfn/auth - Account Deletion Routes
 *
 * - POST /_auth/deletion/request: self-service deletion request (re-auth gated,
 *   authenticated — revokes all sessions on success)
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

/**
 * POST /_auth/deletion/request - Request account deletion (authenticated)
 *
 * Re-auth gate: password holders confirm with `password`; OAuth-only/passwordless
 * users confirm with a `verificationToken` obtained via
 * `/_auth/codes` + `/_auth/codes/verify` (purpose: `account_deletion`).
 *
 * On success: status -> pending_deletion, all sessions revoked, purge scheduled
 * `deletion.gracePeriodDays` days out (or immediately, if `immediate: true` and the
 * server has `deletion.allowSelfImmediate` enabled).
 */
export const requestAccountDeletion = route.post('/_auth/deletion/request')
    .input({
        body: Type.Object({
            password: Type.Optional(Type.String({ minLength: 1, description: 'Current password, if the account has one' })),
            verificationToken: Type.Optional(Type.String({ description: 'Verification token (purpose: account_deletion), for passwordless/OAuth-only accounts' })),
            reason: Type.Optional(Type.String({ maxLength: 500, description: 'Optional free-text reason' })),
            immediate: Type.Optional(Type.Boolean({ description: 'Skip the grace period — requires deletion.allowSelfImmediate on the server' })),
        }),
    })
    .use([rateLimitPolicy('auth-deletion-request', { limit: 5, windowMs: 60_000 }), Transactional()])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId } = getAuth(c);

        const result = await requestAccountDeletionService(Number(userId), {
            requestedBy: 'self',
            password: body.password,
            verificationToken: body.verificationToken,
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
 * Credential-based (email/phone + password or verification code) since the
 * account's sessions were revoked when deletion was requested. On success,
 * status -> active; the user still needs to log in separately afterward.
 */
export const cancelAccountDeletion = route.post('/_auth/deletion/cancel')
    .input({
        body: Type.Object({
            email: Type.Optional(EmailSchema),
            phone: Type.Optional(PhoneSchema),
            password: Type.Optional(Type.String({ minLength: 1 })),
            verificationToken: Type.Optional(Type.String({ description: 'Verification token (purpose: account_deletion), for passwordless/OAuth-only accounts' })),
        }, {
            minProperties: 2, // email/phone + password|verificationToken
            description: 'Email or phone must be provided with password or verificationToken',
        }),
    })
    .use([rateLimitPolicy('auth-deletion-cancel', { limit: 10, windowMs: 60_000, by: byIpAndAccount({ ipLimit: 50 }) }), Transactional()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        await cancelAccountDeletionService(body);

        return c.noContent();
    });

// Export router
export const deletionRouter = defineRouter({
    requestAccountDeletion: requestAccountDeletion,
    cancelAccountDeletion: cancelAccountDeletion,
});
