/**
 * @spfn/auth - Second Factor Routes
 *
 * Enrolling, inspecting and removing an optional second factor, plus the
 * re-verification a device uses to open its step-up window.
 *
 * Two of them are not authenticated and cannot be: `verify` and
 * `verify/options` finish a sign-in whose device key is inactive until they
 * succeed, so there is nothing yet to sign the call with. The challenge secret
 * is their whole credential, it names one registration, and it buys nothing
 * else. Every other route here is authenticated. Four of those — enrol, disable,
 * mark a passkey, regenerate recovery codes — are additionally gated on
 * `assertStepUp`, because each one changes what the second factor is, and a
 * stolen session alone must not be able to do that. For an account with nothing
 * enrolled that gate is a no-op, so none of these is a new refusal for anybody
 * who has not opted in.
 *
 * `confirm` and `step-up` carry the `auth-mfa-verify` policy, the same numbers
 * as `auth-login`: both take a guessable six-digit value, so they are bounded
 * the way the other route taking a guessable value is.
 *
 * The plaintext secret and the plaintext recovery codes leave the server in
 * three response bodies and nowhere else. `status` carries neither.
 */

import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { route } from '@spfn/core/route';

import { getAuth } from '../../helpers';
import { byIpAndCaller } from '../../lib/rate-limit-keys';
import {
    assertStepUp,
    confirmTotpEnrolmentService,
    disableMfaService,
    markPasskeySecondFactorService,
    mfaStatusService,
    regenerateRecoveryCodesService,
    startMfaChallengeAssertionService,
    startStepUpService,
    startTotpEnrolmentService,
    stepUpService,
    verifyMfaChallengeService,
} from '../../services';

/**
 * The limit `confirm` and `step-up` share.
 *
 * `auth-login`'s numbers, because the exposure is the same: a six-digit value a
 * caller could try repeatedly. Keyed by IP and caller rather than
 * `byIpAndAccount`, since none of these bodies carries an identifier — the
 * account is the session.
 */
const VERIFY_LIMIT = { limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }) };

const TotpCodeSchema = Type.String({
    minLength: 1,
    maxLength: 32,
    description: 'The six digits from the authenticator app. Spaces and dashes are ignored.',
});

const RecoveryCodeSchema = Type.String({
    minLength: 1,
    maxLength: 32,
    description: 'One of the xxxxx-xxxxx codes issued at enrolment. Single use.',
});

/**
 * The assertion from a passkey marked as a second factor, passed through as it
 * arrived — the WebAuthn library decides what a valid response is, as it does
 * on the passkey routes.
 */
const AssertionSchema = Type.Unknown({
    description: 'The credential from @simplewebauthn/browser, passed through unchanged',
});

const PasskeyIdSchema = Type.String({
    pattern: '^[0-9]{1,19}$',
    description: 'Passkey identifier, as returned by the passkey list',
});

/**
 * POST /_auth/mfa/totp/enroll - Mint a TOTP secret
 *
 * Answers the secret and the `otpauth://` URI once. Nothing is enrolled until
 * `confirm` spends a code against it, so an abandoned call gates nothing and is
 * swept a day later. A confirmed enrolment is a 409.
 */
export const mfaTotpEnroll = route.post('/_auth/mfa/totp/enroll')
    .input({
        body: Type.Object({}),
    })
    .use([Transactional()])
    .handler(async (c) =>
    {
        const { userId, keyId } = getAuth(c);

        await assertStepUp({ userId: Number(userId), keyId });

        return await startTotpEnrolmentService(Number(userId));
    });

/**
 * POST /_auth/mfa/totp/confirm - Spend the first code
 *
 * Not step-up gated: this *is* the step-up, and gating it would make enrolling
 * impossible for the account it is being enrolled on. Five wrong codes discard
 * the pending secret, and the sixth attempt says there is nothing to confirm.
 *
 * No `Transactional()`, which is the one route here without it. The
 * failed-attempt counter has to survive the refusal that increments it, and a
 * route-wide transaction would roll it back with the error — leaving a wrong
 * code free. The service opens its own transaction for the success path, where
 * the confirmation, the recovery codes and the first verification do have to
 * commit together.
 */
export const mfaTotpConfirm = route.post('/_auth/mfa/totp/confirm')
    .input({
        body: Type.Object({
            code: TotpCodeSchema,
        }),
    })
    .use([rateLimitPolicy('auth-mfa-verify', VERIFY_LIMIT)])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId, keyId } = getAuth(c);

        return await confirmTotpEnrolmentService({ userId: Number(userId), keyId, code: body.code });
    });

/**
 * POST /_auth/mfa/disable - Remove the second factor
 *
 * 204 whether or not anything was enrolled: "make sure MFA is off" has already
 * succeeded on an account that never turned it on, and answering a 400 there
 * would tell an unauthenticated guess nothing useful and an owner nothing true.
 */
export const mfaDisable = route.post('/_auth/mfa/disable')
    .input({
        body: Type.Object({}),
    })
    .use([Transactional()])
    .handler(async (c) =>
    {
        const { userId, keyId } = getAuth(c);

        await assertStepUp({ userId: Number(userId), keyId });
        await disableMfaService(Number(userId));

        return c.noContent();
    });

/**
 * POST /_auth/mfa/passkey/mark - Make a passkey count as a second factor
 *
 * Unmarking the last marked credential is allowed and leaves the account
 * unenrolled. Independent of the last-recovery-credential guard on
 * `passkeys/revoke`: that one protects a way *into* the account, and this
 * removes a mark rather than a credential.
 */
