/**
 * What `spfn db push` does not compare (#442)
 *
 * drizzle-kit 1.0.0-rc.4's push drops these differences from its diff (each a
 * `mode === "push"` branch of `ddlDiff`, api-postgres.mjs), as PostgreSQL
 * stores each one normalised and the declared text cannot be compared with
 * it. A change to one of them in the schema plans nothing. Checks were the
 * same, and push now compares them itself (changed-checks.ts).
 */

import type { DeclaredEntity } from './changed-checks.js';

/** Each kind push does not compare, and whether a declared object has it */
const UNCOMPARED_KINDS: Array<{ label: string; declares: (entity: DeclaredEntity) => boolean }> =
    [
        // An index's columns or expressions when their number is the same, and its WHERE when both sides have one
        { label: 'index columns and WHERE', declares: entity => entity.entityType === 'indexes' },
        { label: 'view definitions', declares: entity => entity.entityType === 'views' && Boolean(entity.definition) },
        { label: 'policy USING and WITH CHECK', declares: entity => entity.entityType === 'policies' && Boolean(entity.using || entity.withCheck) },
        { label: 'generated column expressions', declares: entity => entity.entityType === 'columns' && Boolean(entity.generated) },
    ];

/** The kinds push does not compare that the schema declares objects of, each with how many */
export function uncomparedKinds(entities: DeclaredEntity[]): string[]
{
    return UNCOMPARED_KINDS.flatMap(({ label, declares }) =>
    {
        const count = entities.filter(declares).length;

        return count > 0 ? [`${label} (${count})`] : [];
    });
}
