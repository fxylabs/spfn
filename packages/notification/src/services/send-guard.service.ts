/**
 * @spfn/notification - Send guards
 *
 * A scheduled send can name a guard: a function the app registers, called
 * when the job runs, that decides whether the send still makes sense
 * ("send the outage mail only if the outage is still on").
 */

import type { NotificationChannel } from '../channels/types';

export interface SendGuardContext
{
    notificationId: number;
    channel: NotificationChannel;
    referenceType?: string;
    referenceId?: string;
    data?: Record<string, unknown>;
}

/**
 * `true` sends, `false` skips (the row ends `skipped`). A throw fails the
 * attempt, and the job retries it.
 */
export type SendGuard = (context: SendGuardContext) => boolean | Promise<boolean>;

const guards = new Map<string, SendGuard>();

/**
 * Register a guard under a name that `scheduleEmail`/`scheduleSMS` can pass
 * as `guard`. Register it in every process that runs notification jobs.
 */
export function registerSendGuard(name: string, guard: SendGuard): void
{
    guards.set(name, guard);
}

export function hasSendGuard(name: string): boolean
{
    return guards.has(name);
}

export function getSendGuard(name: string): SendGuard | undefined
{
    return guards.get(name);
}
