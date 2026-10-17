/**
 * @spfn/auth - Boot-time check of the Sign in with Apple web configuration
 *
 * The Apple web flow needs five variables that only meet on the first token
 * request: three ids, and a private key given either inline or as a file. A
 * missing id or a key that does not import would otherwise boot clean, keep
 * `apple` out of the provider list without a word, or fail the first person
 * who signs in with a provider error nobody traces back to the env value.
 *
 * This runs once at boot and refuses instead, naming every missing or
 * conflicting variable so the operator fixes them all in one restart. A
 * deployment that sets none of the five (native-only, or no Apple at all) is
 * not examined. The key's text never reaches the refusal or a log.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { importAppleSigningKey, type AppleKeySource } from './apple-client-secret';

type EnvSource = Record<string, string | undefined>;

const ID_VARS = ['SPFN_AUTH_APPLE_SERVICES_ID', 'SPFN_AUTH_APPLE_TEAM_ID', 'SPFN_AUTH_APPLE_KEY_ID'] as const;
const KEY_VAR = 'SPFN_AUTH_APPLE_PRIVATE_KEY';
const KEY_FILE_VAR = 'SPFN_AUTH_APPLE_PRIVATE_KEY_FILE';

/** The key source the variables name, or the refusal that stops it being read. */
type KeySourceResult = { source: AppleKeySource } | { refusal: string };

/**
 * The PEM the key variables name, read the way the provider reads it.
 */
function resolveKeySource(env: EnvSource): KeySourceResult
{
    const pem = env[KEY_VAR];
    const path = env[KEY_FILE_VAR];

    if (pem && path)
    {
        return { refusal: `Set exactly one of ${KEY_VAR} and ${KEY_FILE_VAR}, not both.` };
    }

    if (pem)
    {
        return { source: { variable: KEY_VAR, pem } };
    }

    if (!path)
    {
        return { refusal: `One of ${KEY_VAR} or ${KEY_FILE_VAR} must be set.` };
    }

    if (!isAbsolute(path))
    {
        return { refusal: `${KEY_FILE_VAR} must be an absolute path.` };
    }

    const content = readKeyFile(path);

    return content === null
        ? { refusal: `${KEY_FILE_VAR} names a file that cannot be read.` }
        : { source: { variable: KEY_FILE_VAR, pem: content } };
}

function readKeyFile(path: string): string | null
{
    try
    {
        return readFileSync(path, 'utf8');
    }
    catch
    {
        return null;
    }
}

/** The refusal for a key that does not import as ES256, or null when it does. */
async function keyImportRefusal(source: AppleKeySource): Promise<string | null>
{
    return await importAppleSigningKey(source)
        .then(() => null)
        .catch((err: Error) => `${err.message}.`);
}

/**
 * Refuse boot when the Apple web configuration is partial, ambiguous, or its key unusable.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws When any of the five variables is set and the set does not work. One error names every problem.
 */
export async function assertAppleWebConfig(env: EnvSource = process.env): Promise<void>
{
    if (![...ID_VARS, KEY_VAR, KEY_FILE_VAR].some(variable => env[variable]))
    {
        return;
    }

    const refusals: string[] = ID_VARS
        .filter(variable => !env[variable])
        .map(variable => `${variable} is not set.`);

    const key = resolveKeySource(env);
    const keyRefusal = 'refusal' in key ? key.refusal : await keyImportRefusal(key.source);

    if (keyRefusal)
    {
        refusals.push(keyRefusal);
    }

    if (refusals.length > 0)
    {
        throw new Error(
            'Sign in with Apple (web) is partially configured: set the three ids and exactly one key '
            + `variable, or none of the five.\n${refusals.join('\n')}`,
        );
    }
}
