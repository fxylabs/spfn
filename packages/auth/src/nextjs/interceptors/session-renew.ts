/**
 * The two renewal paths, named once.
 *
 * There is no interceptor here any more, and the reason is the point of the
 * file. Renewal used to be told which key to renew by a body field the proxy
 * injected from the HttpOnly key-id cookie; now the backend reads it off the
 * `keyId` of the bearer JWT the request is signed with
 * (`authenticateForRenewal`), so there is nothing left to inject and nothing a
 * direct caller can name that they do not already hold the private key for.
 *
 * What the proxy still has to do for these two paths, `general-auth` does: they
 * are authenticated paths like any other, so the session cookie is unsealed, the
 * CSRF header checked, and a JWT signed with the private half of the expiring
 * key — `generateClientToken` signs with the key material in the cookie and never
 * consults the row's expiry, which is what makes an expired key still able to
 * speak for itself. The one thing that path must not do is clear the jar when
 * one of these answers 401, and the pattern below is how it knows.
 *
 * `renew/verify` is also on `loginRegisterInterceptor`'s path list, which is
 * where the *new* key pair is generated and the replacement session sealed.
 */

/** The two public renewal paths, as one pattern the proxy layers agree on. */
export const SESSION_RENEW_PATH_PATTERN = /^\/_auth\/session\/renew\/(options|verify)$/;
