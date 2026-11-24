/**
 * The release's gates, run where the release lives.
 *
 * A gate is the release's own claim that the project it just produced works:
 * it typechecks, its tests pass, it builds. So each one runs the project's own
 * script wherever the project has one, and falls back to the obvious command
 * only where there is an obvious one. A gate a project has no way to run is a
 * failure with a reason, not a silent pass — "we could not check" and "we
 * checked and it is fine" are different claims, and only one of them may let
 * an install commit.
 *
 * `db-status` is not a command at all. It is the database port's own answer,
 * asked again, because a gate that shelled out to a second implementation of
 * the same question could disagree with the migration step it follows.
 *
 * `health` never reaches here: it is a deployment gate, and the operation
 * filters it out before local gates run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unreadableStatusReason, type DatabasePort, type GatePort, type GateResult } from '../ports.js';
import type { KitGate } from '../manifest.js';
import { runCommand, summarize, type CommandRunner } from './process.js';
import { spfnCommand } from './database.js';
import { KIT_CONFIG_ENV } from '../child-env.js';

/** A gate should not hang a whole install; a slow build still finishes. */
export const DEFAULT_GATE_TIMEOUT_MS = 900_000;

/**
 * The environment of every gate the package manager runs.
 *
 * pnpm 11 and later install before `pnpm run` and `pnpm exec` when their own
 * up-to-date check says so, under the gate's configuration rather than the
 * install's — and from 12.9.0 a failed install there warns and runs the script
 * anyway. The graph a gate checks is the one the kit installed and read back,
 * so pnpm's own install is turned off. The variable, not `--config.`, so the
 * argv stays the script's; `pnpm_`, because pnpm 12 ignores `npm_config_` for
 * it. A pnpm that has no such setting ignores it.
 */
const PACKAGE_MANAGER_GATE_ENV: Readonly<Record<string, string>> = {
    pnpm_config_verify_deps_before_run: 'false',
};

interface GateCommand
{
    file: string;
    args: string[];
    env?: Readonly<Record<string, string>>;
    isSelf?: true;
}

/** The project script each gate prefers, and what to run when it has none. */
interface GatePlan
{
    /** `package.json` script names, in order of preference. */
    scripts: string[];
    /** Run when the project declares none of those scripts: package-manager arguments, or this CLI. */
    fallback?: { packageManagerArgs: string[] } | GateCommand;
}

const GATE_PLANS: Record<Exclude<KitGate, 'db-status' | 'health'>, GatePlan> = {
    'kit-check': { scripts: [], fallback: spfnFallback(['kit', 'check', '--json']) },
    typecheck: { scripts: ['type-check', 'typecheck'], fallback: { packageManagerArgs: ['exec', 'tsc', '--noEmit'] } },
    test: { scripts: ['test'] },
    build: { scripts: ['build'] },
};

export interface CommandGateOptions
{
    /** Answers the `db-status` gate. The same port the migration step used. */
    database: DatabasePort;
    packageManagerBinary?: string;
    timeoutMs?: number;
    run?: CommandRunner;
}

export class CommandGatePort implements GatePort
{
    private readonly options: CommandGateOptions;

    constructor(options: CommandGateOptions)
    {
        this.options = options;
    }

    async run(gate: KitGate, request: { cwd: string }): Promise<GateResult>
    {
        if (gate === 'db-status')
        {
            const status = await this.options.database.status({ cwd: request.cwd });

            if (!status.reachable)
            {
                return { ok: false, summary: `the migration status could not be read: ${unreadableStatusReason(status)}` };
            }

            return status.pending.length === 0
                ? { ok: true }
                : { ok: false, summary: `${status.pending.length} migration(s) still pending` };
        }
        if (gate === 'health')
        {
            // Reached only if an operation stops filtering it. Refusing is the
            // safe answer: this port cannot check a deployment.
            return { ok: false, summary: 'the health gate belongs to deployment, not to a local run' };
        }

        const command = this.commandFor(gate, request.cwd);

        if (command === null)
        {
            return { ok: false, summary: `this project declares no way to run the ${gate} gate` };
        }

        const result = await (this.options.run ?? runCommand)({
            file: command.file,
            args: command.args,
            cwd: request.cwd,
            /* Only for the gate that re-runs this CLI. A project script gets
               the package-manager environment, because a project script is not
               this CLI and has no business reading how it is configured. */
            passthrough: command.isSelf ? KIT_CONFIG_ENV : undefined,
            extraEnv: command.env,
            timeoutMs: this.options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
        });

        if (result.exitCode === 0)
        {
            return { ok: true };
        }

        return { ok: false, summary: result.missing ? `${command.file} is not installed` : summarize(result) };
    }

    private commandFor(
        gate: Exclude<KitGate, 'db-status' | 'health'>,
        cwd: string,
    ): GateCommand | null
    {
        const plan = GATE_PLANS[gate];
        const scripts = projectScripts(cwd);
        const named = plan.scripts.find(name => typeof scripts[name] === 'string');

        if (named !== undefined)
        {
            return this.packageManagerCommand(['run', named]);
        }
        if (plan.fallback !== undefined && 'packageManagerArgs' in plan.fallback)
        {
            return this.packageManagerCommand(plan.fallback.packageManagerArgs);
        }

        return plan.fallback ?? null;
    }

    /** The binary the install ran, so a gate and the install run the same package manager. */
    private packageManagerCommand(args: string[]): GateCommand
    {
        return { file: this.options.packageManagerBinary ?? 'pnpm', args, env: PACKAGE_MANAGER_GATE_ENV };
    }
}

/** The `scripts` block of a project's `package.json`, or nothing. */
export function projectScripts(cwd: string): Record<string, unknown>
{
    const file = join(cwd, 'package.json');

    if (!existsSync(file))
    {
        return {};
    }

    try
    {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> };

        return parsed.scripts ?? {};
    }
    catch
    {
        return {};
    }
}

function spfnFallback(args: string[]): GateCommand
{
    const command = spfnCommand();

    return { file: command.file, args: [...command.args, ...args], isSelf: true };
}
