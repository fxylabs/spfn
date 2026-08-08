/**
 * The `@spfn/auth/crypto` contract, as this CLI needs it
 *
 * SPFN authenticates a request with a JWT the client signs itself, and the two
 * functions below are the client's half of that. They live in `@spfn/auth`,
 * which the CLI does not depend on in any form: an app that does not use auth
 * still uses the rest of the CLI, so the package is resolved at run time from
 * whatever the app has installed, and the version it must be is enforced by the
 * message `loadAuthCrypto` raises rather than by a declared range.
 *
 * The contract is declared here rather than imported, for three reasons that
 * each rule out a dependency of their own:
 *
 * - A workspace dependency closes a cycle — `@spfn/auth` depends on this CLI
 *   for its own codegen — and turbo then refuses to run any task, so the repo
 *   cannot be built or tested at all.
 * - A `peerDependencies` entry, even an optional one, is auto-installed by
 *   pnpm and lands in the lockfile as a **registry** version of a workspace
 *   package. The publish workflows install with `--frozen-lockfile` from public
 *   npmjs, so the lockfile would demand a version that only reaches npmjs
 *   *through those same workflows* — a deadlock on every future `@spfn/auth`
 *   release, not a one-off.
 * - Importing the types would need the package present at compile time, which
 *   is the thing being avoided.
 *
 * So the import specifier is held in a variable, keeping the compiler from
 * resolving a package that is deliberately absent. The shape below is what is
 * promised in exchange; it must keep matching `@spfn/auth/crypto`, and the
 * integration tests in that package walk the real functions end to end.
 */

/** A client key pair. Both halves are base64-encoded DER. */
export interface ClientKeyPair
{
    privateKey: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm: string;
}

export interface AuthCrypto
{
    generateKeyPair(algorithm?: string): ClientKeyPair;
    generateClientToken(
        payload: Record<string, unknown>,
        privateKeyB64: string,
        algorithm: string,
        options?: { expiresIn?: string | number; issuer?: string },
    ): string;
}

/**
 * The release that added the `@spfn/auth/crypto` entry point. This is where the
 * requirement is stated and enforced — nothing declares it as a dependency
 * range — so it is also what the READMEs quote.
 */
const CRYPTO_ENTRY_SINCE = '0.3.0-beta.2';

const CRYPTO_ENTRY = '@spfn/auth/crypto';

/**
 * Load the signing functions from the app's own `@spfn/auth`.
 *
 * The failure is read rather than assumed, because three different things fail
 * here and each needs a different action: the package can be absent, it can be
 * installed but older than the release that exposes `crypto`, or it can throw
 * while loading. Calling all three "not installed" sends an operator to
 * install what they already have.
 */
export async function loadAuthCrypto(): Promise<AuthCrypto>
{
    try
    {
        return await import(CRYPTO_ENTRY) as AuthCrypto;
    }
    catch (err)
    {
        const code = (err as { code?: string }).code;

        if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
        {
            throw new Error(
                'This project does not have @spfn/auth installed, and ops tokens live in its schema — '
                + 'so this app has none to issue, list or revoke.\n'
                + '   An app that uses the ops surface installs @spfn/auth for opsTokenAuth; add it there.\n'
                + '   Invoking commands with a token you already hold (spfn ops list / call) does not need it.',
            );
        }

        if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
        {
            throw new Error(
                `This project's @spfn/auth is older than ${CRYPTO_ENTRY_SINCE}, the release that exposes `
                + '@spfn/auth/crypto — the request signing this command authenticates with.\n'
                + `   Update it: pnpm add @spfn/auth@'>=${CRYPTO_ENTRY_SINCE} <0.4.0'`,
            );
        }

        throw err;
    }
}