export const mfaMarkPasskey = route.post('/_auth/mfa/passkey/mark')
    .input({
        body: Type.Object({
            passkeyId: PasskeyIdSchema,
            secondFactor: Type.Boolean({ description: 'true marks it as a second factor, false unmarks it' }),
        }),
    })
    .use([Transactional()])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId, keyId } = getAuth(c);

        await assertStepUp({ userId: Number(userId), keyId });

        return await markPasskeySecondFactorService({ userId: Number(userId), ...body });
    });

/**
 * POST /_auth/mfa/recovery/regenerate - Issue ten fresh codes
 *
 * Raises the generation, so every code from before this call stops verifying.
 * The new ten are in the response body once.
 */
export const mfaRegenerateRecoveryCodes = route.post('/_auth/mfa/recovery/regenerate')
    .input({
        body: Type.Object({}),
    })
    .use([Transactional()])
    .handler(async (c) =>
    {
        const { userId, keyId } = getAuth(c);

        await assertStepUp({ userId: Number(userId), keyId });

        return await regenerateRecoveryCodesService(Number(userId));
    });

/**
 * GET /_auth/mfa/status - What the account has enrolled
 *
 * No gate beyond authentication, and nothing secret in the answer: an account
 * screen has to be able to render without asking anybody for a code.
 */
export const mfaStatus = route.get('/_auth/mfa/status')
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);

        return await mfaStatusService(Number(userId));
    });

/**
 * The limit the two unauthenticated challenge routes share.
 *
 * Per client address, and nothing else: there is no session on either of them —
 * that is the point of the flow — so `byIpAndCaller` would degrade to this
 * anyway, with a second dimension that never fires. The number is `auth-login`'s,
 * because the exposure is the same six-digit value, and the challenge's own
 * five-attempt counter is the tighter bound on guessing one particular
 * registration.
 */
const CHALLENGE_LIMIT = { limit: 10, windowMs: 60_000 };

const ChallengeSchema = Type.String({
    minLength: 16,
    maxLength: 256,
    description: 'The challenge secret from the 202 sign-in answer or the OAuth callback query',
});

/**
 * POST /_auth/mfa/verify - Finish a sign-in that answered mfaRequired
 *
 * Unauthenticated, and it has to be: the key this activates is the only one the
 * caller has and it is inactive until this succeeds. The challenge secret is the
 * whole credential, it names one registration, and it is spent once.
 *
 * Answers the `LoginResult` the sign-in would have answered, plus `keyId` and
 * `challengeHash` for the Next.js interceptor to match against the pending
 * cookie it baked at the 202. Every refusal is one 401 with one body.
 *
 * No `Transactional()`, for the reason `totp/confirm` has none: the challenge's
 * attempt counter has to survive the refusal that raised it, and a route-wide
 * transaction would roll it back with the error — five wrong codes would never
 * reach five. The service opens its own for the success path.
 */
export const mfaVerify = route.post('/_auth/mfa/verify')
    .input({
        body: Type.Object({
            challenge: ChallengeSchema,
            code: Type.Optional(TotpCodeSchema),
            recoveryCode: Type.Optional(RecoveryCodeSchema),
            response: Type.Optional(AssertionSchema),
        }),
    })
    .use([rateLimitPolicy('auth-mfa-verify', CHALLENGE_LIMIT)])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await verifyMfaChallengeService({
            challenge: body.challenge,
            code: body.code,
            recoveryCode: body.recoveryCode,
            response: body.response as Parameters<typeof verifyMfaChallengeService>[0]['response'],
        });
    });

/**
 * POST /_auth/mfa/verify/options - Begin finishing a step-up with a passkey
 *
 * The challenge secret stands in for the session the caller does not have: it is
 * what names the account, so the WebAuthn challenge is minted for the right
 * owner without the request having to say who that is.
 */
export const mfaVerifyOptions = route.post('/_auth/mfa/verify/options')
    .input({
        body: Type.Object({
            challenge: ChallengeSchema,
        }),
    })
    .use([rateLimitPolicy('auth-mfa-verify', CHALLENGE_LIMIT)])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await startMfaChallengeAssertionService(body.challenge);
    });

/**
 * POST /_auth/mfa/step-up - Re-prove the second factor on this device
 *
 * The way back for a session that has none: a device-code approval and a passkey
 * sign-in both register a key with no verification against it, on purpose, so
 * the session they create would otherwise fail every sensitive change with
 * nowhere to go. Exactly one of the three inputs; two or none is a 400.
 */
export const mfaStepUp = route.post('/_auth/mfa/step-up')
    .input({
        body: Type.Object({
            code: Type.Optional(TotpCodeSchema),
            recoveryCode: Type.Optional(RecoveryCodeSchema),
            response: Type.Optional(AssertionSchema),
        }),
    })
    .use([rateLimitPolicy('auth-mfa-verify', VERIFY_LIMIT), Transactional()])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId, keyId } = getAuth(c);

        await stepUpService({
            userId: Number(userId),
            keyId,
            code: body.code,
            recoveryCode: body.recoveryCode,
            response: body.response as Parameters<typeof stepUpService>[0]['response'],
        });

        return c.noContent();
    });

/**
 * POST /_auth/mfa/step-up/options - Begin a step-up by passkey
 *
 * `allowCredentials` is empty, as it is for a sign-in: the credential on the
 * device names itself, and the owner and the second-factor mark are checked
 * when the assertion comes back. The challenge is bound to this account and to
 * the `mfa` ceremony, so it cannot be spent as a sign-in.
 */
export const mfaStepUpOptions = route.post('/_auth/mfa/step-up/options')
    .input({
        body: Type.Object({}),
    })
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);

        return await startStepUpService(Number(userId));
    });
