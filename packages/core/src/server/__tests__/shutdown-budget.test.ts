/**
 * T4 — the shutdown budget rule, on a simulated clock
 *
 * Of `shutdown.timeout` T: the work phases (HTTP close, WebSocket close, the
 * wait for job fetches in flight, drain) get at least half, the hooks a
 * fifth, and the enabled infrastructure closes share three tenths in
 * proportion to their caps, each never above its cap. Every phase here takes its whole budget, so each later
 * phase finds exactly what was held back for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOSS_MIN_HANDLER_WAIT } from '../../job/boss';
import { createShutdownBudget, JOB_FAIL_TIME } from '../shutdown-budget';
import type { ShutdownInfrastructure, ShutdownPhase } from '../shutdown-budget';

/** The caps the infrastructure shares are proportional to, stated independently of the code */
const CAPS = { jobs: 2000, database: 5000, eventTransport: 2000, redis: 5000 };

const ALL_ON: ShutdownInfrastructure = { jobs: true, database: true, redis: true };

const DATABASE_ONLY: ShutdownInfrastructure = { jobs: false, database: true, redis: false };

const WORK_PHASES: ShutdownPhase[] = ['http', 'websocket', 'jobFetch', 'drain'];

type Close = keyof typeof CAPS;

describe('T4: the shutdown budget rule', () =>
{
    beforeEach(() =>
    {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
    });

    afterEach(() =>
    {
        vi.useRealTimers();
    });

    /** Every phase in order takes its whole budget; returns what each got */
    function walkAtBound(timeout: number, infrastructure: ShutdownInfrastructure): Map<ShutdownPhase, number>
    {
        const budget = createShutdownBudget(Date.now() + timeout, infrastructure);
        const closes = enabledCloses(infrastructure);
        const taken = new Map<ShutdownPhase, number>();

        for (const phase of [...WORK_PHASES, 'hooks', ...closes] as ShutdownPhase[])
        {
            taken.set(phase, budget.phase(phase));
            vi.setSystemTime(Date.now() + taken.get(phase)!);
        }

        return taken;
    }

    function enabledCloses(infrastructure: ShutdownInfrastructure): Close[]
    {
        return (Object.keys(CAPS) as Close[]).filter((close) =>
            infrastructure[close === 'eventTransport' ? 'redis' : close]);
    }

    function expectTheRule(timeout: number, infrastructure: ShutdownInfrastructure): void
    {
        const taken = walkAtBound(timeout, infrastructure);
        const closes = enabledCloses(infrastructure);
        const capSum = closes.reduce((sum, close) => sum + CAPS[close], 0);
        const work = WORK_PHASES.reduce((sum, phase) => sum + taken.get(phase)!, 0);

        expect(work).toBeGreaterThanOrEqual(timeout / 2);
        expect(taken.get('hooks')).toBe(timeout / 5);
        closes.forEach((close) =>
            expect(taken.get(close)).toBe(Math.floor(Math.min(CAPS[close], 0.3 * timeout * CAPS[close] / capSum))));
        expect([...taken.values()].reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(timeout);
        [...taken.values()].forEach((ms) => expect(ms).toBeGreaterThanOrEqual(0));
        // The HTTP and WebSocket closes and the fetch wait cannot take the drain's half of the work share
        expect(taken.get('drain')).toBeGreaterThanOrEqual(work / 2);
    }

    it.each([3_000, 10_000, 15_000, 30_000, 280_000])('T4: all infrastructure on, shutdown.timeout %i ms', (timeout) =>
    {
        expectTheRule(timeout, ALL_ON);
    });

    it('T4: only the database, shutdown.timeout 10000 ms', () =>
    {
        expectTheRule(10_000, DATABASE_ONLY);
    });

    it('T4: once three tenths cover every cap, each close holds exactly its cap and the rest goes to the drain', () =>
    {
        const taken = walkAtBound(280_000, ALL_ON);

        expect(taken.get('database')).toBe(CAPS.database);
        expect(taken.get('drain')).toBe(280_000 - 56_000 - 14_000 - taken.get('http')! - taken.get('websocket')!
            - taken.get('jobFetch')!);
    });

    it('T4: a jobs share below pg-boss\'s graceful minimum plus the fail means a stop without a wait', () =>
    {
        const taken = walkAtBound(10_000, ALL_ON);

        expect(taken.get('jobs')!).toBeLessThan(BOSS_MIN_HANDLER_WAIT + JOB_FAIL_TIME);
    });
});
