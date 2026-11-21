/**
 * @spfn/notification - the error Slack message carries the error's description (#382)
 *
 * `createErrorSlackNotifier` gets the error the server's error handler caught.
 * For a failed statement that error carries every bound value: drizzle's
 * message and stack header end in `params: …`, and the driver error under it
 * holds `Key (email)=(…)` in `detail`. The message is a Slack payload, which
 * core's scan does not read as a sink.
 *
 * | #  | goes unnoticed without the row                                               |
 * | -- | ---------------------------------------------------------------------------- |
 * | N1 | the Slack text or its stack block carrying the statement's values to Slack  |
 */

import { describe, it, expect, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';

vi.mock('../../channels/slack', () => ({
    sendSlack: vi.fn(async () => ({ success: true })),
}));

import { sendSlack } from '../../channels/slack';
import { createErrorSlackNotifier } from '../error-slack';

const EMAIL = 'leak-probe@example.test';
const HASH = '$2b$FAKEHASH';

/** The failed insert as drizzle and postgres.js raise it */
function failedInsert(): Error
{
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
        name: 'PostgresError',
        severity: 'ERROR',
        code: '23505',
        detail: `Key (email)=(${EMAIL}) already exists.`,
        table_name: 'users',
        constraint_name: 'users_email_key',
        routine: '_bt_check_unique',
    });

    return new DrizzleQueryError('insert into "users" ("email", "password_hash") values ($1, $2)', [EMAIL, HASH], driverError);
}

describe('createErrorSlackNotifier (#382)', () =>
{
    it('N1: a failed statement is sent as its description\'s safe fields, no bound value', async () =>
    {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const notify = createErrorSlackNotifier({ webhookUrl: 'https://hooks.example.test/errors' });
        const failure = failedInsert();
        expect(failure.message).toContain(EMAIL);

        await notify(failure, {
            statusCode: 500,
            path: '/api/users',
            method: 'POST',
            timestamp: new Date(0).toISOString(),
            request: { headers: {}, query: {} },
        });

        const sent = JSON.stringify(vi.mocked(sendSlack).mock.calls[0][0]);

        expect(sent).toContain('DrizzleQueryError [code=23505] [constraint=users_email_key] [table=users]');

        for (const leak of [EMAIL, HASH, 'Key (', 'Failing row', 'params:'])
        {
            expect(sent).not.toContain(leak);
        }
    });
});
