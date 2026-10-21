/**
 * @spfn/auth - Sign in with Apple on Android: the native start and the callback relay
 *
 * Apple ships no Android SDK, so an Android app runs Apple's web flow in a
 * Custom Tab. That flow ends in browser cookies the app cannot read, and the web
 * start mints a key of its own. The Android start instead carries the app's
 * values: its request nonce (the SHA-256 hex of its key fingerprint), its
 * `state`, and one App Link from `SPFN_AUTH_APPLE_RELAY_URLS`. Apple's form_post
 * to the usual Return URL is answered with a `303` to that App Link carrying
 * `id_token`, `user`, `error` and the app's `state`, and the app posts the
 * id_token to `POST /_auth/oauth/apple/native` exactly as on iOS.
 *
 * A relay target is only ever a configured URL, matched exactly. The boot check
 * (`android-config-check.ts`) holds every configured value to https, because a
 * non-https target would let a malicious app on the victim's device receive the
 * token of a flow an attacker started. The relay sets no cookie, reads no
 * database and logs nothing it relays.
 */

import { env } from '@spfn/auth/config';
import { ValidationError } from '@spfn/core/errors';

import { listEntries } from './android-config-check';
import { getAppleRelayAuthUrl } from './apple-provider';
import { createAppleRelayState, verifyAppleRelayState, type AppleRelayState } from './state';

const RELAY_URLS_VAR = 'SPFN_AUTH_APPLE_RELAY_URLS';

/** Apple's id_token is a JWT of about a kilobyte; anything past this is not Apple's. */
const MAX_RELAY_ID_TOKEN_BYTES = 4096;

/** Apple's `user` JSON carries a name and an email (decision 01m5d1wadb). */
const MAX_RELAY_USER_BYTES = 2048;

/** What the Android module accepts as an error code; anything else is relayed as `failed`. */
const RELAY_ERROR_PATTERN = /^[a-z_]{1,64}$/;

/** The parts of Apple's form_post the relay reads. */
export interface AppleRelayForm
{
    state?: unknown;
    id_token?: unknown;
    user?: unknown;
    error?: unknown;
}

/** The configured relay targets, in configured order. */
export function configuredAppleRelayUrls(): string[]
{
    return listEntries(env.SPFN_AUTH_APPLE_RELAY_URLS);
}

/**
 * Refuse a relay URL that is not configured. Exact string comparison, no
 * normalisation — an OAuth `redirect_uri` is matched the same way, and
 * normalisation is where open redirects come from.
 */
function requireConfiguredRelayUrl(relayUrl: string): void
{
    const configured = configuredAppleRelayUrls();

    if (configured.length === 0)
    {
        throw new ValidationError({
            message: `Sign in with Apple on Android is not configured. Set ${RELAY_URLS_VAR} to the https App Link the callback relays to.`,
        });
    }

    if (!configured.includes(relayUrl))
    {
        throw new ValidationError({ message: `relayUrl is not one of the URLs listed in ${RELAY_URLS_VAR}.` });
    }
}

/**
 * The Apple authorize URL for an Android sign-in.
 *
 * The app's state is sealed with the relay URL rather than sent to Apple as it
 * is: the callback must learn where to relay from something only this server
 * could have written.
 *
 * @throws ValidationError when the relay URL is not configured
 */
export async function startAppleRelay(params: AppleRelayState & { requestNonce: string }): Promise<string>
{
    requireConfiguredRelayUrl(params.relayUrl);

    const sealed = await createAppleRelayState({ appState: params.appState, relayUrl: params.relayUrl });

    return getAppleRelayAuthUrl(sealed, params.requestNonce);
}

/**
 * Where the POST callback relays an Android sign-in, or null when this callback
 * is not one — the caller then answers exactly as it does for the web flow.
 *
 * Null when the posted state does not decrypt with the relay key, and when the
 * relay URL it sealed is no longer configured: the configuration is checked
 * again here, not only at the start.
 */
export async function appleRelayLocation(form: AppleRelayForm): Promise<string | null>
{
    const verified = typeof form.state === 'string' ? await verifyAppleRelayState(form.state) : null;

    if (!verified || !configuredAppleRelayUrls().includes(verified.relay.relayUrl))
    {
        return null;
    }

    const query = verified.expired
        ? new URLSearchParams({ error: 'expired' })
        : relayedFields(form);
    query.set('state', verified.relay.appState);

    const location = new URL(verified.relay.relayUrl);
    location.search = query.toString();

    return location.toString();
}

/** `id_token`, `user` and `error` from Apple's form, each within its bound. */
function relayedFields(form: AppleRelayForm): URLSearchParams
{
    const query = new URLSearchParams();

    if (fitsWithin(form.id_token, MAX_RELAY_ID_TOKEN_BYTES))
    {
        query.set('id_token', form.id_token);
    }

    if (fitsWithin(form.user, MAX_RELAY_USER_BYTES))
    {
        query.set('user', form.user);
    }

    if (typeof form.error === 'string')
    {
        query.set('error', RELAY_ERROR_PATTERN.test(form.error) ? form.error : 'failed');
    }

    return query;
}

function fitsWithin(value: unknown, maxBytes: number): value is string
{
    return typeof value === 'string' && value !== '' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}
