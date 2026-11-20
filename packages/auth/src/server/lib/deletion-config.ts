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

    /**
     * Synchronous hook invoked immediately before a user is purged. Throw to skip
     * that user for this sweep (they stay `pending`, retried on the next tick).
     */
    onBeforePurge?: (user: AccountDeletionPurgeUser) => Promise<void>;

    /**
     * Called inside the purge transaction, after the purge's own writes and
     * before its commit, with the contact read under the account lock. Never
     * published or queued. Database work only — it runs under the account lock:
     * write an outbox row through the app's own repository (it joins this
     * transaction) and send from a job after the commit. A throw rolls the purge
     * back; the request stays `pending` and the next sweep retries it.
     */
    onPurge?: (account: PurgedAccount) => Promise<void>;
}

/** The account a purge destroys, as read under its lock before the destructive step. */
export interface PurgedAccount
{
    publicId: string;
    email: string | null;
    phone: string | null;
    purgeStrategy: PurgeStrategy;
}

export const DEFAULT_DELETION_GRACE_PERIOD_DAYS = 30;
export const DEFAULT_DELETION_PURGE_STRATEGY: PurgeStrategy = 'anonymize';
export const DEFAULT_DELETION_ALLOW_SELF_IMMEDIATE = false;
export const DEFAULT_DELETION_PURGE_CRON = '0 4 * * *';

const DELETION_OPTIONS: ReadonlyArray<keyof AuthDeletionConfig> = [
    'gracePeriodDays',
    'purgeStrategy',
    'allowSelfImmediate',
    'purgeCron',
    'onBeforePurge',
    'onPurge',
];

const SEND_NOTIFICATIONS_REMOVED = 'deletion.sendNotifications was removed: @spfn/auth sends no account-deletion notice. '
    + 'Send your own from the auth.deletion.requested / auth.deletion.cancelled events and the deletion.onPurge hook — '
    + 'see the @spfn/auth README, "Account Deletion & Recovery", recipe "Telling the person".';

let config: AuthDeletionConfig = {
    gracePeriodDays: DEFAULT_DELETION_GRACE_PERIOD_DAYS,
    purgeStrategy: DEFAULT_DELETION_PURGE_STRATEGY,
    allowSelfImmediate: DEFAULT_DELETION_ALLOW_SELF_IMMEDIATE,
    purgeCron: DEFAULT_DELETION_PURGE_CRON,
};

/**
 * Set the resolved deletion config. Called synchronously from `createAuthLifecycle()`
 * (not from `afterInfrastructure`) so it takes effect before any route/job handler
 * that reads `getDeletionConfig()` can run.
 *
 * @throws Error for an option it does not know — `sendNotifications`, removed,
 *   named as such, so an app that relied on it learns at boot that nothing is
 *   mailed any more — a `purgeStrategy` outside `PURGE_STRATEGIES`, or an
 *   `allowSelfImmediate` that is not a boolean (the string `'false'` would
 *   otherwise read as true)
 */
export function configureDeletion(options?: Partial<AuthDeletionConfig>): void
{
    assertKnownDeletionOptions(options ?? {});
    assertDeletionOption('purgeStrategy', options?.purgeStrategy, PURGE_STRATEGIES);
    assertDeletionOption('allowSelfImmediate', options?.allowSelfImmediate, [true, false]);

    config = {
        gracePeriodDays: options?.gracePeriodDays ?? DEFAULT_DELETION_GRACE_PERIOD_DAYS,
        purgeStrategy: options?.purgeStrategy ?? DEFAULT_DELETION_PURGE_STRATEGY,
        allowSelfImmediate: options?.allowSelfImmediate ?? DEFAULT_DELETION_ALLOW_SELF_IMMEDIATE,
        purgeCron: options?.purgeCron ?? DEFAULT_DELETION_PURGE_CRON,
        onBeforePurge: options?.onBeforePurge,
        onPurge: options?.onPurge,
    };
}

function assertKnownDeletionOptions(options: object): void
{
    if ('sendNotifications' in options)
    {
        throw new Error(SEND_NOTIFICATIONS_REMOVED);
    }

    const unknown = Object.keys(options).find((key) => !(DELETION_OPTIONS as readonly string[]).includes(key));
    if (unknown !== undefined)
    {
        throw new Error(`deletion has no option '${unknown}'. Allowed: ${DELETION_OPTIONS.join(', ')}.`);
    }
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
