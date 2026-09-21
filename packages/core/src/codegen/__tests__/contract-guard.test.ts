/**
 * The registration guard
 *
 * Every case is the source of a router file, scanned the way a generator scans
 * it: for one named export, the one its loader found the router under. The
 * shapes that must *not* be refused matter as much as the ones that must — a
 * guard that stops a build the runtime serves correctly is worse than no guard,
 * because the app developer has nothing to fix.
 */

import { describe, it, expect } from 'vitest';
import { assertUnconditionalRegistration, ConditionalRegistrationError } from '../generators/contract-guard';

const PATH = './src/server/router.ts';

/** Scan `source` the way the route-map generator scans it. */
function scan(source: string, exportName = 'appRouter'): void
{
    assertUnconditionalRegistration({ routerPath: PATH, source, exportName, subject: 'route map' });
}

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

        expect(() => scan(source)).not.toThrow();
    });

    it('accepts a spread of a plain object', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                ...baseRoutes,
                getUser,
            });
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('refuses a route behind a ternary', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                getUser,
                ...(flags.beta ? { betaRoute } : {}),
            });
        `;

        expect(() => scan(source)).toThrow(ConditionalRegistrationError);
    });

    it('refuses a route behind an environment check', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                ...(process.env.NODE_ENV === 'development' && { devRoute }),
            });
        `;

        expect(() => scan(source)).toThrow(/conditionally/);
    });

    it('refuses a route behind ?? and behind ||', () =>
    {
        expect(() => scan('const appRouter = defineRouter({ ...(extra ?? {}) });')).toThrow(/\?\?/);
        expect(() => scan('const appRouter = defineRouter({ ...(extra || {}) });')).toThrow(/\|\|/);
    });

    it('names the file and the expression', () =>
    {
        const source = 'export const appRouter = defineRouter({ ...(flags.beta ? { betaRoute } : {}) });';

        expect(() => scan(source)).toThrow(new RegExp(PATH.replace(/[./]/g, '\\$&')));
        expect(() => scan(source)).toThrow(/flags\.beta \? \{ betaRoute \} : \{\}/);
    });

    it('names what is being generated, so the route map does not talk about contracts', () =>
    {
        const source = 'const appRouter = defineRouter({ ...(flags.beta ? { betaRoute } : {}) });';

        expect(() => scan(source)).toThrow(/The route map is generated/);
        expect(() => assertUnconditionalRegistration({
            routerPath: PATH,
            source,
            exportName: 'appRouter',
            subject: 'contract',
        })).toThrow(/The contract is generated/);
    });

    it('ignores a file with no defineRouter call', () =>
    {
        expect(() => scan('export const x = 1;')).not.toThrow();
    });

    it('ignores a router built by a factory, which it cannot read', () =>
    {
        expect(() => scan('export const appRouter = buildRouter({ feature: true });')).not.toThrow();
    });
});

