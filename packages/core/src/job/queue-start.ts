/**
 * The boot rule for the pg-boss queue schema (#171)
 *
 * pg-boss's default start (`migrate: true`) creates and migrates its schema as
 * whatever role the app connects as. Under the role split the database owner
 * installs and migrates it (`spfn db migrate`, `spfn db push`) and the app role
 * owns nothing, so the app changes the queue's structure only where PostgreSQL
 * already treats it as the owner — of the schema and of every object in it,
 * since only an object's owner may alter or replace it — or, with nothing
 * installed, lets it create the schema. "Owns" counts a role that inherits the
 * owner. The facts come from the catalog (`readQueueSchemaState`), read as the
 * app role before pg-boss starts:
 *
 * | Queue schema, to the app role | Start | Why |
 * |---|---|---|
 * | at pg-boss's version | `migrate: false` | no structure statement at all |
 * | newer than pg-boss's | `migrate: true`, a warning | pg-boss migrates only up, so it sends none; `migrate: false` refuses any other version |
 * | older than pg-boss migrates from, whoever owns it | refused (`QueueSchemaVersionError`) | an earlier pg-boss release migrates it first |
 * | older, the app owns the schema and every object in it | `migrate: true` | one role, or an app that installed the queue itself |
 * | older, one other role owns all of it | refused | the owner step, as that role, migrates it |
 * | nothing installed, the app may create schemas and no other role owns the schema | `migrate: true` | one role: `spfn dev` with one URL |
 * | nothing installed, no role or one other role owns all of it | refused | the owner step installs it |
 * | pg-boss's, its version unreadable, one other role owns all of it | refused | `spfn db grant`, as that role |
 * | any of those three refusals, ownership split — the app role's and another's, or two others' | refused, no step | the ownership transfer |
 * | not pg-boss's | refused | another schema for the queue |
 *
 * A refusal is a `JobQueueSchemaError` thrown by `initBoss`, before the server
 * listens, naming the schema, the versions and the command to run — and the
 * role it has to connect as, the one that owns the queue. The owner step acts
 * only on a queue whose schema and every object are the owner's: where the
 * app role owns any of it — the schema, an object, or an empty schema it may
 * not install into — or two other roles own parts, that step changes nothing
 * and prints the ownership transfer, so the boot names that transfer, and
 * every role that owns part of the queue, instead of a command (`step` null),
 * from the same source (`queueOwnershipTransfer`).
 *
 * The owner step finds the queue schema in the app's package.json
 * (`readJobsDeclaration`), the server in `.jobs()`: the two are compared here.
 * A declaration that does not name the schema the app runs on — none (no
 * `spfn.jobs`, or no package.json), another one, or one that cannot be read —
 * matters only where the owner step has to act: a refusal says how to declare
 * it, and a start on a queue the app does not own warns. It decides nothing by
 * itself, since a one-role app needs none.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { catalogRows, DEFAULT_QUEUE_SCHEMA, queueOwnershipTransfer, readJobsDeclaration } from '@spfn/core/db';
import { logger } from '@spfn/core/logger';

import {
    JobQueueSchemaError,
    PG_BOSS_RELEASE,
    QUEUE_SCHEMA_VERSION,
    queueMigrationRefusal,
    readQueueSchemaState,
    type QueueSchemaState,
    type QueueSchemaStep,
} from './queue-schema';

const jobLogger = logger.child('@spfn/core:job');

/** Each owner's step's command: for a queue the app does not install or migrate, for one it cannot read. */
const STEP_COMMAND: Record<QueueSchemaStep, string> = {
    owner: 'spfn db migrate (or spfn db push)',
    grant: 'spfn db grant',
};

/**
 * How pg-boss starts on the queue schema: `install` and `migrate` let it
 * change the structure as the app role, `current` and `newer` do not need it
 * to (`newer` starts with a warning); `refused` does not start.
 */
export type QueueStart =
    | { readonly kind: 'install' | 'migrate' | 'current' | 'newer' }
    | { readonly kind: 'refused'; readonly error: JobQueueSchemaError };

/**
 * The boot rule's answer for the queue schema in `state`, read as `role`.
 * `declared` is whether the app's package.json declares that schema; a
 * refusal then omits how to declare it.
 */
export function queueStart(state: QueueSchemaState, role: string, declared: boolean): QueueStart
{
    const refuse: Refuse = (installed, step, message) =>
    {
        const resolution = step === null ? { step, text: message } : ownerResolution(state, role, step, message);

        return {
            kind: 'refused',
            error: new JobQueueSchemaError(state.schema, installed, resolution.step, declared ? resolution.text : `${resolution.text}${declarationHint(state.schema)}`),
        };
    };

    if (state.notPgBoss)
    {
        return refuse(undefined, null, `Queue schema ${state.schema} holds objects that are not pg-boss's, so pg-boss is neither installed nor migrated there. `
            + 'Give the queue a schema of its own — .jobs(router, { schema }) and "spfn": { "jobs": { "schema": "<name>" } } in package.json — then start again.');
    }

    if (state.version === undefined)
    {
        return refuse(undefined, 'grant', `Queue schema ${state.schema} is pg-boss's, but role ${role} may not read its version: it needs USAGE on the schema `
            + `and SELECT on ${state.schema}.version.`);
    }

    return state.version === null ? uninstalledStart(state, role, refuse) : installedStart(state, state.version, role, refuse);
}

