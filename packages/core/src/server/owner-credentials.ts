/**
 * The server process does not keep an inherited `DATABASE_OWNER_URL`
 *
 * The variable is the table owner's — for `spfn db migrate`, `db push` and the
 * other commands that change the schema — and row-level security does not
 * apply to that role. The server connects as the app role only. `loadEnv()`
 * does not load it from the `.env` files unless a schema command asks, so the
 * one way left in is the environment the process was started with: a shell
 * export, a container's environment. Every server entry that runs app code as
 * the app — `startServer`, `createServer`, the serverless app,
 * `provisionInfrastructure` — removes it from `process.env` first, before
 * server.config or anything of the app can read it. Core's `env` reads
 * `process.env` on every access, so nothing keeps a copy.
 */

import { DATABASE_OWNER_URL } from '../config/schema';
import { serverLogger } from './logger';

/**
 * Remove an inherited `DATABASE_OWNER_URL` from `process.env` and log one
 * warning naming the variable, never the value. A no-op when it is not there,
 * so entries that call one another warn once.
 */
export function discardInheritedOwnerCredentials(): void
{
    if (process.env[DATABASE_OWNER_URL] === undefined)
    {
        return;
    }

    delete process.env[DATABASE_OWNER_URL];

    serverLogger.warn(`Environment: ${DATABASE_OWNER_URL} was in the environment the server was started with `
        + '(a shell export, a container\'s environment) and has been removed from it. The server does not use it; '
        + 'give it only to the commands that change the schema (spfn db migrate, db push), not to the server.');
}
