/**
 * SES provider configuration set — a set named once, in code or in the env,
 * reaches every SendEmailCommand; with none named the request is unchanged.
 *
 * `env` is validated once at import, so each test stubs the variable and then
 * imports a fresh module graph. The fresh graph also brings a fresh
 * `configureNotification` state, so no test sees another test's config.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ENV_KEY = 'SPFN_NOTIFICATION_SES_CONFIGURATION_SET';

// Hoisted: vi.mock factories run before module-level consts are initialised.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-sesv2', () => ({
    SESv2Client: class
    {
        send = send;
    },
    SendEmailCommand: class
    {
        input: unknown;

        constructor(input: unknown)
        {
            this.input = input;
        }
    },
}));

const PARAMS = {
    to: ['learner@example.com'],
    from: 'noreply@app.example.com',
    replyTo: 'support@app.example.com',
    subject: 'Hi',
    html: '<p>Hello</p>',
    text: 'Hello',
};

/**
 * Send once through a fresh module graph and return the SendEmailCommand input
 */
async function sendWith(configurationSetName?: string, envValue?: string)
{
    vi.stubEnv(ENV_KEY, envValue);
    vi.resetModules();

    const { configureNotification } = await import('../../../../config');
    const { awsSesProvider } = await import('../aws-ses');

    configureNotification({ email: { configurationSetName } });
    await awsSesProvider.send(PARAMS);

    return send.mock.calls[0][0].input;
}

beforeEach(() =>
{
    send.mockReset();
    send.mockResolvedValue({ MessageId: 'm-1' });
});

afterEach(() =>
{
    vi.unstubAllEnvs();
});

describe('awsSesProvider configuration set', () =>
{
    it('T1: names the set from the code config', async () =>
    {
        const input = await sendWith('cfg-set');

        expect(input.ConfigurationSetName).toBe('cfg-set');
    });

    it('T2: names the set from the env var when the code config has none', async () =>
    {
        const input = await sendWith(undefined, 'env-set');

        expect(input.ConfigurationSetName).toBe('env-set');
    });

    it('T3: the code config wins over the env var', async () =>
    {
        const input = await sendWith('cfg-set', 'env-set');

        expect(input.ConfigurationSetName).toBe('cfg-set');
        expect(JSON.stringify(input)).not.toContain('env-set');
    });

    it('T4: leaves the key out entirely when neither names a set', async () =>
    {
        const input = await sendWith();

        expect(input).not.toHaveProperty('ConfigurationSetName');
    });

    it('T5: changes nothing else in the input', async () =>
    {
        const without = await sendWith();
        send.mockClear();
        const { ConfigurationSetName, ...rest } = await sendWith('cfg-set');

        expect(ConfigurationSetName).toBe('cfg-set');
        expect(rest).toEqual(without);
    });

    it('treats an empty code config as unset', async () =>
    {
        const input = await sendWith('');

        expect(input).not.toHaveProperty('ConfigurationSetName');
    });

    it('treats an empty env var as unset', async () =>
    {
        const input = await sendWith(undefined, '');

        expect(input).not.toHaveProperty('ConfigurationSetName');
    });

    it('falls back to the env var when the code config is empty', async () =>
    {
        const input = await sendWith('', 'env-set');

        expect(input.ConfigurationSetName).toBe('env-set');
    });
});
