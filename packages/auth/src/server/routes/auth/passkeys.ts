/**
 * @spfn/auth - Passkey Routes
 *
 * Thin route handlers that delegate to the passkey service.
 *
 * Two of the seven are public, and they are the ones that could leak account
 * existence if they were shaped differently. `login/options` takes an empty body
 * — no identifier is accepted, so there is no input to vary the answer by — and
 * `login/verify` answers a revoked credential exactly as it answers one that was
 * never here. See the case table in the README.
 */

import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { route } from '@spfn/core/route';

import { getAuth } from '../../helpers';
import { KEY_ALGORITHM } from '../../types';
import { byIpAndCaller } from '../../lib/rate-limit-keys';
import { PASSKEY_LABEL_MAX_LENGTH } from '../../entities/passkeys';
import { DeviceNameSchema, PlatformSchema } from '../schema';
import {
    finishPasskeyEnrollmentService,
    finishPasskeyLoginService,
    listPasskeysService,
    renamePasskeyService,
    revokePasskeyService,
    startPasskeyEnrollmentService,
    startPasskeyLoginService,
} from '../../services';

/**
 * Why the authenticated routes key their limit on the caller, not on
 * `byIpAndAccount`.
 *
 * The design table says "10/min by account", and `byIpAndAccount` reads
 * `body.email` / `body.phone` to find one. None of these bodies carries either —
 * the account is the session — so that helper would find nothing and silently
 * degrade to an IP-only limit, which is the trap its own documentation warns
 * about. `byIpAndCaller` reads the principal, which is the account here.
 */

/**
 * The credential the browser hands back, passed through to the WebAuthn adapter
 * as it arrived.
 *
 * `Type.Unknown()` rather than a hand-written mirror of SimpleWebAuthn's
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON`: the library is the
 * thing that decides what a valid response is, and a second copy of that shape
 * here would be a second opinion — one that starts refusing responses the moment
 * the spec grows a field. Anything malformed comes back as the ordinary
 * verification refusal.
 */
const CredentialResponseSchema = Type.Unknown({
    description: 'The credential from @simplewebauthn/browser, passed through unchanged',
});

const PasskeyIdSchema = Type.String({
    pattern: '^[0-9]{1,19}$',
    description: 'Passkey identifier, as returned by list',
});

const PasskeyLabelSchema = Type.String({
    minLength: 1,
    maxLength: PASSKEY_LABEL_MAX_LENGTH,
    description: `Owner-facing name in the passkey list (1-${PASSKEY_LABEL_MAX_LENGTH} chars)`,
});

const CurrentPasswordSchema = Type.String({
    minLength: 1,
    description: 'Account password, needed when the session proved itself longer ago than the recent-authentication window',
});

/**
 * POST /_auth/passkeys/register/options - Begin enrolling a passkey
 *
 * Gated on recent authentication: adding a credential is adding a way in, and
 * someone who found an unlocked laptop must not be able to do it silently.
 */
export const passkeyRegisterOptions = route.post('/_auth/passkeys/register/options')
    .input({
        body: Type.Object({
            currentPassword: Type.Optional(CurrentPasswordSchema),
        }),
    })
    .use([rateLimitPolicy('auth-passkey-register-options', {
        limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }),
    })])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId, keyId } = getAuth(c);

        return await startPasskeyEnrollmentService({
            userId: Number(userId),
            keyId,
            currentPassword: body.currentPassword,
        });
    });

/**
 * POST /_auth/passkeys/register/verify - Finish enrolling a passkey
 *
 * `Transactional()`: spending the challenge and writing the row commit together,
 * so a refusal after the spend leaves the ceremony retryable and a success can
 * never be replayed.
 */
