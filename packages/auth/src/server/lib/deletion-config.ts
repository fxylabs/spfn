/**
 * Account Deletion Configuration
 *
 * Singleton config for the account deletion/recovery lifecycle, mirroring the
 * one-time-token manager pattern (`lib/one-time-token.ts`): a mutable module-level
 * value, set by `createAuthLifecycle()` and read at request/handler time. Several
 * lifecycles combine as their channels do (`lib/channels-config.ts`): what was
 * stated holds, and a contradiction refuses boot — see `configureDeletion`.
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
import { isChannelEnabled } from './channels-config';

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
     * The app's own I/O before a purge, outside any transaction: called once the
     * primary read finds the account still `pending`, before the purge
     * transaction opens and without the account lock. Throw to skip that user
     * for this sweep (they stay `pending`, retried on the next tick). A cancel
     * may still win after it returns, so it can run for a purge that never
     * happens, and it runs again on every retry. The sweep logs what it threw by
     * class name and SQLSTATE only; an app that needs the error itself handles
     * it inside the hook.
     */
    onBeforePurge?: (user: AccountDeletionPurgeUser) => Promise<void>;

    /**
     * Called inside the purge transaction, under the account lock, once the
     * purge has claimed the request and before its destructive writes, with the
     * contact read under the lock. The account's rows, and the app's own rows a
     * hard delete would cascade away, are still readable through the
     * transaction. Never published or queued. Database work only: write an
     * outbox row through the app's own repository (it joins this transaction,
     * so the row commits with the purge or not at all) and send from a job
     * after the commit. A hook that opens its own transaction (`requiresNew`)
     * and touches the account's rows never returns: it waits on the lock the
     * purge holds, and PostgreSQL does not see a deadlock. A plain nested
     * `runInTransaction` joins and is fine. A throw rolls the purge back; the
     * request stays `pending` and the next sweep retries it. The purge rejects
     * with `PurgeHookFailedError`, which names the hook, the request, and what
     * the hook threw by class name and SQLSTATE only: it keeps no reference to
     * the hook's error. An app that needs the error itself handles it inside
     * the hook.
     */
    onPurge?: (account: PurgedAccount) => Promise<void>;
}

/** The account a purge destroys, as read under its lock, handed to `onPurge` before the destructive step. */
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

const DEFAULTS: AuthDeletionConfig = {
    gracePeriodDays: DEFAULT_DELETION_GRACE_PERIOD_DAYS,
    purgeStrategy: DEFAULT_DELETION_PURGE_STRATEGY,
    allowSelfImmediate: DEFAULT_DELETION_ALLOW_SELF_IMMEDIATE,
    purgeCron: DEFAULT_DELETION_PURGE_CRON,
};

/** Every option an application stated, each as first stated, to hold every later call to. */
let stated: Partial<AuthDeletionConfig> = {};

/** Why boot must be refused, once two calls stated one option differently. */
let contradiction: string | null = null;

let config: AuthDeletionConfig = { ...DEFAULTS };

/**
 * Set the deletion config. Called synchronously from `createAuthLifecycle()`
 * (not from `afterInfrastructure`) so it takes effect before any route/job handler
 * that reads `getDeletionConfig()` can run.
 *
 * The rule `configureChannels` follows: what was stated holds. A call that
 * states nothing (`deletion` undefined, or an option left undefined) changes
 * nothing, so a second lifecycle built without the option keeps the first
 * one's `onPurge` and `allowSelfImmediate`. An option stated by two calls with
 * different values is a contradiction, refused at boot by
 * `assertDeletionConsistent` naming both, the first staying in force
 * meanwhile. A hook stated twice is two owners of one hook, refused the same
 * way unless it is the same function.
 *
 * @throws Error for an option it does not know — `sendNotifications`, removed,
 *   named as such, so an app that relied on it learns at boot that nothing is
 *   mailed any more — a `purgeStrategy` outside `PURGE_STRATEGIES`, or an
 *   `allowSelfImmediate` that is not a boolean (the string `'false'` would
 *   otherwise read as true)
 */
export function configureDeletion(options?: Partial<AuthDeletionConfig>): void
{
    if (options === undefined)
    {
        return;
    }

    assertKnownDeletionOptions(options);
    assertDeletionOption('purgeStrategy', options.purgeStrategy, PURGE_STRATEGIES);
    assertDeletionOption('allowSelfImmediate', options.allowSelfImmediate, [true, false]);

    const statedNow: Partial<AuthDeletionConfig> = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    contradiction ??= contradictionWith(statedNow);
    stated = { ...statedNow, ...stated };
    config = { ...DEFAULTS, ...stated };
}

/** The refusal for options stated again with another value, or null when every one agrees. */
function contradictionWith(statedNow: Partial<AuthDeletionConfig>): string | null
{
    const clashes = DELETION_OPTIONS
        .filter(key => key in statedNow && key in stated && statedNow[key] !== stated[key])
        .map(key => describeClash(key, stated[key], statedNow[key]));

    if (clashes.length === 0)
    {
        return null;
    }

    return `createAuthLifecycle() was given different deletion options in two calls: ${clashes.join('; ')}. `
        + 'State each once, or the same in every call. Until then the first stays in force.';
}

function describeClash(key: keyof AuthDeletionConfig, first: unknown, second: unknown): string
{
    if (typeof first === 'function' || typeof second === 'function')
    {
        return `${key} by two different functions, ${functionName(first)} and ${functionName(second)} — one hook has one owner`;
    }

    return `${key} ${JSON.stringify(first)} and ${JSON.stringify(second)}`;
}

function functionName(value: unknown): string
{
    return typeof value === 'function' && value.name ? `'${value.name}'` : 'an anonymous function';
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
 * Refuse boot when two `createAuthLifecycle()` calls stated one deletion
 * option differently, or two different `onBeforePurge`/`onPurge` hooks.
 *
 * Called from `afterInfrastructure` rather than thrown by `configureDeletion`:
 * a contradiction is only known once every `createAuthLifecycle()` call has
 * run (see `lifecycle.ts`).
 */
export function assertDeletionConsistent(): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }
}

/** Test-only: the defaults, nothing stated, no contradiction */
export function __resetDeletionForTests(): void
{
    stated = {};
    contradiction = null;
    config = { ...DEFAULTS };
}

/**
 * Refuse boot on `allowSelfImmediate: true` beside `channels.selfDeletion: false`.
 *
 * The option only shapes a request made through `POST /_auth/deletion/request`,
 * and that route is closed: a setting that silently does nothing. Called from
 * `afterInfrastructure`, after `assertChannelsConsistent` and
 * `assertDeletionConsistent`, because both settings are final only once every
 * `createAuthLifecycle()` call has run.
 */
export function assertSelfDeletionConsistent(): void
{
    if (config.allowSelfImmediate && !isChannelEnabled('selfDeletion'))
    {
        throw new Error('deletion.allowSelfImmediate is true, but the selfDeletion channel is off, so no one can '
            + 'request their own deletion. Drop allowSelfImmediate, or turn the channel back on.');
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