/** A refusal of the queue schema at `installed`, resolved by `step` (its command follows `message`) or by none. */
type Refuse = (installed: number | null | undefined, step: QueueSchemaStep | null, message: string) => QueueStart;

/**
 * Nothing installed: pg-boss installs it where the app may create schemas —
 * its plan starts with `CREATE SCHEMA IF NOT EXISTS`, which PostgreSQL
 * refuses without CREATE on the database even for a schema that exists —
 * and no other role owns the schema.
 */
function uninstalledStart(state: QueueSchemaState, role: string, refuse: Refuse): QueueStart
{
    if (state.mayCreateOnDatabase && (!state.exists || ownsQueue(state)))
    {
        return { kind: 'install' };
    }

    const why = state.mayCreateOnDatabase ? 'does not own it' : 'may not create schemas in the database';

    return refuse(null, 'owner', `Queue schema ${state.schema} is not installed, and role ${role} ${why}, so the app does not install it.`);
}

/**
 * Installed at `version`: as it is, or migrated where the app owns the queue
 * (`ownsQueue`) — never from below the oldest version pg-boss migrates from,
 * which it would otherwise apply its oldest migration to and stamp current.
 */
function installedStart(state: QueueSchemaState, version: number, role: string, refuse: Refuse): QueueStart
{
    if (version === QUEUE_SCHEMA_VERSION)
    {
        return { kind: 'current' };
    }

    if (version > QUEUE_SCHEMA_VERSION)
    {
        return { kind: 'newer' };
    }

    const unmigratable = queueMigrationRefusal(state.schema, version);

    if (unmigratable !== undefined)
    {
        return { kind: 'refused', error: unmigratable };
    }

    return ownsQueue(state)
        ? { kind: 'migrate' }
        : refuse(version, 'owner', `Queue schema ${state.schema} is at pg-boss schema version ${version}; pg-boss ${PG_BOSS_RELEASE} in this build needs `
            + `${QUEUE_SCHEMA_VERSION}, and role ${role} does not own the schema and every object in it, so the app does not migrate it.`);
}

/**
 * Whether PostgreSQL lets the connected role change the queue's structure:
 * it is, or inherits, the owner of the schema and of every object in it.
 */
export function ownsQueue(state: QueueSchemaState): boolean
{
    return state.ownsSchema && state.ownsObjects;
}

/**
 * The refusal `message` with what resolves it where the owner's `step`
 * would, from who owns the queue — what the app role sees; which role
 * DATABASE_OWNER_URL connects as it cannot know. The owner step acts only on
 * a queue it owns whole, so:
 * - no role owns any of it (no schema): `step`, as whatever role that URL
 *   connects as;
 * - one role, not the app role's, owns the schema and every object: `step`,
 *   connecting as that role or one that inherits it;
 * - the app role owns any of it, or two roles or more other than its own
 *   own parts: no command (`step` null), the ownership transfer.
 */
function ownerResolution(state: QueueSchemaState, role: string, step: QueueSchemaStep, message: string): { step: QueueSchemaStep | null; text: string }
{
    const others = state.owners.filter(owner => !state.ownedBy.includes(owner));

    if (state.ownedBy.length > 0 || others.length > 1)
    {
        return { step: null, text: `${message} ${ownershipRemedy(state, role)}` };
    }

    const command = STEP_COMMAND[step];

    return {
        step,
        text: others.length === 0
            ? `${message} Run ${command} with DATABASE_OWNER_URL set, then start again.`
            : `${message} Run ${command} with DATABASE_OWNER_URL connecting as ${others[0]}, which owns the schema and every object in it, or as a role `
                + `that inherits ${others[0]}, then start again; if that command reports the queue as another role's, its transfer lines say what to move.`,
    };
}

/**
 * Why the owner's step does not act on a queue schema whose ownership is
 * split — the owner step installs, migrates and grants only a queue whose
 * schema and every object are the owner's, and prints this transfer where
 * they are not — naming every role that owns part of it, and the transfer
 * itself, to the role the owner's commands connect as, which the server does
 * not know.
 */
function ownershipRemedy(state: QueueSchemaState, role: string): string
{
    const app = state.ownedBy.length === 0
        ? `none of them role ${role} or a role it inherits`
        : `${state.ownedBy.join(', ')} being role ${role} or a role it inherits`;

    return `Nor do the owner's commands: ${state.owners.join(', ')} own${state.owners.length === 1 ? 's' : ''} the schema or objects in it (${app}), `
        + 'and pg-boss installs and migrates the queue only as the one role that owns the schema and every object in it. Make that the role '
        + `DATABASE_OWNER_URL connects as (<owner> below), then start again:\n${queueOwnershipTransfer(state.owners, '<owner>', state.bootstrapOwned)}`;
}

