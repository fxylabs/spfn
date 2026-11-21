/**
 * @spfn/monitor - a tracked error's text is neither stored nor sent (#382)
 *
 * `trackError` gets the error the server's error handler caught. For a failed
 * statement that error carries every bound value: drizzle's message and stack
 * header end in `params: …`, and the driver error under it holds
 * `Key (email)=(…)` in `detail`. The group, the event and the Slack message
 * hold its description instead. These sinks are repository writes and a Slack
 * payload built from stored fields, which core's scan cannot follow.
 *
 * | #  | goes unnoticed without the row                                                       |
 * | -- | ------------------------------------------------------------------------------------ |
 * | M1 | `error_groups.message`, `error_events.stack_trace` or the Slack text holding values  |
 * | M2 | one fault opening a group per bound value: the message back in the fingerprint       |
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';

vi.mock('../../server/repositories', () => ({
    errorGroupsRepository: {
        findByFingerprint: vi.fn(async () => null),
        create: vi.fn(async (row: object) => ({ id: 1, status: 'active', count: 1, ...row })),
    },
    errorEventsRepository: {
        create: vi.fn(async (row: object) => ({ id: 1, ...row })),
    },
}));

vi.mock('@spfn/notification/server', () => ({
    sendSlack: vi.fn(async () => ({ success: true })),
}));

vi.mock('@spfn/monitor/config', async (importActual) => ({
    ...(await importActual<typeof import('@spfn/monitor/config')>()),
    getSlackWebhookUrl: () => 'https://hooks.example.test/monitor',
}));

import { sendSlack } from '@spfn/notification/server';
import { errorEventsRepository, errorGroupsRepository } from '../../server/repositories';
import { trackError } from '../../server/services/error-tracking.service';

const EMAIL = 'leak-probe@example.test';
const HASH = '$2b$FAKEHASH';

/** The failed insert as drizzle and postgres.js raise it */
function failedInsert(email = EMAIL): Error
{
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
        name: 'PostgresError',
        severity: 'ERROR',
        code: '23505',
        detail: `Key (email)=(${email}) already exists.`,
        schema_name: 'public',
        table_name: 'users',
        constraint_name: 'users_email_key',
        routine: '_bt_check_unique',
    });

    return new DrizzleQueryError('insert into "users" ("email", "password_hash") values ($1, $2)', [email, HASH], driverError);
}

describe('trackError on a failed statement (#382)', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
    });

    it('M1: the stored group and event and the Slack message hold the description, no bound value', async () =>
    {
        const failure = failedInsert();
        expect(failure.message).toContain(EMAIL);

        await trackError(failure, { statusCode: 500, path: '/api/users', method: 'POST' });
        await vi.waitFor(() => expect(sendSlack).toHaveBeenCalledTimes(1));

        const sinks = {
            group: vi.mocked(errorGroupsRepository.create).mock.calls[0][0],
            event: vi.mocked(errorEventsRepository.create).mock.calls[0][0],
            slack: vi.mocked(sendSlack).mock.calls[0][0],
        };

        for (const [sink, written] of Object.entries(sinks))
        {
            const text = JSON.stringify(written);

            expect(text, sink).toContain('users_email_key');

            for (const leak of [EMAIL, HASH, 'Key (', 'Failing row', 'params:'])
            {
                expect(text, sink).not.toContain(leak);
            }
        }

        expect(sinks.group.message).toBe('DrizzleQueryError [code=23505] [constraint=users_email_key] [table=users]: '
            + 'duplicate key value violates unique constraint "users_email_key"');
    });

    it('M2: the same failed insert with another value is looked up under the same fingerprint', async () =>
    {
        const context = { statusCode: 500, path: '/api/users', method: 'POST' };
        // Raised from one call site, as the same fault is: same frames, other values
        const [first, second] = ['a@example.test', 'b@example.test'].map(email => failedInsert(email));

        await trackError(first, context);
        await trackError(second, context);

        const [[looked], [lookedAgain]] = vi.mocked(errorGroupsRepository.findByFingerprint).mock.calls;

        expect(lookedAgain).toBe(looked);
    });
});
