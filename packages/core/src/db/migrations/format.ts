/**
 * One wording for pending migrations, shared by the server's boot gate and the
 * CLI's pre-flight check — an operator should read the same lines wherever the
 * refusal comes from.
 */

import type { MigrationTargetStatus } from './status';

export const RUN_MIGRATIONS_HINT = 'Run: pnpm spfn db migrate';

/**
 * Why the opt-out does not start a server whose project bookkeeping does not
 * match its migrations.
 */
export const MISMATCH_OVERRIDE_NOTE = 'SPFN_ALLOW_PENDING_MIGRATIONS (--allow-pending-migrations) does not apply: '
    + 'it starts a server whose migrations are still to be applied, and `spfn db migrate` refuses this database, '
    + 'so nothing applied later brings it up to date.';

/**
 * Plain (uncoloured) lines listing every target with pending migrations and the
 * name of each migration still waiting.
 */
export function formatPendingMigrations(targets: MigrationTargetStatus[]): string[]
{
    const lines: string[] = [];

    for (const target of targets)
    {
        lines.push(`${target.name}: ${target.pending} pending migration(s) (${target.applied}/${target.total} applied)`);

        for (const tag of target.pendingTags)
        {
            lines.push(`    - ${tag}`);
        }
    }

    return lines;
}

/**
 * The single-sentence reason a boot was refused.
 */
export function pendingMigrationsSummary(targets: MigrationTargetStatus[]): string
{
    const pending = targets.reduce((sum, target) => sum + target.pending, 0);
    const names = targets.map(target => target.name).join(', ');

    return `${pending} pending migration(s) in ${names}`;
}
