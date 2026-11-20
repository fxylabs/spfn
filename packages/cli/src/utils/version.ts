import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Injected at build time by tsup
declare const __CLI_VERSION__: string;
declare const __CLI_CORE_PEER_RANGE__: string;

interface CliManifest
{
    version: string;
    peerDependencies?: Record<string, string>;
}

let fromPackageJson: CliManifest | null = null;

/**
 * Get the CLI package version (injected at build time).
 *
 * The build-time constant is the normal answer. It is absent in exactly two
 * situations — running the sources directly, and importing this package as a
 * library rather than through its bundle — and in both the version is still a
 * fact, sitting in this package's own `package.json`. Reading it there is what
 * keeps a caller that only wanted a version from crashing on a missing define.
 */
export function getCliVersion(): string
{
    if (typeof __CLI_VERSION__ === 'string')
    {
        return __CLI_VERSION__;
    }

    return cliManifest().version;
}

/**
 * The `@spfn/core` range this CLI declares in its `peerDependencies`, which the
 * release raises: injected at build time beside the version, read from the
 * same `package.json` when the define is absent.
 */
export function getCorePeerRange(): string
{
    if (typeof __CLI_CORE_PEER_RANGE__ === 'string')
    {
        return __CLI_CORE_PEER_RANGE__;
    }

    return cliManifest().peerDependencies?.['@spfn/core'] ?? 'of an unknown range';
}

function cliManifest(): CliManifest
{
    return fromPackageJson ?? (fromPackageJson = readPackageManifest());
}

function readPackageManifest(): CliManifest
{
    let directory = dirname(fileURLToPath(import.meta.url));

    for (let depth = 0; depth < 8; depth += 1)
    {
        const candidate = join(directory, 'package.json');

        if (existsSync(candidate))
        {
            try
            {
                const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Partial<CliManifest> & { name?: string };

                if (parsed.name === 'spfn' && typeof parsed.version === 'string')
                {
                    return parsed as CliManifest;
                }
            }
            catch
            {
                // Unreadable: keep walking rather than claiming a version.
            }
        }

        const parent = dirname(directory);

        if (parent === directory)
        {
            break;
        }

        directory = parent;
    }

    return { version: '0.0.0' };
}

/**
 * Extract npm tag from version string
 *
 * Examples:
 * - "0.2.0-beta.5" -> "beta"
 * - "0.2.0-alpha.1" -> "alpha"
 * - "0.2.0" -> "latest"
 */
export function getTagFromVersion(version: string): string
{
    const match = version.match(/-([a-z]+)\./i);

    return match ? match[1] : 'latest';
}

/**
 * Get the npm tag for SPFN dependencies based on CLI version
 */
export function getSpfnTag(): string
{
    return getTagFromVersion(getCliVersion());
}
