/**
 * How the local Kit ports run anything.
 *
 * Four of the ten ports a Kit operation drives are local process work —
 * installing, migrating, running the release's gates and Git — and all four
 * share one set of rules about the children they start:
 *
 *   - the environment is built, never inherited. A child that gets the
 *     parent's whole environment gets every secret in it, and a package
 *     manager has no business reading a database URL;
 *   - a secret reaches a child in that environment and nowhere else. Never an
 *     argument, because an argument is in the process table for every other
 *     local user to read;
 *   - a failed child is a return value, not an exception. Which exit codes
 *     mean what is the port's contract, and a caller that has to catch to read
 *     a documented failure ends up with two ways to say the same thing.
 *
 * Output is captured rather than streamed. A gate's stderr can contain a
 * connection string or a token printed by whatever it ran, so it is summarised
 * to its last few lines and never passed on whole.
 */

import { execa } from 'execa';
import { redactUrls } from '../../utils/redact-urls.js';
import { createChildEnv } from '../child-env.js';

/** How much of a failed child's output may travel into a report. */
export const MAX_SUMMARY_LINES = 5;
export const MAX_SUMMARY_CHARS = 400;

export interface RunRequest
{
    file: string;
    args: string[];
    cwd: string;
    /** Secret-free variables the child needs beyond the passthrough set. */
    extraEnv?: Record<string, string>;
    /** The one secret a child may receive, and only through its environment. */
    registryToken?: string;
    /** Parent variable names this child may also read. Never secrets. */
    passthrough?: readonly string[];
    timeoutMs?: number;
}

export interface RunResult
{
    exitCode: number;
    stdout: string;
    stderr: string;
    /** True when the binary was not there at all, rather than exiting badly. */
    missing: boolean;
}

export type CommandRunner = (request: RunRequest) => Promise<RunResult>;

/** Long enough for a cold `pnpm install`, short enough to fail a wedged one. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

export async function runCommand(request: RunRequest): Promise<RunResult>
{
    try
    {
        const result = await execa(request.file, request.args, {
            cwd: request.cwd,
            env: createChildEnv({
                registryToken: request.registryToken,
                extra: request.extraEnv,
                passthrough: request.passthrough,
            }),
            extendEnv: false,
            timeout: request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
            reject: false,
            all: false,
        });

        return {
            exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
            stdout: String(result.stdout ?? ''),
            stderr: String(result.stderr ?? ''),
            missing: false,
        };
    }
    catch (error)
    {
        // execa only throws here for a spawn failure — the binary is absent or
        // not executable. Everything else came back as a result above.
        return {
            exitCode: 127,
            stdout: '',
            stderr: messageOf(error),
            missing: isMissingBinary(error),
        };
    }
}

/**
 * The last few lines of what a failed child said, with nothing that looks like
 * a secret in them.
 *
 * The tail rather than the head: a build that fails prints its error last, and
 * the first lines are a banner.
 */
export function summarize(result: RunResult): string
{
    const lines = `${result.stderr}\n${result.stdout}`
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    const tail = lines.slice(-MAX_SUMMARY_LINES).join(' | ');

    return redactUrls(tail).slice(0, MAX_SUMMARY_CHARS);
}

function isMissingBinary(error: unknown): boolean
{
    const code = (error as { code?: string } | null)?.code;

    return code === 'ENOENT' || code === 'EACCES';
}

function messageOf(error: unknown): string
{
    return redactUrls(error instanceof Error ? error.message : String(error));
}
