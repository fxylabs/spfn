/**
 * Unique violations (SQLSTATE 23505), read from the driver's error wherever it
 * sits in the cause chain — drizzle hands the driver's error on as the `cause`
 * of its own query error, so the top-level error never carries the code.
 *
 * @module lib/unique-violation
 */

const UNIQUE_VIOLATION = '23505';

interface DriverViolation
{
    code?: unknown;
    /** `postgres` (postgres.js) names the constraint here. */
    constraint_name?: unknown;
    /** `pg` (node-postgres) names it here. */
    constraint?: unknown;
}

/** Whether the error, or one it was caused by, is a unique violation. */
export function isUniqueViolation(error: unknown): boolean
{
    return findUniqueViolation(error) !== undefined;
}

/** The constraint a unique violation names, under either driver's field. */
export function uniqueViolationConstraint(error: unknown): string | undefined
{
    const violation = findUniqueViolation(error);
    const constraint = violation?.constraint_name ?? violation?.constraint;

    return typeof constraint === 'string' ? constraint : undefined;
}

function findUniqueViolation(error: unknown): DriverViolation | undefined
{
    for (let current = error; current instanceof Error; current = current.cause)
    {
        if ((current as DriverViolation).code === UNIQUE_VIOLATION)
        {
            return current as DriverViolation;
        }
    }

    return undefined;
}
