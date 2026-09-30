/**
 * Environment boot check
 *
 * The server validates every variable it can see before it listens: core's
 * registry plus the registries the app hands over in server.config. These
 * tests pin the three promises that makes — a missing variable stops the boot
 * with exit code 1, the log names keys and never values, and
 * SKIP_ENV_VALIDATION (a build-step switch) does not turn the check off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';

import { createEnvRegistry, defineEnvSchema, envNumber, envString, envSecret } from '../../env';
import { runEnvBootCheck } from '../env-boot-check';
import { serverLogger } from '../logger';
import { createServerlessApp, resetServerlessApp } from '../serverless';
import { startServer } from '../start-server';

vi.mock('@hono/node-server', () => ({
    serve: vi.fn(),
}));

const SECRET_VALUE = 'hunter2-this-must-never-reach-a-log';
const NUMBER_VALUE = 'not-a-number-but-a-leak';

const appRegistry = createEnvRegistry(defineEnvSchema({
    BILLING_API_KEY: envString({
        description: 'Billing provider API key',
        required: true,
    }),
    BILLING_WEBHOOK_SECRET: envSecret({
        description: 'Billing webhook signing secret',
        validator: (value: string) =>
        {
            // An app validator that echoes its input — the registry must drop it.
            throw new Error(`rejected ${value}`);
        },
    }),
    BILLING_RETRY_LIMIT: envNumber({
        description: 'Billing retry limit',
    }),
}));

/** Everything the server logger and the console were handed, as one string. */
function capturedLog(): string
{
    const calls = [
        ...vi.mocked(serverLogger.error).mock.calls,
        ...vi.mocked(serverLogger.warn).mock.calls,
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
    ];

    return calls.map(call => call.map(arg => String(arg)).join(' ')).join('\n');
}

beforeEach(() =>
{
    vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
    vi.stubEnv('NEXT_PUBLIC_SPFN_API_URL', '');
    vi.stubEnv('BILLING_API_KEY', '');
    vi.stubEnv('BILLING_WEBHOOK_SECRET', '');
    vi.stubEnv('BILLING_RETRY_LIMIT', '');

    vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
    {
        throw new Error(`process.exit(${code})`);
    }) as never);
});

afterEach(() =>
{
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.mocked(serve).mockClear();
});

describe('runEnvBootCheck', () =>
{
    it('passes when every required variable is set', () =>
    {
        vi.stubEnv('BILLING_API_KEY', 'key');

        expect(runEnvBootCheck({ env: { registries: [appRegistry] } }).valid).toBe(true);
    });

    it('checks core\'s registry even when the app registers none', () =>
    {
        vi.stubEnv('SPFN_API_URL', '');

        const result = runEnvBootCheck({});

        expect(result.valid).toBe(false);
        expect(result.errors.map(error => error.key)).toEqual(['SPFN_API_URL']);
    });

    it('does not require NEXT_PUBLIC_SPFN_API_URL, which Next.js inlines at build and the server does not read', () =>
    {
        expect(runEnvBootCheck({}).valid).toBe(true);
    });

    it('runs each validator on a present value, and logs the key but not the value', () =>
    {
        vi.stubEnv('BILLING_API_KEY', 'key');
        vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET_VALUE);
        vi.stubEnv('BILLING_RETRY_LIMIT', NUMBER_VALUE);

        const result = runEnvBootCheck({ env: { registries: [appRegistry] } });

        expect(result.errors.map(error => error.key)).toEqual(['BILLING_WEBHOOK_SECRET', 'BILLING_RETRY_LIMIT']);

        const log = capturedLog();

        expect(log).toContain('BILLING_WEBHOOK_SECRET');
        expect(log).toContain('BILLING_RETRY_LIMIT');
        expect(log).not.toContain(SECRET_VALUE);
        expect(log).not.toContain(NUMBER_VALUE);
    });

    it('reports a key two registries declare once', () =>
    {
        const twin = createEnvRegistry(defineEnvSchema({
            BILLING_API_KEY: envString({ description: 'Billing provider API key', required: true }),
        }));

        const result = runEnvBootCheck({ env: { registries: [appRegistry, twin] } });

        expect(result.errors.map(error => error.key)).toEqual(['BILLING_API_KEY']);
    });
});

describe('startServer', () =>
{
    it('exits with code 1 before listening when a required variable is missing', async () =>
    {
        await expect(startServer({ env: { registries: [appRegistry] } })).rejects.toThrow('process.exit(1)');

        expect(process.exit).toHaveBeenCalledWith(1);
        expect(serve).not.toHaveBeenCalled();
        expect(capturedLog()).toContain('BILLING_API_KEY');
    });

    it('ignores SKIP_ENV_VALIDATION, which only relaxes the lazy proxy', async () =>
    {
        vi.stubEnv('SKIP_ENV_VALIDATION', 'true');

        await expect(startServer({ env: { registries: [appRegistry] } })).rejects.toThrow('process.exit(1)');

        expect(serve).not.toHaveBeenCalled();
    });

    it('never prints a value that failed its validator', async () =>
    {
        vi.stubEnv('BILLING_API_KEY', 'key');
        vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET_VALUE);

        await expect(startServer({ env: { registries: [appRegistry] } })).rejects.toThrow('process.exit(1)');

        expect(capturedLog()).toContain('BILLING_WEBHOOK_SECRET');
        expect(capturedLog()).not.toContain(SECRET_VALUE);
    });
});

describe('createServerlessApp', () =>
{
    it('rejects instead of exiting — the platform owns the process', async () =>
    {
        resetServerlessApp();

        await expect(createServerlessApp({ env: { registries: [appRegistry] } }))
            .rejects.toThrow('Environment validation failed');

        expect(process.exit).not.toHaveBeenCalled();
        expect(capturedLog()).toContain('BILLING_API_KEY');

        resetServerlessApp();
    });
});
