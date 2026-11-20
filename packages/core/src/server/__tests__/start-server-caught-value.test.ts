/**
 * startServer logs a thrown non-Error by its description, not by its fields (#382)
 *
 * `logger.error(message, value)` reads a plain object as the context and
 * walks it. The startup and shutdown catch sites used to copy the caught value
 * into `const err = error as Error` and pass it that way, so a hook throwing
 * `{ code, params }` logged its params. They pass `{ error }` now.
 *
 * | #   | the plain object is thrown by                | goes unnoticed without the row                    |
 * | --- | -------------------------------------------- | ------------------------------------------------- |
 * | S1  | a `beforeInfrastructure` hook                 | "Server initialization failed" printing params    |
 * | S2  | the shutdown run, on SIGTERM                  | "Error during graceful shutdown" printing params  |
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger as DistLogger } from '@spfn/core/logger';

import { BOUND_VALUES, captureLoggerClass, expectNoValues } from '../../logger/__tests__/helpers/leak-probe';
import { defineServerConfig } from '../config-builder';
import { serverLogger } from '../logger';
import { startServer } from '../start-server';

vi.mock('@spfn/core/cache', () => ({
    getCache: () => undefined,
    isCacheDisabled: () => true,
    initCache: async () => undefined,
    closeCache: async () => undefined,
}));

vi.mock('@hono/node-server', () => ({
    serve: vi.fn(() => ({
        close: (callback: (error?: Error) => void) => callback(),
        requestTimeout: 0,
        keepAliveTimeout: 0,
        headersTimeout: 0,
    })),
}));

const thrownObject = (): Record<string, unknown> => ({ code: 'E_HOOK', params: [...BOUND_VALUES] });

const described = { kind: 'error', name: 'NonError', code: 'E_HOOK' };

const PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];

/** `process` as a plain emitter: its per-event listener overloads do not take a string */
const emitter: NodeJS.EventEmitter = process;

/** The process listeners present before a row, so the ones startServer adds can be removed */
const listenersBefore = new Map(PROCESS_EVENTS.map(event => [event, new Set(emitter.listeners(event))]));

/** The listeners startServer added for the event */
function addedListeners(event: string): ((...args: unknown[]) => void)[]
{
    return emitter.listeners(event).filter(listener => !listenersBefore.get(event)!.has(listener)) as ((...args: unknown[]) => void)[];
}

afterEach(() =>
{
    for (const event of PROCESS_EVENTS)
    {
        addedListeners(event).forEach(listener => emitter.removeListener(event, listener));
    }

    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('startServer logs a thrown non-Error by its description', () =>
{
    it('S1: a hook that throws a plain object during startup', async () =>
    {
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
        const { lines, output } = captureLoggerClass(DistLogger);

        const started = startServer(defineServerConfig()
            .host('127.0.0.1')
            .port(1)
            .infrastructure({ database: false, redis: false })
            .lifecycle({
                beforeInfrastructure: async () =>
                {
                    throw thrownObject();
                },
            })
            .build());

        await expect(started).rejects.toMatchObject({ code: 'E_HOOK' });
        expect(lines.find(line => line.message === 'Server initialization failed')?.context?.error).toEqual(described);
        expectNoValues(output());
    });

    it('S2: a shutdown run that rejects with a plain object', async () =>
    {
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
        const exited = new Promise<number | undefined>(resolve =>
        {
            vi.spyOn(process, 'exit').mockImplementation(((code?: number) => resolve(code)) as never);
        });

        await startServer(defineServerConfig()
            .host('127.0.0.1')
            .port(39994)
            .infrastructure({ database: false, redis: false })
            .build());

        const [sigterm] = addedListeners('SIGTERM');
        const { lines, output } = captureLoggerClass(DistLogger);
        // The shutdown run's first line throws, so the run rejects with the object
        vi.spyOn(serverLogger, 'info').mockImplementation((message: string) =>
        {
            if (message === 'Shutdown started')
            {
                throw thrownObject();
            }
        });

        // The listener itself, not process.emit: the runner may listen too
        sigterm('SIGTERM');

        expect(await exited).toBe(1);
        expect(lines.find(line => line.message === 'Error during graceful shutdown')?.context?.error).toEqual(described);
        expectNoValues(output());
    });
});