/** How to declare `schema` for the owner step. */
function declarationHint(schema: string): string
{
    return ` The owner step reads the queue schema from package.json: declare "spfn": { "jobs": { "schema": "${schema}" } } there.`;
}

/** What `initBoss` read and decided on the queue schema, kept for the health payload. */
export interface QueueStartRecord
{
    readonly schema: string;
    /** The installed version as read at boot; null when nothing was installed, absent when not read */
    readonly installed?: number | null;
    readonly required: number;
    readonly start: QueueStart['kind'];
    readonly checkedAt: string;
}

const RECORD_KEY = Symbol.for('spfn:queue-start');

const g = globalThis as Record<symbol, QueueStartRecord | null | undefined>;

/** The queue schema as the last `initBoss` read it; null before one ran. */
export function queueStartAtBoot(): QueueStartRecord | null
{
    return g[RECORD_KEY] ?? null;
}

/**
 * Read the queue schema `schema` as the role `connectionString` connects as,
 * on a connection of its own, compare the app's declaration with it, and
 * decide how pg-boss starts. Logs the decision; a refusal is returned, for
 * the caller to throw.
 *
 * @throws QueueSchemaNameError when `schema` is no queue schema name
 * @throws QueueSchemaChangedError when the schema changes while it is read
 */
export async function decideQueueStart(connectionString: string, schema: string = DEFAULT_QUEUE_SCHEMA, cwd: string = process.cwd()): Promise<QueueStart>
{
    const declared = readDeclaredSchema(cwd);
    const { state, role } = await readStateAs(connectionString, schema);
    const start = queueStart(state, role, declared === schema);

    g[RECORD_KEY] = { schema, installed: state.version, required: QUEUE_SCHEMA_VERSION, start: start.kind, checkedAt: new Date().toISOString() };
    logQueueStart(start, state, role);

    if (declared !== schema && ownerStepActs(start, state))
    {
        warnUndeclared(schema, declared);
    }

    return start;
}

/**
 * Whether the owner step has to install, migrate or grant the queue pg-boss
 * starts on: the app role neither installs it nor owns any of it — where it
 * owns part, the step acts on nothing until that moves. A refusal says how to
 * declare it itself.
 */
function ownerStepActs(start: QueueStart, state: QueueSchemaState): boolean
{
    return start.kind !== 'refused' && start.kind !== 'install' && state.ownedBy.length === 0;
}

/** The queue schema's state and the connected role, on one short-lived connection. */
async function readStateAs(connectionString: string, schema: string): Promise<{ state: QueueSchemaState; role: string }>
{
    const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => undefined });
    const db = drizzle({ client });

    try
    {
        const [current] = catalogRows(await db.execute(sql`SELECT current_user::text AS role`));

        return { state: await readQueueSchemaState(db, schema), role: String(current.role) };
    }
    finally
    {
        await client.end();
    }
}

/** The warning that the app's package.json does not declare `schema`, saying what it declares instead and how to fix it. */
function warnUndeclared(schema: string, declared: string | undefined | Error): void
{
    const found = declared instanceof Error
        ? `package.json's jobs declaration cannot be read (${declared.message})`
        : declared === undefined ? 'package.json declares no jobs' : `package.json declares the queue schema ${declared}`;

    jobLogger.warn(`Queue schema ${schema}: ${found}, so spfn db migrate, push and grant do not install, migrate or grant it as the owner. `
        + `Declare "spfn": { "jobs": { "schema": "${schema}" } } in package.json.`);
}

/** The queue schema the package.json at `cwd` declares, none, or why it cannot be read. */
function readDeclaredSchema(cwd: string): string | undefined | Error
{
    try
    {
        return readJobsDeclaration(cwd)?.schema;
    }
    catch (error)
    {
        return error instanceof Error ? error : new Error(String(error));
    }
}

function logQueueStart(start: QueueStart, state: QueueSchemaState, role: string): void
{
    switch (start.kind)
    {
        case 'refused':
            jobLogger.error(`Refusing to start: ${start.error.message}`);
            break;
        case 'newer':
            jobLogger.warn(`Queue schema ${state.schema} is at pg-boss schema version ${state.version}, newer than the ${QUEUE_SCHEMA_VERSION} `
                + `pg-boss ${PG_BOSS_RELEASE} in this build runs on: starting without migrating it (a rollback, or an older instance in a rolling deploy).`);
            break;
        case 'install':
            jobLogger.info(`Queue schema ${state.schema} is not installed: pg-boss installs it as role ${role}, which then owns it.`);
            break;
        case 'migrate':
            jobLogger.info(`Queue schema ${state.schema} is at pg-boss schema version ${state.version}: pg-boss migrates it to ${QUEUE_SCHEMA_VERSION} as role ${role}, its owner.`);
            break;
        case 'current':
            jobLogger.debug(`Queue schema ${state.schema} is at pg-boss schema version ${QUEUE_SCHEMA_VERSION}: starting pg-boss without migrating it.`);
            break;
    }
}
