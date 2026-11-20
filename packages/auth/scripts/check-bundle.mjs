/**
 * Identity probe on the built entries, run by scripts/check-bundle-identity.mjs at the
 * repository root after the build: a refusal `authApi` restores is an instance of the class
 * an app imports from `@spfn/auth/errors`. Not a vitest row — vitest resolves `@spfn/auth`
 * to source and `@spfn/auth/errors` to dist, so it would compare the wrong things.
 */

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
