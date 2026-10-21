/**
 * @spfn/auth - Android Digital Asset Links
 *
 * Beside `/.well-known/oauth-authorization-server`: a document an origin serves
 * at its root. The API owns the `SPFN_AUTH_*` values it is built from, and the
 * web app forwards this one path to the API (`spfn init` writes the rewrite).
 */

import { route } from '@spfn/core/route';

import { androidAssetLinkStatements } from '../../lib/oauth/android-asset-links';

/**
 * GET /.well-known/assetlinks.json
 *
 * What Android fetches to verify the App Link Sign in with Apple on Android
 * relays to. A `200` with no redirect is the only answer the verifier accepts,
 * so a middleware that redirects `/.well-known/*` breaks verification. With
 * `SPFN_AUTH_ANDROID_PACKAGE_NAME` and `SPFN_AUTH_ANDROID_CERT_SHA256` unset the
 * application serves no such file: a body-less `404`.
 */
export const androidAssetLinks = route.get('/.well-known/assetlinks.json')
    .skip(['auth'])
    .handler(async (c) =>
    {
        const statements = androidAssetLinkStatements();

        if (!statements)
        {
            return c.raw.body(null, 404);
        }

        return c.json(statements);
    });
