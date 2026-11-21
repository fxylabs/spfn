/**
 * Probes on the built entries, run by scripts/check-bundle-identity.mjs at the repository root
 * after the build.
 *
 * Identity: a refusal `authApi` restores is an instance of the class an app imports from
 * `@spfn/auth/errors`. Not a vitest row — vitest resolves `@spfn/auth` to source and
 * `@spfn/auth/errors` to dist, so it would compare the wrong things.
 *
 * Private imports (`scripts/lib/private-imports.mjs` at the repository root): `nextjs/client`
 * is a build of its own that reaches the main build only through `#nextjs/client-shared`, and
 * every `#…` import in `dist` resolves to a file exporting what it imports, and in declarations
 * to a declaration file.
 */

import { fileURLToPath } from 'node:url';

import { checkPrivateImports } from '../../../scripts/lib/private-imports.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

async function checkErrorIdentity()
{
    // `authApi` takes `fetch` when the module is evaluated, so the stand-in goes first.
    globalThis.fetch = async () => Response.json(
        { __type: 'RecentAuthenticationRequiredError', message: 'bundle identity probe' },
        { status: 403 },
    );
    process.env.SPFN_APP_URL ??= 'http://bundle-identity-probe.invalid';
    // Outside Next.js the client warns that it has no inbound request; expected here.
    process.env.SPFN_LOG_LEVEL ??= 'error';

    const { authApi } = await import('@spfn/auth');
    const { RecentAuthenticationRequiredError } = await import('@spfn/auth/errors');

    const thrown = await authApi.getAuthSession.call({}).then(() => null, error => error);

    if (!(thrown instanceof RecentAuthenticationRequiredError))
    {
        console.error('Identity probe failed:\n  - authApi restores RecentAuthenticationRequiredError as a class '
            + `other than the one @spfn/auth/errors exports (got ${thrown?.constructor?.name ?? thrown})`);
        process.exit(1);
    }
    console.log('Identity probe passed: authApi refusals are the classes @spfn/auth/errors exports.');
}

// First: `authApi` must not have been loaded, by a private import's target, before the stand-in.
await checkErrorIdentity();
if (!await checkPrivateImports(DIST, specifier => import.meta.resolve(specifier)))
{
    process.exit(1);
}
