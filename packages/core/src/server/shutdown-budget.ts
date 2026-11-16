/**
 * Shutdown Budget
 *
 * The one rule for how long each graceful-shutdown phase may take.
 *
 * `shutdown.timeout` T is a single deadline, taken when the shutdown starts;
 * the forced-exit timer fires at that same deadline. T is shared by proportion:
 *
 * - waiting for accepted work — the HTTP close, then the drain — is entitled
 *   to at least half of T;
 * - the hooks (`onShutdown` hooks and `beforeShutdown`, one budget) to a fifth;
 * - the enabled infrastructure closes (jobs, database, event transport, Redis)
 *   share the remaining three tenths in proportion to their caps, each never
 *   above its cap: `reserve_i = min(cap_i, 0.3 · T · cap_i / Σ caps of enabled)`.
 *   Disabled infrastructure reserves nothing. What the reserves do not need
 *   goes to the work: once 0.3 · T ≥ Σ caps the drain gets T − hooks − Σ caps.
 *
 * Inside the work share, the HTTP and WebSocket closes keep their own 5 s caps
 * and together may take at most half of the share: the other half is the
 * drain's, so a slow HTTP close cannot starve it.
 *
 * A reserve is time an earlier phase cannot spend. A phase starting now gets
 *
 *     max(min(its own cap, time left − the reserves of the later phases that are enabled),
 *         min(its own reserve, time left))
 *
 * so time a phase does not use flows forward to the phases after it, and a
 * phase gets 0 — is skipped — only once the deadline has passed.
 */

export type ShutdownPhase =
    | 'http'
    | 'websocket'
    | 'drain'
    | 'hooks'
    | 'jobs'
    | 'database'
    | 'eventTransport'
    | 'redis';

export interface ShutdownInfrastructure
{
    jobs: boolean;
    database: boolean;
    redis: boolean;
}

export interface ShutdownBudget
{
    /** Epoch ms the forced-exit timer fires at */
    readonly deadline: number;

    /** Milliseconds held back for the hooks and the enabled infrastructure phases */
    readonly reserved: number;

    /** Milliseconds the phase may take if it starts now */
    phase(name: ShutdownPhase): number;
}

/**
 * pg-boss needs this long to fail the jobs still running and close its pool —
 * the part of stopping it that needs no handler wait.
 */
export const JOB_FAIL_TIME = 1000;

const JOB_HANDLER_WAIT_CAP = 30_000;

/** pg-boss's own floor: a graceful stop waits at least this long for handlers */
const JOB_HANDLER_WAIT_FLOOR = 1000;

const HOOKS_SHARE = 0.2;

const INFRASTRUCTURE_SHARE = 0.3;

interface PhaseRule
{
    name: ShutdownPhase;
    cap: number;
    reserve: number;
}

interface InfrastructureRule
{
    name: ShutdownPhase;
    runsWith: keyof ShutdownInfrastructure;

    /** The most this phase may take, when earlier phases leave the time */
    cap: number;

    /** The most held back for it: its share is in proportion to this */
    reserveCap: number;
}

/**
 * The infrastructure closes in shutdown order
 *
 * The job queue's reserve cap is pg-boss's shortest handler wait plus failing
 * what is left; with less than that, it fails the running jobs without waiting.
 */
const INFRASTRUCTURE_RULES: InfrastructureRule[] = [
    {
        name: 'jobs',
        runsWith: 'jobs',
        cap: JOB_HANDLER_WAIT_CAP + JOB_FAIL_TIME,
        reserveCap: JOB_HANDLER_WAIT_FLOOR + JOB_FAIL_TIME,
    },
    { name: 'database', runsWith: 'database', cap: 5000, reserveCap: 5000 },
    { name: 'eventTransport', runsWith: 'redis', cap: 2000, reserveCap: 2000 },
    { name: 'redis', runsWith: 'redis', cap: 5000, reserveCap: 5000 },
];

/**
 * The phases in shutdown order, for a shutdown of `timeout` ms
 */
function phaseRules(timeout: number, infrastructure: ShutdownInfrastructure): PhaseRule[]
{
    const closes = infrastructureReserves(timeout, infrastructure);
    const hooks = Math.floor(timeout * HOOKS_SHARE);
    const work = timeout - hooks - sumOfReserves(closes);

    return [
        { name: 'http', cap: 5000, reserve: 0 },
        { name: 'websocket', cap: 5000, reserve: 0 },
        { name: 'drain', cap: Infinity, reserve: Math.ceil(work / 2) },
        { name: 'hooks', cap: Infinity, reserve: hooks },
        ...closes,
    ];
}

/**
 * The enabled infrastructure closes, each holding its proportional share of
 * three tenths of `timeout`, never above its reserve cap
 */
function infrastructureReserves(timeout: number, infrastructure: ShutdownInfrastructure): PhaseRule[]
{
    const enabled = INFRASTRUCTURE_RULES.filter((rule) => infrastructure[rule.runsWith]);
    const capSum = enabled.reduce((sum, rule) => sum + rule.reserveCap, 0);

    return enabled.map((rule) => ({
        name: rule.name,
        cap: rule.cap,
        reserve: Math.floor(Math.min(rule.reserveCap, INFRASTRUCTURE_SHARE * timeout * rule.reserveCap / capSum)),
    }));
}

/**
 * Create the budget for a shutdown that must be over by `deadline`
 */
export function createShutdownBudget(deadline: number, infrastructure: ShutdownInfrastructure): ShutdownBudget
{
    const rules = phaseRules(deadline - Date.now(), infrastructure);

    return {
        deadline,
        reserved: sumOfReserves(rules.slice(rules.findIndex((rule) => rule.name === 'hooks'))),
        phase: (name) =>
        {
            const index = rules.findIndex((rule) => rule.name === name);
            const timeLeft = deadline - Date.now();
            const shared = Math.min(rules[index].cap, timeLeft - sumOfReserves(rules.slice(index + 1)));

            return Math.max(0, shared, Math.min(rules[index].reserve, timeLeft));
        },
    };
}

function sumOfReserves(rules: PhaseRule[]): number
{
    return rules.reduce((sum, rule) => sum + rule.reserve, 0);
}
