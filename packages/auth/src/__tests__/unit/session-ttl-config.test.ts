/**
 * @spfn/auth - where the session lifetime comes from (fxylabs/spfn#126, claim 3)
 *
 * Began as the reproduction; the T rows of the fix follow it. `getSessionTtl`
 * documents the order override → `configureAuth` → `SPFN_AUTH_SESSION_TTL` →
 * seven days, and the README and the
 * authentication guide tell an app to set the environment variable. But the
 * module initialises `globalConfig` with `sessionTtl: '7d'`, so the second step
 * always answers and the variable is never read.
 *
 * `globalConfig` is module state, so every row loads a fresh copy of the module,
 * and a row that configures it puts the previous value back afterwards.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { authEnvSchema } from '../../config/schema';

type ConfigModule = typeof import('../../server/lib/config');

/** The module instance the current row configured, and what its sessionTtl was before. */
let configured: { module: ConfigModule; previous: string | number | undefined } | undefined;

async function freshConfig(): Promise<ConfigModule>
{
    vi.resetModules();

    return await import('../../server/lib/config');
}

/** `configureAuth({ sessionTtl })`, remembered so `afterEach` can put it back. */
function configureSessionTtl(module: ConfigModule, sessionTtl: string): void
{
    configured = { module, previous: module.getAuthConfig().sessionTtl };
    module.configureAuth({ sessionTtl });
}

const TWELVE_HOURS = 12 * 3600;
const THIRTY_DAYS = 30 * 24 * 3600;
const SEVEN_DAYS = 7 * 24 * 3600;

describe('getSessionTtl precedence (#126 claim 3)', () =>
{
    afterEach(() =>
    {
        configured?.module.configureAuth({ sessionTtl: configured.previous });
        configured = undefined;
        vi.unstubAllEnvs();
    });

    it('reads SPFN_AUTH_SESSION_TTL when configureAuth set no sessionTtl', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        const { getSessionTtl } = await freshConfig();
        const { env } = await import('@spfn/auth/config');

        // The variable does reach the config module; it is getSessionTtl that
        // never asks. Today: 604800 — the '7d' globalConfig was initialised with.
        expect(env.SPFN_AUTH_SESSION_TTL).toBe('12h');
        expect(getSessionTtl()).toBe(TWELVE_HOURS);
    });

    it('configureAuth({ sessionTtl }) wins over the environment variable', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        const config = await freshConfig();

        configureSessionTtl(config, '30d');

        expect(config.getSessionTtl()).toBe(THIRTY_DAYS);
    });

    it('a per-call override wins over both', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        const config = await freshConfig();

        configureSessionTtl(config, '30d');

        expect(config.getSessionTtl('45m')).toBe(45 * 60);
    });

    it('with nothing configured the lifetime is seven days', async () =>
    {
        const { getSessionTtl } = await freshConfig();

        expect(getSessionTtl()).toBe(SEVEN_DAYS);
    });

    it('T1: nothing configured — seven days', async () =>
    {
        const { getSessionTtl, getAuthConfig } = await freshConfig();

        expect(getAuthConfig().sessionTtl).toBeUndefined();
        expect(getSessionTtl()).toBe(SEVEN_DAYS);
    });

    it('T2: SPFN_AUTH_SESSION_TTL=12h alone — twelve hours', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        const { getSessionTtl } = await freshConfig();

        expect(getSessionTtl()).toBe(TWELVE_HOURS);
    });

    it('T3: configureAuth 30d over env 12h — thirty days', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        const config = await freshConfig();

        configureSessionTtl(config, '30d');

        expect(config.getSessionTtl()).toBe(THIRTY_DAYS);
    });

    it('T4: per-call 45m over configureAuth 30d over env 12h — forty-five minutes', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        const config = await freshConfig();

        configureSessionTtl(config, '30d');

        expect(config.getSessionTtl('45m')).toBe(45 * 60);
    });

    it('T5: an invalid SPFN_AUTH_SESSION_TTL throws, as an invalid configureAuth value does', async () =>
    {
        // The schema's validator (T5b) refuses the value when the environment is
        // validated, and the env proxy runs the same validator on every read, so
        // reading the variable throws the registry's error. Either way the value
        // never falls through to the default — the same thing a malformed
        // `configureAuth({ sessionTtl })` does.
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', 'a fortnight');
        const { getSessionTtl } = await freshConfig();

        expect(() => getSessionTtl()).toThrow('Environment validation failed');
    });

    it('T5b: the schema refuses a duration parseDuration cannot read and keeps one it can, as a string', async () =>
    {
        const { validator } = authEnvSchema.SPFN_AUTH_SESSION_TTL;

        expect(() => validator('1w')).toThrow(/Invalid duration format: 1w/);

        for (const value of ['7d', '12h', '45m', '3600s', '3600', authEnvSchema.SPFN_AUTH_SESSION_TTL.default])
        {
            expect(validator(value)).toBe(value);
        }
    });

    it('T6: the `remember` argument login-register passes is still a per-call override', async () =>
    {
        // `loginRegisterInterceptor` lifts `remember` off the login body and calls
        // `getSessionTtl(ctx.metadata.remember)`: a duration when the form sent
        // one, undefined when it did not — which falls through to the env value.
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        const { getSessionTtl } = await freshConfig();

        expect(getSessionTtl('30d')).toBe(THIRTY_DAYS);
        expect(getSessionTtl(3600)).toBe(3600);
        expect(getSessionTtl(undefined)).toBe(TWELVE_HOURS);
    });
});
