import { describe, it, expect } from 'vitest';
import { assertUnconditionalRegistration, ConditionalRegistrationError } from '../generators/contract-guard';

const PATH = './src/server/router.ts';

describe('conditional route registration', () =>
{
    it('accepts a plain router', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                getUser,
                listUsers,
            });
        `;

        expect(() => assertUnconditionalRegistration(PATH, source)).not.toThrow();
    });

    it('accepts a spread of a plain object', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                ...baseRoutes,
                getUser,
            });
        `;

        expect(() => assertUnconditionalRegistration(PATH, source)).not.toThrow();
    });

    it('refuses a route behind a ternary', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                getUser,
                ...(flags.beta ? { betaRoute } : {}),
            });
        `;

        expect(() => assertUnconditionalRegistration(PATH, source)).toThrow(ConditionalRegistrationError);
    });

    it('refuses a conditional spread in a second defineRouter, where a nested router is assembled', () =>
    {
        const source = `
            const users = defineRouter({ listUsers });

            export const appRouter = defineRouter({
                users,
                ...(process.env.ENABLE_ADMIN ? { admin } : {}),
            });
        `;

        expect(() => assertUnconditionalRegistration(PATH, source)).toThrow(ConditionalRegistrationError);
    });

    it('refuses a route behind an environment check', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                ...(process.env.NODE_ENV === 'development' && { devRoute }),
            });
        `;

        expect(() => assertUnconditionalRegistration(PATH, source)).toThrow(/conditionally/);
    });

    it('names the file and the expression', () =>
    {
        const source = 'export const appRouter = defineRouter({ ...(flags.beta ? { betaRoute } : {}) });';

        expect(() => assertUnconditionalRegistration(PATH, source)).toThrow(new RegExp(PATH.replace(/[./]/g, '\\$&')));
    });

    it('ignores a file with no defineRouter call', () =>
    {
        expect(() => assertUnconditionalRegistration(PATH, 'export const x = 1;')).not.toThrow();
    });
});