export const passkeyRegisterVerify = route.post('/_auth/passkeys/register/verify')
    .input({
        body: Type.Object({
            response: CredentialResponseSchema,
            label: Type.Optional(PasskeyLabelSchema),
        }),
    })
    .use([
        rateLimitPolicy('auth-passkey-register-verify', {
            limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }),
        }),
        Transactional(),
    ])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId } = getAuth(c);

        return await finishPasskeyEnrollmentService({
            userId: Number(userId),
            response: body.response as Parameters<typeof finishPasskeyEnrollmentService>[0]['response'],
            label: body.label,
        });
    });

/**
 * POST /_auth/passkeys/login/options - Begin a passkey sign-in
 *
 * The body is empty and `additionalProperties: false`, so an `email` field is a
 * 400 rather than something quietly ignored. That is the contract: this route
 * accepts no identifier, which is what makes it impossible for its answer to
 * differ by whether an account exists.
 */
export const passkeyLoginOptions = route.post('/_auth/passkeys/login/options')
    .input({
        body: Type.Object({}, {
            additionalProperties: false,
            description: 'No identifier is accepted — sign-in is discoverable',
        }),
    })
    .use([rateLimitPolicy('auth-passkey-login-options', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async () =>
    {
        return await startPasskeyLoginService();
    });

/**
 * POST /_auth/passkeys/login/verify - Finish a passkey sign-in
 *
 * The device-key fields are injected by the Next.js proxy interceptor, exactly
 * as they are for `login` — a passkey proves who is asking, and the ordinary
 * device key is still what later requests are signed with.
 */
export const passkeyLoginVerify = route.post('/_auth/passkeys/login/verify')
    .input({
        body: Type.Object({
            response: CredentialResponseSchema,
        }),
    })
    .interceptor({
        body: Type.Object({
            publicKey: Type.String({ description: 'Client public key' }),
            keyId: Type.String({ description: 'Key identifier' }),
            fingerprint: Type.String({ description: 'Key fingerprint' }),
            algorithm: Type.Union(KEY_ALGORITHM.map(algo => Type.Literal(algo)), { description: 'Signature algorithm' }),
            oldKeyId: Type.Optional(Type.String({ description: 'Previous key ID for rotation' })),
            deviceName: Type.Optional(DeviceNameSchema),
            platform: Type.Optional(PlatformSchema),
        }),
    })
    .use([rateLimitPolicy('auth-passkey-login-verify', { limit: 10, windowMs: 60_000 }), Transactional()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await finishPasskeyLoginService({
            ...body,
            response: body.response as Parameters<typeof finishPasskeyLoginService>[0]['response'],
        });
    });

/**
 * POST /_auth/passkeys/list - The caller's enrolled passkeys
 *
 * POST with the arguments in the body, like the key-management routes and for
 * the same reason: the mobile auth profile signs the request body, and a GET has
 * no body to sign.
 */
export const listPasskeys = route.post('/_auth/passkeys/list')
    .input({
        body: Type.Object({}),
    })
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);

        return { passkeys: await listPasskeysService(Number(userId)) };
    });

/**
 * POST /_auth/passkeys/rename - Rename one passkey
 *
 * No recent-authentication gate: a label is display only, and nothing is
 * authorized by it.
 */
export const renamePasskey = route.post('/_auth/passkeys/rename')
    .input({
        body: Type.Object({
            passkeyId: PasskeyIdSchema,
            label: PasskeyLabelSchema,
        }),
    })
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId } = getAuth(c);

        return await renamePasskeyService({ userId: Number(userId), ...body });
    });

/**
 * POST /_auth/passkeys/revoke - Retire one passkey
 *
 * Refused when it is the only thing the account can sign in with: no password
 * reset exists here, so that state has no undo.
 */
export const revokePasskey = route.post('/_auth/passkeys/revoke')
    .input({
        body: Type.Object({
            passkeyId: PasskeyIdSchema,
            currentPassword: Type.Optional(CurrentPasswordSchema),
        }),
    })
    .use([
        rateLimitPolicy('auth-passkey-revoke', { limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }) }),
        Transactional(),
    ])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId, keyId } = getAuth(c);

        return await revokePasskeyService({ userId: Number(userId), keyId, ...body });
    });
