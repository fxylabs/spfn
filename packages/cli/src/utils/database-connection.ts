/**
 * Which database connection each CLI command uses, and why
 *
 * Two roles may share a database: the owner (`DATABASE_OWNER_URL`), which
 * creates and owns every table, and the app (`DATABASE_URL`, and
 * `DATABASE_READ_URL` for reads), which owns none, so row-level security
 * applies to it. Without `DATABASE_OWNER_URL` both are `DATABASE_URL`: one role.
 *
 * A command that changes the schema or the migration bookkeeping connects as
 * the owner; a command that checks what the app itself can see connects as the
 * app. Each CLI command that opens a connection, or writes a drizzle config,
 * loads the `.env` files through `loadEnvFor` and reads its URL through
 * `databaseUrlFor`, both keyed by its entry below; one that runs the app
 * without loading them (`spfn dev`, `start`, `provision`) starts with
 * `enterCommand`. Only the `owner` commands hold `DATABASE_OWNER_URL`: they
 * load it from a file, and every other command removes an inherited one before
 * anything of it runs. Never log a URL: it carries a password.
 *
 * What the table does not decide:
 * - A project's own drizzle.config.ts: `db generate`, `check`, `drop` and
 *   `studio` hand it to drizzle-kit as it is, and drizzle-kit connects with
 *   the URL it names. The table's URL goes only into the config the CLI
 *   writes when the project has none.
 * - `db reindex` reads only the migrations folder from core's drizzle config
 *   and connects to nothing; core still requires `DATABASE_URL` to build it.
 */

import { DATABASE_OWNER_URL, env } from '@spfn/core/config';
import { loadEnv } from '@spfn/core/env/loader';

/** The variables a connection is chosen from: core's `env`, or a child process's environment. */
type DatabaseUrls = Pick<typeof env, 'DATABASE_URL' | 'DATABASE_OWNER_URL' | 'DATABASE_READ_URL'> | NodeJS.ProcessEnv;

const CONNECTIONS = {
    /** `DATABASE_OWNER_URL`, else `DATABASE_URL` */
    owner: (urls: DatabaseUrls) => urls.DATABASE_OWNER_URL ?? urls.DATABASE_URL,
    /** `DATABASE_URL`: the role the server writes as */
    app: (urls: DatabaseUrls) => urls.DATABASE_URL,
    /** `DATABASE_READ_URL`, else `DATABASE_URL`: the role the server reads as */
    appRead: (urls: DatabaseUrls) => urls.DATABASE_READ_URL ?? urls.DATABASE_URL,
};

/** Each command's connection and the reason for it. */
export const COMMAND_CONNECTIONS = {
    'db push': {
        connection: 'owner',
        why: 'runs DDL and the function package migrations (bookkeeping included); --dry-run too: drizzle-kit plans from the schemas its role may use, so the plan is the applying role\'s',
    },
    'db migrate': { connection: 'owner', why: 'runs DDL and writes the migration bookkeeping' },
    'add': { connection: 'owner', why: 'applies the package\'s migrations: DDL and the migration bookkeeping' },
    'db backup': { connection: 'owner', why: 'pg_dump stops on a table whose row-level security policy applies to its role' },
    'db restore': { connection: 'owner', why: 'COPY FROM is refused into a table whose policy applies to its role' },
    'db drop': { connection: 'owner', why: 'only the owner may drop the tables' },
    'db tenant import': { connection: 'owner', why: 'writes every tenant\'s rows past the policy, checking the tenant column itself, and moves sequences' },
    'db status': { connection: 'app', why: 'reports the migrations the running app sees, with the app\'s privileges' },
    'db generate': { connection: 'app', why: 'drizzle-kit connects to nothing; the config it reads needs a URL, and the app\'s keeps the owner\'s out of the file' },
    'db check': { connection: 'app', why: 'as db generate: drizzle-kit only reads the migration files' },
    'pre-start check': { connection: 'app', why: '`spfn dev`/`start` check what the server they spawn will see' },
    'spfn dev': { connection: 'app', why: 'runs the app — its server, Next.js, the codegen watcher — and the pre-start check' },
    'spfn start': { connection: 'app', why: 'runs the built app and the pre-start check' },
    'spfn provision': { connection: 'app', why: 'its runner runs the app\'s provisioning hooks through core, which connects as the server does (`DATABASE_URL`, mapped from `POSTGRES_URL` when unset)' },
    'db studio': { connection: 'app', why: 'an interactive data tool stays under row-level security' },
    'db tenant export': { connection: 'appRead', why: 'reads one tenant\'s rows under its policy, as the app reads' },
} as const satisfies Record<string, { connection: keyof typeof CONNECTIONS; why: string }>;

export type DatabaseCommand = keyof typeof COMMAND_CONNECTIONS;

/**
 * Start `command` holding `DATABASE_OWNER_URL` only if it connects as the
 * owner: any other command removes an inherited one — a shell's export — from
 * `process.env` before anything of it runs, so neither its own code nor what it
 * loads (server.config, a pre-start check) can read it. Silently: exporting the
 * variable is the documented way to hand it to the owner commands, so its
 * presence in an app command's environment is no mistake to report. The server
 * warns because nothing should start it with the variable; the CLI drops what
 * the person deliberately gave every command in that shell.
 */
export function enterCommand(command: DatabaseCommand): void
{
    if (COMMAND_CONNECTIONS[command].connection !== 'owner')
    {
        delete process.env[DATABASE_OWNER_URL];
    }
}

/**
 * Start `command` (`enterCommand`) and load the `.env` files for it. A command
 * whose connection is `owner` loads `DATABASE_OWNER_URL` from them too; any
 * other leaves it out, as the server does, so `db status` never holds it,
 * inherited or from a file.
 */
export function loadEnvFor(command: DatabaseCommand): void
{
    enterCommand(command);
    loadEnv({ ownerCredentials: COMMAND_CONNECTIONS[command].connection === 'owner' });
}

/**
 * The URL `command` connects with, from core's `env` or from `urls` (the
 * environment a child process is handed). Undefined when its variables are
 * unset.
 */
export function databaseUrlFor(command: DatabaseCommand, urls: DatabaseUrls = env): string | undefined
{
    return CONNECTIONS[COMMAND_CONNECTIONS[command].connection](urls);
}

/**
 * Remove the owner's credentials from each environment a child of `spfn dev`
 * or `spfn provision` is handed. This process no longer holds them
 * (`enterCommand`); what this removes is what the command adds for a child — a
 * keychain reference in `.env.server` resolved for it. The app connects as the
 * app role only: holding `DATABASE_OWNER_URL` would hand it credentials that
 * row-level security does not apply to.
 */
export function dropOwnerCredentials(...environments: NodeJS.ProcessEnv[]): void
{
    for (const environment of environments)
    {
        delete environment[DATABASE_OWNER_URL];
    }
}
