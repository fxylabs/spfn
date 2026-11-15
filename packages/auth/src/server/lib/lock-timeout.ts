/**
 * Lock timeouts (SQLSTATE 55P03, `lock_not_available`), read from the driver's
 * error wherever it sits in the cause chain — as `unique-violation.ts` reads
 * its code, and for its reason.
 *
 * @module lib/lock-timeout
 */

const LOCK_NOT_AVAILABLE = '55P03';

/** Whether the error, or one it was caused by, is a lock wait that ran out. */
export function isLockTimeout(error: unknown): boolean
{
    for (let current = error; current instanceof Error; current = current.cause)
    {
        if ((current as { code?: unknown }).code === LOCK_NOT_AVAILABLE)
        {
            return true;
        }
    }

    return false;
}
