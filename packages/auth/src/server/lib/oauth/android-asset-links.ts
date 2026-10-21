/**
 * @spfn/auth - The Digital Asset Links statement of the Android app
 *
 * Android verifies an App Link by fetching `https://<host>/.well-known/assetlinks.json`
 * and finding a `delegate_permission/common.handle_all_urls` statement for the
 * app's package name and signing certificate. Sign in with Apple on Android
 * relays the id_token to such a link, so the link has to verify — and an app
 * that fails verification would let the link open in the browser instead.
 *
 * Built from `SPFN_AUTH_ANDROID_PACKAGE_NAME` and `SPFN_AUTH_ANDROID_CERT_SHA256`,
 * which the boot check (`assertAndroidAssetLinks`) holds to the right shape.
 */

import { env } from '@spfn/auth/config';

import { listEntries } from './android-config-check';

export interface AndroidAssetLinkStatement
{
    relation: ['delegate_permission/common.handle_all_urls'];
    target: {
        namespace: 'android_app';
        package_name: string;
        sha256_cert_fingerprints: string[];
    };
}

/**
 * The statements `GET /.well-known/assetlinks.json` serves, or null when the
 * two variables are not both set — the file is then not served at all.
 *
 * Fingerprints keep their configured order and are emitted uppercase, the form
 * Play Console prints and Android compares.
 */
export function androidAssetLinkStatements(): AndroidAssetLinkStatement[] | null
{
    const packageName = (env.SPFN_AUTH_ANDROID_PACKAGE_NAME || '').trim();
    const fingerprints = listEntries(env.SPFN_AUTH_ANDROID_CERT_SHA256);

    if (!packageName || fingerprints.length === 0)
    {
        return null;
    }

    return [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
            namespace: 'android_app',
            package_name: packageName,
            sha256_cert_fingerprints: fingerprints.map(fingerprint => fingerprint.toUpperCase()),
        },
    }];
}
