/**
 * A TOTP row that asserts a code at the window's edge — a ±1 step accepted, a
 * ±2 step refused — must have the test and the server read the same step. The
 * server runs in-process, so one pinned `Date` serves both: a 30-second step
 * boundary can no longer pass between building the code and the request.
 */

import { vi } from 'vitest';

import { TOTP_STEP_SECONDS, totpStep } from '@/server/lib/totp';

/**
 * Freeze `Date` `secondsIntoStep` seconds into the current TOTP step, and keep
 * it there until `vi.useRealTimers()`. Only `Date` is faked, as the suite's
 * other pinned rows do: timers, the database driver and the request path run
 * as they always do.
 */
export function pinClockInsideTotpStep(secondsIntoStep = 10): void
{
    const stepStart = totpStep(Date.now()) * TOTP_STEP_SECONDS * 1000;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(stepStart + secondsIntoStep * 1000);
}