describe('the guard reads the router the generator was pointed at', () =>
{
    it('refuses a conditional spread in a nested router the app router mounts', () =>
    {
        const source = `
            const admin = defineRouter({ ...(process.env.ENABLE_ADMIN ? { purge } : {}) });

            export const appRouter = defineRouter({ getUser, admin });
        `;

        expect(() => scan(source)).toThrow(ConditionalRegistrationError);
    });

    it('refuses a conditional spread in a router nested inline', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                admin: defineRouter({ ...(flags.beta ? { purge } : {}) }),
            });
        `;

        expect(() => scan(source)).toThrow(ConditionalRegistrationError);
    });

    it('refuses a conditional spread three routers deep', () =>
    {
        const source = `
            const keys = defineRouter({ ...(flags.beta ? { listKeys } : {}) });
            const users = defineRouter({ listUsers, keys });

            export const appRouter = defineRouter({ users });
        `;

        expect(() => scan(source)).toThrow(ConditionalRegistrationError);
    });

    it('accepts a conditional router the app router never mounts', () =>
    {
        const source = `
            export const appRouter = defineRouter({ getRoot });

            export const testRouter = defineRouter({ ...(process.env.ENABLE_TEST ? { testRoute } : {}) });
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('reads the export it is told about, not the first router in the file', () =>
    {
        const source = `
            export const appRouter = defineRouter({ ...(flags.beta ? { betaRoute } : {}) });

            export const router = defineRouter({ getRoot });
        `;

        expect(() => scan(source, 'router')).not.toThrow();
        expect(() => scan(source, 'appRouter')).toThrow(ConditionalRegistrationError);
    });

    it('reads the default export, and the name it stands for', () =>
    {
        const conditional = 'export default defineRouter({ ...(flags.beta ? { betaRoute } : {}) });';
        expect(() => scan(conditional, 'default')).toThrow(ConditionalRegistrationError);

        const indirect = `
            const appRouter = defineRouter({ ...(flags.beta ? { betaRoute } : {}) });

            export default appRouter;
        `;
        expect(() => scan(indirect, 'default')).toThrow(ConditionalRegistrationError);
    });

    it('reads a router exported under another name', () =>
    {
        const source = `
            const internal = defineRouter({ ...(flags.beta ? { betaRoute } : {}) });

            export { internal as default };
        `;

        expect(() => scan(source, 'default')).toThrow(ConditionalRegistrationError);
        expect(() => scan(source, 'appRouter')).not.toThrow();
    });

    it('reads through .packages(), .use() and .contractVersion()', () =>
    {
        const source = `
            export const appRouter = defineRouter({ ...(flags.beta ? { betaRoute } : {}) })
                .contractVersion('1.0.0')
                .packages([authRouter])
                .use([logging]);
        `;

        expect(() => scan(source)).toThrow(ConditionalRegistrationError);
    });

    it('does not read a package router mounted by .packages()', () =>
    {
        const source = `
            const opsRouter = defineRouter({ ...(process.env.ENABLE_PURGE ? { purge } : {}) });

            export const appRouter = defineRouter({ getRoot }).packages([opsRouter]);
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('accepts a router the file declares and the mounted one does not reference', () =>
    {
        const source = `
            const unused = defineRouter({ ...(flags.beta ? { betaRoute } : {}) });
            const users = defineRouter({ listUsers });

            export const appRouter = defineRouter({ users });
        `;

        expect(() => scan(source)).not.toThrow();
    });
});

describe('what the guard allows because loading yields it', () =>
{
    it('accepts a static helper spread, as @spfn/mcp writes its router', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                mcpPost,
                mcpGet,
                mcpDelete,
                ...metadataRoutes(config, resource),
            });
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('accepts a spread of a member chain and of a call on one', () =>
    {
        expect(() => scan('const appRouter = defineRouter({ ...routes.admin.all });')).not.toThrow();
        expect(() => scan('const appRouter = defineRouter({ ...routes.admin.all() });')).not.toThrow();
    });

    it('accepts a condition hoisted out of the spread, which NODE_ENV pinning is the defence for', () =>
    {
        const source = `
            const extra = process.env.ENABLE_ADMIN ? { admin } : {};

            export const appRouter = defineRouter({ getRoot, ...extra });
        `;

        expect(() => scan(source)).not.toThrow();
    });
});

describe('the guard reads code, not prose', () =>
{
    it('accepts a JSDoc that spells a conditional defineRouter in an example', () =>
    {
        const source = `
            /**
             * The app router.
             *
             * @example
             * \`\`\`ts
             * export const appRouter = defineRouter({ ... });
             * defineRouter({ ...(flags.beta ? { betaRoute } : {}) });
             * \`\`\`
             */
            export const appRouter = defineRouter({ getRoot });
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('accepts a line comment holding a conditional spread', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                getRoot,
                // ...(process.env.ENABLE_ADMIN ? { admin } : {}),
            });
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('accepts a block comment inside the router, which the brace matcher used to run past', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                /* admin is registered by the ops surface: { ...(flag ? { a } : {}) } */
                getRoot,
            });
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('is not confused by a brace or a quote inside a string', () =>
    {
        const source = `
            const label = '} defineRouter({ ...(flags.beta ? { betaRoute } : {}) })';

            export const appRouter = defineRouter({ getRoot });
        `;

        expect(() => scan(source)).not.toThrow();
    });

    it('still refuses the conditional when a comment sits beside it', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                getRoot, // the root
                /* behind a flag */ ...(flags.beta ? { betaRoute } : {}),
            });
        `;

        expect(() => scan(source)).toThrow(ConditionalRegistrationError);
    });

    it('refuses a conditional written across several lines, on one line in the message', () =>
    {
        const source = `
            export const appRouter = defineRouter({
                ...(flags.beta
                    ? { betaRoute }
                    : {}),
            });
        `;

        expect(() => scan(source)).toThrow(/flags\.beta \? \{ betaRoute \} : \{\}/);
    });

    it('reads a router written with a type assertion', () =>
    {
        const source = 'const appRouter = defineRouter({ ...(flags.beta ? { betaRoute } : {}) } as any);';

        expect(() => scan(source)).toThrow(ConditionalRegistrationError);
    });
});
