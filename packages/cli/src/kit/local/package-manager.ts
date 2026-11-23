/**
 * The package manager, actually run.
 *
 * "Frozen" is the whole point of this port. A Kit release pins an exact graph
 * in a lockfile, and an install that quietly resolves something newer has
 * produced a project the release never described — so the frozen flag is
 * passed through to pnpm as `--frozen-lockfile`, and a lockfile that no longer
 * matches `package.json` fails the install rather than being rewritten.
 *
 * The registry session never becomes an argument and never becomes a file. It
 * reaches the child as package-manager configuration in that child's own
 * environment, addressed to the registry it is good for — so the token is in the process's
 * own memory and in no argument list, no `.npmrc` and no log. The committed
 * `.npmrc` only maps the release's scopes to the registry, which is public.
 *
 * Why a failure is classified at all: unit 06 lets exactly one failure be
 * retried with a fresh session, and only one. Everything else would fail
 * identically the second time, so telling "the registry refused us" apart from
 * "this graph cannot be resolved" is what keeps the retry meaningful instead of
 * doubling every genuine failure.
 */

import type { PackageInstallResult, PackageManagerPort } from '../ports.js';
import { runCommand, summarize, type CommandRunner, type RunResult } from './process.js';

/**
 * What pnpm says when it means each thing.
 *
 * Matched against the child's own output because pnpm's exit code is 1 for
 * every one of these. The order below is the order they are tested in, and it
 * matters: a 401 from a registry also mentions the network.
 */
const FAILURE_SIGNATURES: { failure: NonNullable<PackageInstallResult['failure']>; patterns: RegExp[] }[] = [
    {
        failure: 'unauthorized',
        patterns: [
            /ERR_PNPM_FETCH_40[13]/i,
            /\b40[13]\b[^\n]*\b(unauthorized|forbidden)\b/i,
            /\b(unauthorized|authentication failed|need auth|not authorized)\b/i,
        ],
    },
    {
        failure: 'resolution',
        patterns: [
            /ERR_PNPM_OUTDATED_LOCKFILE/i,
            /ERR_PNPM_FROZEN_LOCKFILE/i,
            /ERR_PNPM_NO_MATCHING_VERSION/i,
            /ERR_PNPM_NO_LOCKFILE/i,
            /ERR_PNPM_PEER_DEP_ISSUES/i,
            /cannot be resolved|no matching version/i,
        ],
    },
    {
        failure: 'network',
        patterns: [
            /ERR_PNPM_FETCH_5\d\d/i,
            /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_SOCKET_TIMEOUT)\b/i,
            /request to .* failed/i,
        ],
    },
];

export interface PnpmPackageManagerOptions
{
    /** Registry the install resolves against. Public URL, never a secret. */
    registryUrl?: string;
    /**
     * Secret-free variables the install needs, e.g. `npm_config_userconfig`
     * pointed at an empty file so a machine's own `~/.npmrc` cannot redirect a
     * scope somewhere the release never named. The operation's own environment
     * takes precedence over anything here.
     */
    extraEnv?: Record<string, string>;
    /** A store outside the user's own, for a run that must not touch it. */
    storeDir?: string;
    /** Refuse to run a dependency's install scripts. */
    ignoreScripts?: boolean;
    /** Treat the project as standalone, whatever it happens to sit inside. */
    ignoreWorkspace?: boolean;
    timeoutMs?: number;
    /** Injected so tests drive the classification without spawning pnpm. */
    run?: CommandRunner;
    /** The binary to run. `pnpm` unless a test or a project says otherwise. */
    binary?: string;
}

export class PnpmPackageManagerPort implements PackageManagerPort
{
    private readonly options: PnpmPackageManagerOptions;

    constructor(options: PnpmPackageManagerOptions = {})
    {
        this.options = options;
    }

    async install(request: { cwd: string; frozen: boolean; env: Record<string, string> }): Promise<PackageInstallResult>
    {
        const result = await (this.options.run ?? runCommand)({
            file: this.options.binary ?? 'pnpm',
            args: this.argumentsFor(request.frozen),
            cwd: request.cwd,
            // The environment the operation built wins: it holds the session,
            // and nothing configured here may replace it.
            extraEnv: { ...this.options.extraEnv, ...request.env },
            timeoutMs: this.options.timeoutMs,
        });

        if (result.exitCode === 0)
        {
            return { ok: true, exitCode: 0 };
        }

        return {
            ok: false,
            exitCode: result.exitCode,
            failure: result.missing ? 'other' : classify(result),
        };
    }

    /**
     * The arguments, with the registry among them and the session not.
     *
     * A registry URL is a public locator, so it is safe on a command line; the
     * bearer that opens it is not, and travels in the environment instead.
     */
    private argumentsFor(frozen: boolean): string[]
    {
        const args = ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile'];

        if (this.options.registryUrl !== undefined)
        {
            args.push('--registry', this.options.registryUrl);
        }
        if (this.options.storeDir !== undefined)
        {
            args.push('--store-dir', this.options.storeDir);
        }
        if (this.options.ignoreScripts === true)
        {
            args.push('--ignore-scripts');
        }
        if (this.options.ignoreWorkspace === true)
        {
            args.push('--ignore-workspace');
        }

        return args;
    }
}

/** Which of the four failures a pnpm run was. */
export function classify(result: RunResult): NonNullable<PackageInstallResult['failure']>
{
    const text = summarizeForClassification(result);

    for (const signature of FAILURE_SIGNATURES)
    {
        if (signature.patterns.some(pattern => pattern.test(text)))
        {
            return signature.failure;
        }
    }

    return 'other';
}

/**
 * The whole output, for matching only.
 *
 * `summarize` is what may be *reported*; classification reads everything,
 * because the line that names the failure is often not among the last five.
 */
function summarizeForClassification(result: RunResult): string
{
    return `${result.stderr}\n${result.stdout}`;
}

/** The safe one-line reason a failed install may be reported with. */
export function installFailureSummary(result: RunResult): string
{
    return summarize(result);
}
