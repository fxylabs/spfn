/**
 * Account Deletion Configuration
 *
 * Singleton config for the account deletion/recovery lifecycle, mirroring the
 * one-time-token manager pattern (`lib/one-time-token.ts`): a mutable module-level
 * value, set once during `createAuthLifecycle()` and read at request/handler time.
 *
 * `purgeCron` is the one field this module does NOT make effective on its own —
 * `job('auth.deletion.purge').cron(expression)` bakes the cron string in at
 * *module-import* time, which always runs before `createAuthLifecycle()` executes
 * (ESM evaluates imports before the importing module's own statements). So a
 * statically-exported job router can never see a `purgeCron` set here. Apps that
 * need a non-default cron must build the router themselves, after configuring
 * deletion, with `createAuthDeletionJobRouter({ purgeCron })` — see
 * `server/jobs/deletion-purge.ts` and the README.
 */

import { PURGE_STRATEGIES, type PurgeStrategy } from '../types';

export interface AccountDeletionPurgeUser
{
    id: number;
    publicId: string;
    email: string | null;
    phone: string | null;
}

export interface AuthDeletionConfig
{
    /** Days between a deletion request and the purge becoming eligible. 0 = immediate. */
    gracePeriodDays: number;

    /** How the purge job destroys the account once the grace period elapses. */
    purgeStrategy: PurgeStrategy;

    /** Whether a self-service caller may request `immediate: true` (skip the grace period). */
    allowSelfImmediate: boolean;

    /**
     * Cron schedule for the purge sweep. NOT read automatically by the static
     * `authJobRouter` export — see the module doc comment above.
     */
    purgeCron: string;

    /** Whether to email users (when they have one) at request/recovery/purge time. */
    sendNotifications: boolean;

    /**
     * Synchronous hook invoked immediately before a user is purged. Throw to skip
     * that user for this sweep (they stay `pending`, retried on the next tick).
     */
    onBeforePurge?: (user: AccountDeletionPurgeUser) => Promise<void>;
}

export const DEFAULT_DELETION_GRACE_PERIOD_DAYS = 30;
export const DEFAULT_DELETION_PURGE_STRATEGY: PurgeStrategy = 'anonymize';
export const DEFAULT_DELETION_ALLOW_SELF_IMMEDIATE = false;
export const DEFAULT_DELETION_PURGE_CRON = '0 4 * * *';
export const DEFAULT_DELETION_SEND_NOTIFICATIONS = true;

let config: AuthDeletionConfig = {
    gracePeriodDays: DEFAULT_DELETION_GRACE_PERIOD_DAYS,
    purgeStrategy: DEFAULT_DELETION_PURGE_STRATEGY,
    allowSelfImmediate: DEFAULT_DELETION_ALLOW_SELF_IMMEDIATE,
    purgeCron: DEFAULT_DELETION_PURGE_CRON,
    sendNotifications: DEFAULT_DELETION_SEND_NOTIFICATIONS,
};

/**
 * Set the resolved deletion config. Called synchronously from `createAuthLifecycle()`
 * (not from `afterInfrastructure`) so it takes effect before any route/job handler
 * that reads `getDeletionConfig()` can run.
 *
 * @throws Error for a `purgeStrategy` outside `PURGE_STRATEGIES`, or an
 *   `allowSelfImmediate` / `sendNotifications` that is not a boolean — the
 *   string `'false'` would otherwise read as true
 */
export function configureDeletion(options?: Partial<AuthDeletionConfig>): void
{
    assertDeletionOption('purgeStrategy', options?.purgeStrategy, PURGE_STRATEGIES);
    assertDeletionOption('allowSelfImmediate', options?.allowSelfImmediate, [true, false]);
    assertDeletionOption('sendNotifications', options?.sendNotifications, [true, false]);

    config = {
        gracePeriodDays: options?.gracePeriodDays ?? DEFAULT_DELETION_GRACE_PERIOD_DAYS,
        purgeStrategy: options?.purgeStrategy ?? DEFAULT_DELETION_PURGE_STRATEGY,
        allowSelfImmediate: options?.allowSelfImmediate ?? DEFAULT_DELETION_ALLOW_SELF_IMMEDIATE,
        purgeCron: options?.purgeCron ?? DEFAULT_DELETION_PURGE_CRON,
        sendNotifications: options?.sendNotifications ?? DEFAULT_DELETION_SEND_NOTIFICATIONS,
        onBeforePurge: options?.onBeforePurge,
    };
}

function assertDeletionOption(name: string, value: unknown, allowed: readonly unknown[]): void
{
    if (value !== undefined && !allowed.includes(value))
    {
        throw new Error(`deletion.${name} does not accept ${JSON.stringify(value)}. Allowed: ${allowed.join(', ')}.`);
    }
}

/**
 * Read the current deletion config. Safe to call any time — defaults apply even
 * if `createAuthLifecycle()` was never given a `deletion` block.
 */
export function getDeletionConfig(): AuthDeletionConfig
{
    return config;
}
