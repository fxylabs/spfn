/**
 * An emitted event's debug line names the event, not its payload (#526)
 *
 * `emit` logged `{ payload }` at debug level. The logger masks a context value
 * only when its key's name holds a sensitive word, so a payload's `email` or
 * `name` was written as it was whenever debug logging was on.
 *
 * | #   | act                                               | goes unnoticed without the row                     |
 * | --- | ------------------------------------------------- | -------------------------------------------------- |
 * | L1  | emit a payload holding an address and a name      | the emit line writing every payload value it gets  |
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Logger as DistLogger } from '@spfn/core/logger';

import { captureLoggerClass } from '../../logger/__tests__/helpers/leak-probe';
import { defineEvent } from '../event';

const ADDRESS = 'l1-probe@example.test';
const NAME = 'L1 Probe Name';

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('emit logs the event name, not the payload', () =>
{
    it('L1: no line holds a payload value; the event name appears', async () =>
    {
        const { lines, output } = captureLoggerClass(DistLogger);
        const probed = defineEvent('test.l1.probed', Type.Object({ email: Type.String(), name: Type.String() }));

        await probed.emit({ email: ADDRESS, name: NAME });

        expect(lines.some(line => line.message === 'Emitting event: test.l1.probed')).toBe(true);
        expect(output()).not.toContain(ADDRESS);
        expect(output()).not.toContain(NAME);
    });
});
