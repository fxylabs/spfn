/**
 * Every line auth writes, seen whole: a spy on each level of every
 * `authLogger` child, read with `util.inspect` deep enough to see inside an
 * `Error` — `JSON.stringify` of an Error is `{}`, so a recipient in a caught
 * error's message or stack would pass a JSON check unseen.
 */

import { inspect } from 'node:util';
import { vi, type MockInstance } from 'vitest';
import { Logger } from '@spfn/core/logger';
import { authLogger } from '@/server/logger';

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

export interface AuthLog
{
    /** Every call, on every child at every level, in no particular order. */
    calls: () => unknown[][];
    /** Every call, inspected. */
    text: () => string;
    restore: () => void;
}

/** Every Logger under `node`, at any depth. */
function loggersIn(node: unknown): Logger[]
{
    if (node instanceof Logger)
    {
        return [node];
    }

    return Object.values(node as Record<string, unknown>).flatMap(loggersIn);
}

/** Spy on every level of every `authLogger` child; the spies pass through. */
export function spyOnAuthLog(): AuthLog
{
    const spies: MockInstance[] = loggersIn(authLogger).flatMap(child => LEVELS.map(level => vi.spyOn(child, level)));
    const calls = () => spies.flatMap(spy => spy.mock.calls);

    return {
        calls,
        text: () => inspect(calls(), { depth: 10 }),
        restore: () => spies.forEach(spy => spy.mockRestore()),
    };
}
