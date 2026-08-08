/**
 * Application Router
 *
 * Adds authentication to the 02 CRUD slice with two wiring calls:
 * - `.packages([authRouter])` mounts the @spfn/auth routes at /_auth/* and exposes
 *   them on the `authApi` client (register / login / session / ...).
 * - `.use([authenticate])` applies auth globally. Routes opt out with `.skip(['auth'])`
 *   (see routes/examples.ts) or `optionalAuth`.
 */

import { defineRouter } from '@spfn/core/route';
import { authRouter, authenticate } from '@spfn/auth/server';
import { getRoot } from './routes/root';
import { getMe } from './routes/me';
import { listExamples, getExample, createExample, updateExample, deleteExample } from './routes/examples';
import { opsRouter } from './routes/ops';

export const appRouter = defineRouter({
    getRoot,
    getMe,
    listExamples,
    getExample,
    createExample,
    updateExample,
    deleteExample,
})
    .packages([authRouter, opsRouter])   // /_auth/* (authApi) + /_ops/* (spfn ops CLI)
    .use([authenticate]);                // global auth; public routes opt out per-route

/**
 * Router type for the typed client.
 *
 * Run `pnpm codegen` to (re)generate src/generated/route-map.ts after changing routes.
 */
export type AppRouter = typeof appRouter;
