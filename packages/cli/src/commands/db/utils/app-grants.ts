/**
 * The app privileges step: grant the app role exactly what is declared
 *
 * Runs as the owner at the end of `db push`, `db migrate` and `spfn add`, and
 * alone as `spfn db grant`. What it brings the roles to, and why it reads the
 * catalog rather than relying on `ALTER DEFAULT PRIVILEGES`, is `@spfn/core/db`'s
 * (`planAppPrivileges`, `applyAppPrivileges`); this module decides who the
 * roles are, where the declarations come from, and what is printed.
 *
 * - **Who.** Each app URL the command holds (`DATABASE_WRITE_URL`, else
 *   `DATABASE_URL`, and `DATABASE_READ_URL`) is asked `SELECT current_user`,
 *   so a pooler's `role.tenant` user name cannot mislead it. `DATABASE_APP_ROLE`
 *   names the app role only when no app URL is set; set beside one, it must
 *   name the same role. With neither, one warning and nothing is granted.
 * - **What.** Each function package's manifest (`privileges.json`), and the
 *   project's declaration: `db push` reads the `appPrivileges` markers of the
 *   entities it loads; `db migrate` and `spfn add`, which load no app source,
 *   the project's manifest only; `db grant` and `db status` the manifest when
 *   the project has one, else the entities as push loads them, and refuse
 *   when neither can be read — never "nothing to change":
 *
 *   | command | manifest | no manifest, entities load | neither |
 *   |---|---|---|---|
 *   | `db push` | entities | entities | no entity file: nothing is pushed or granted |
 *   | `db grant` | manifest | entities | exit 1, "the project's tables cannot be seen" |
 *   | `db status` | manifest | entities | `privileges` unknown (`checked: false`), `--json` too |
 *   | `db migrate`, `spfn add` | manifest | one warning; no project schema | the same |
 * - **Nothing to grant** without `DATABASE_OWNER_URL`, or when the app role is
 *   the owner or inherits it: one note, since row-level security does not
 *   apply to that app either.
 *
 * A failure is thrown — a database error, or `AppGrantRefusal` for a table or
 * schema the owner cannot grant on, for roles that disagree and for a REVOKE PostgreSQL
 * refuses because grants depend on it (2BP01), after which nothing is changed —
 * for the command to end through its own failure path. No URL is ever printed.
 */

import chalk from 'chalk';
import { env } from '@spfn/core/config';
import {
    APP_PRIVILEGES_MANIFEST_FILE,
    DEFAULT_APP_PRIVILEGES,
    applyAppPrivileges,
    declaredAppPrivileges,
    packageNameToSchema,
    planAppPrivileges,
    projectMigrationsDir,
    readMigrationsAppPrivileges,
    readPrivilegeCatalog,
    type AppPrivilegesRun,
    type AppPrivilegesTarget,
    type AppTablePrivileges,
    type FunctionMigrationInfo,
    type GrantByOther,
    type MigrationsAppPrivileges,
    type RefusedRevoke,
} from '@spfn/core/db';
import { existsSync } from 'fs';
import { join, relative } from 'path';

import { describeFailure } from '../../../utils/database-failure.js';
import {
    createPushConnection,
    loadProjectEntities,
    resolveProjectSchemaFiles,
    resolvePushSchemaFilter,
    resolvePushSchemaSource,
    type PushConnection,
} from './drizzle.js';

/** A failure of the step that is no database error: printed through the command's failure path. */
export class AppGrantRefusal extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'AppGrantRefusal';
    }
}

/** A role the step grants to, and how it was found. */
export interface ResolvedRole
{
    name: string;
    /** `current_user of DATABASE_URL`, or `DATABASE_APP_ROLE` */
    source: string;
}

export interface GrantRoles
{
    app: ResolvedRole;
    /** The read role, when `DATABASE_READ_URL` connects as another role than the app's */
    read?: ResolvedRole;
}

/** The variables the roles are found from. */
export type GrantSettings = Partial<Record<'DATABASE_WRITE_URL' | 'DATABASE_URL' | 'DATABASE_READ_URL' | 'DATABASE_APP_ROLE', string>>;

/**
 * The app and read roles: `current_user` of each app URL set, else
 * `DATABASE_APP_ROLE` for the app; undefined when neither names the app role.
 *
 * @throws AppGrantRefusal when `DATABASE_APP_ROLE` names another role than the app URL connects as
 */
export async function resolveGrantRoles(settings: GrantSettings, currentUser: (url: string) => Promise<string>): Promise<GrantRoles | undefined>
{
    const writeVariable = settings.DATABASE_WRITE_URL ? 'DATABASE_WRITE_URL' : settings.DATABASE_URL ? 'DATABASE_URL' : undefined;
    const setting = settings.DATABASE_APP_ROLE || undefined;
    const app = writeVariable
        ? { name: await currentUser(settings[writeVariable]!), source: `current_user of ${writeVariable}` }
        : setting && { name: setting, source: 'DATABASE_APP_ROLE' };

    if (!app)
    {
        return undefined;
    }

    if (setting && setting !== app.name)
    {
        throw new AppGrantRefusal(`DATABASE_APP_ROLE names the role ${setting}, but ${writeVariable} connects as ${app.name}: `
            + 'the app role is the one its URL connects as — correct or remove DATABASE_APP_ROLE, then run spfn db grant');
    }

    const read = settings.DATABASE_READ_URL
        ? { name: await currentUser(settings.DATABASE_READ_URL), source: 'current_user of DATABASE_READ_URL' }
        : undefined;

    return { app, ...(read && read.name !== app.name ? { read } : {}) };
}

/** `SELECT current_user` on one short connection with `url`. */
export async function currentUserOf(url: string): Promise<string>
{
    const connection = await createPushConnection(url);

    try
    {
        const [row] = await connection.query('SELECT current_user::text AS role');

        return String(row.role);
    }
    finally
    {
        await connection.close();
    }
}

/**
 * The roles to grant to, or undefined — after printing why — when there is
 * nothing to grant: no `DATABASE_OWNER_URL` (one role owns the tables), or no
 * way to name the app role. Called before the owner's connection is needed.
 *
 * @throws AppGrantRefusal when the setting and the app URL disagree; a database error when an app URL cannot be asked
 */
export async function appGrantRoles(): Promise<GrantRoles | undefined>
{
    if (!env.DATABASE_OWNER_URL)
    {
        console.log(chalk.dim('🔐 App privileges: DATABASE_OWNER_URL is not set, so the app connects as the role that owns the tables — '
            + 'nothing to grant, and row-level security does not apply to the app.'));

        return undefined;
    }

    const roles = await resolveGrantRoles(env, currentUserOf);

    if (!roles)
    {
        console.log(chalk.yellow('⚠️  App privileges not applied: no app URL (DATABASE_WRITE_URL, DATABASE_URL, DATABASE_READ_URL) and no '
            + 'DATABASE_APP_ROLE name the app role. Set DATABASE_APP_ROLE, then run spfn db grant.'));
    }

    return roles;
}

/** How the step runs beside its command. */
export interface GrantStepOptions
{
    /** Run the statements in a transaction that always rolls back, and print what it found */
    dryRun?: boolean;
    /**
     * The schema changes the step follows are not applied (push's dry run, on
     * a read-only connection): the statements are planned on the database as
     * it is and not run, and absent declared tables are counted as new.
     */
    schemaPending?: boolean;
}

/**
 * Bring `roles` to `target` on the owner's connection `db`, printing the roles
 * and the statements. With `dryRun` the statements run in a transaction that
 * rolls back, so a statement PostgreSQL refuses is reported and nothing is
 * changed; with `schemaPending` they are only planned.
 *
 * @throws AppGrantRefusal when the plan is blocked or PostgreSQL refused a statement (not on a dry run); a database error
 */
export async function grantAppPrivileges(db: PushConnection['db'], target: AppPrivilegesTarget, roles: GrantRoles, options: GrantStepOptions = {}): Promise<void>
{
    const names = { app: roles.app.name, read: roles.read?.name };

    printRoles(roles);

    const run: AppPrivilegesRun = options.schemaPending
        ? { plan: planAppPrivileges(await readPrivilegeCatalog(db, target.schemas, names), target, names), applied: false }
        : await applyAppPrivileges(db, target, names, { rollback: options.dryRun });

    printRun(run, roles, options);

    if (!options.dryRun && !run.applied)
    {
        throw new AppGrantRefusal(notAppliedReason(run, roles));
    }
}

/** `appGrantRoles`, then `grantAppPrivileges` on `db` when there is a role to grant to. */
export async function runAppGrantStep(db: PushConnection['db'], target: AppPrivilegesTarget, options: GrantStepOptions = {}): Promise<void>
{
    const roles = await appGrantRoles();

    if (roles)
    {
        await grantAppPrivileges(db, target, roles, options);
    }
}

/**
 * The step on a connection of its own to `databaseUrl`, the owner's — `db
 * migrate`, `spfn add`, `db grant`. Opened only when there is a role to grant
 * to. A dry run needs it writable too: its statements run, and roll back.
 *
 * @throws as `grantAppPrivileges`
 */
export async function runAppGrantStepOn(databaseUrl: string, target: AppPrivilegesTarget, options: { dryRun?: boolean } = {}): Promise<void>
{
    const roles = await appGrantRoles();

    if (!roles)
    {
        return;
    }

    const connection = await createPushConnection(databaseUrl);

    try
    {
        await grantAppPrivileges(connection.db, target, roles, options);
    }
    finally
    {
        await connection.close();
    }
}

/**
 * What a command whose schema changes committed says when its privileges step
 * failed: the step runs in one transaction, so it changed nothing. A new table
 * has what the database gives one — the default privileges of its creator, if
 * any were set, and nothing for the app otherwise — not its declaration.
 */
export const SCHEMA_APPLIED_PRIVILEGES_UNCHANGED = 'Schema applied; no privilege was changed, so new tables have only what the database gives by default';

/**
 * The line after a failed step's error: a refusal ends with its own way out
 * and `spfn db grant`; a database error says neither.
 */
export function grantRetryNote(error: unknown): string | undefined
{
    return error instanceof AppGrantRefusal ? undefined : '   Once that is resolved, run spfn db grant.';
}

/**
 * End a command whose privileges step failed: exit 1, `headline`, the error
 * as `describeFailure` prints it — never a URL or a bound value — and, for a
 * database error, `spfn db grant`.
 */
export function exitOnGrantFailure(error: unknown, databaseUrl: string, headline = SCHEMA_APPLIED_PRIVILEGES_UNCHANGED): never
{
    const note = grantRetryNote(error);

    console.error(chalk.red(`\n❌ ${headline}: ${describeFailure(error, databaseUrl)}`));
    if (note)
    {
        console.error(chalk.yellow(note));
    }
    process.exit(1);
}

function printRoles(roles: GrantRoles): void
{
    console.log(chalk.blue('\n🔐 App privileges'));
    console.log(chalk.dim(`   app role: ${roles.app.name} (${roles.app.source})`));

    if (roles.read)
    {
        console.log(chalk.dim(`   read role: ${roles.read.name} (${roles.read.source}) — USAGE and SELECT only`));
    }
}

/**
 * The statements, then what the plan reports; a summary line for a run that
 * applied it. An app role that is the owner, or inherits it, gets its note alone.
 */
function printRun(run: AppPrivilegesRun, roles: GrantRoles, options: GrantStepOptions): void
{
    const { plan } = run;
    const app = roles.app.name;

    for (const role of plan.ownerRoles)
    {
        console.log(chalk.dim(`   ${role} is the owner or inherits its privileges — nothing to grant ${role === app ? '' : 'to it '}`
            + 'and row-level security does not apply to it.'));
    }

    if (plan.ownerRoles.includes(app))
    {
        return;
    }

    printOwnedRelations(plan);
    printOwnedSchemas(plan);

    if (options.dryRun || run.applied)
    {
        plan.statements.forEach(statement => console.log(chalk.cyan(`   ${statement};`)));
    }
    printReports(run, roles, options);

    if (run.applied)
    {
        console.log(plan.statements.length === 0
            ? chalk.green('   ✅ The app role\'s privileges match the declarations — nothing to change')
            : chalk.green(`   ✅ ${plan.statements.length} privilege statement(s) applied`));
    }
}

/**
 * Each role's relations it owns, or whose owner it inherits, that the owner
 * may grant on (a superuser's run): nothing is planned there, for any grantee.
 */
function printOwnedRelations(plan: AppPrivilegesRun['plan']): void
{
    for (const role of new Set(plan.ownedRelations.map(relation => relation.role)))
    {
        const relations = plan.ownedRelations.filter(relation => relation.role === role).map(relation => `${relation.schema}.${relation.name}`);

        console.log(chalk.dim(`   ${role} owns ${relations.join(', ')}, or inherits their owner — nothing is granted or revoked there, to any role or PUBLIC: `
            + 'their declarations are not enforced, and row-level security does not apply to it.'));
    }
}

/**
 * Each role's managed schemas it owns, or whose owner it inherits: nothing is
 * planned there for it; another planned role and PUBLIC are planned as anywhere.
 */
function printOwnedSchemas(plan: AppPrivilegesRun['plan']): void
{
    for (const role of new Set(plan.ownedSchemas.map(entry => entry.role)))
    {
        const schemas = plan.ownedSchemas.filter(entry => entry.role === role).map(entry => entry.schema);

        console.log(chalk.dim(`   ${role} owns schema ${schemas.join(', ')}, or inherits their owner — nothing is granted or revoked there to it: `
            + 'it can create — and so own — tables there, whose declarations are not enforced.'));
    }
}

/** What the plan reports and does not change: privileges held another way, absent tables, PUBLIC CREATE; on a dry run, what stops it. */
function printReports(run: AppPrivilegesRun, roles: GrantRoles, options: GrantStepOptions): void
{
    const { plan } = run;

    for (const held of plan.heldElsewhere)
    {
        console.log(chalk.yellow(`   ⚠️  ${held.role} holds ${held.privilege.toUpperCase()} on ${held.schema}.${held.name} beyond its declaration, ${held.through} — `
            + 'not revoked: the step changes no other role'));
    }

    for (const held of plan.schemaHeldElsewhere)
    {
        console.log(chalk.yellow(`   ⚠️  ${held.role} holds ${held.privilege.toUpperCase()} on schema ${held.schema} beyond USAGE, ${held.through} — `
            + 'not revoked: the step changes no other role'));
    }

    if (options.dryRun && plan.absentTables.length > 0)
    {
        console.log(chalk.dim(options.schemaPending
            ? `   + privileges for ${plan.absentTables.length} new table(s)`
            : `   ${plan.absentTables.length} declared table(s) do not exist, ignored: ${plan.absentTables.map(entry => `${entry.schema}.${entry.table}`).join(', ')}`));
    }

    if (plan.publicMayCreateInPublic)
    {
        console.log(chalk.yellow('   ⚠️  PUBLIC may CREATE in schema public (PostgreSQL before 15): any role, the app\'s too, can create — and so own — '
            + 'tables there. Not revoked; as the database owner: REVOKE CREATE ON SCHEMA public FROM PUBLIC;'));
    }

    if (options.dryRun && (plan.blocked || run.refused))
    {
        console.log(chalk.red(`   ❌ ${notAppliedReason(run, roles)}`));
    }
}

/**
 * Why a run applied nothing: each role name that is no role, each relation
 * the owner cannot grant on, each schema it cannot open, each grant to PUBLIC
 * another role made — or the statement PostgreSQL refused.
 */
function notAppliedReason(run: AppPrivilegesRun, roles: GrantRoles): string
{
    const { plan } = run;

    return [missingRolesReason(plan, roles), ownershipReason(plan), publicGrantsReason(plan), run.refused && refusalReason(run.refused)]
        .filter(Boolean).join('\n   ');
}

/** Each role name that is no role, with the setting that names it: a misconfiguration, never a skipped step. */
function missingRolesReason(plan: AppPrivilegesRun['plan'], roles: GrantRoles): string
{
    const named = [roles.app, ...(roles.read ? [roles.read] : [])];

    return plan.missingRoles
        .map(name => `${named.find(role => role.name === name)?.source ?? 'The configuration'} names the role ${name}, which does not exist in this database: `
            + 'correct the setting, then run spfn db grant.')
        .join('\n   ');
}

function ownershipReason(plan: AppPrivilegesRun['plan']): string
{
    const relations = plan.foreignOwned.map(relation => `${relation.kind} ${relation.schema}.${relation.name} (owner ${relation.owner})`);
    const schemas = [
        ...plan.ungrantableSchemas.map(entry => `schema ${entry.schema}, which ${entry.role} may not use`),
        ...plan.foreignOwnedSchemas.map(entry => `schema ${entry.schema} (owner ${entry.owner}), where a role holds more than USAGE`),
    ];

    return relations.length + schemas.length === 0 ? '' : `The owner cannot grant on ${[...relations, ...schemas].join(', ')}. `
        + 'Move them to the owner (REASSIGN OWNED, or ALTER … OWNER TO — the @spfn/core db README, "Database roles"), then run spfn db grant.';
}

/** Each grant to PUBLIC the owner's REVOKE would leave in place, with the statement to run as its grantor. */
function publicGrantsReason(plan: AppPrivilegesRun['plan']): string
{
    const grants = plan.publicGrantsByOthers.map(grant => `${grant.privilege.replace(/^\w+/, word => word.toUpperCase())} on ${grant.schema}.${grant.name} `
        + `to PUBLIC, granted by ${grant.grantor} — as ${grant.grantor}: ${grant.statement};`);

    return grants.length === 0 ? '' : 'These grants to PUBLIC were made by another role than the owner, so only their grantor can revoke them:'
        + `\n     ${grants.join('\n     ')}\n   Run those, then spfn db grant.`;
}

/**
 * The statement PostgreSQL refused (2BP01), the grants on its relation that
 * other roles made of what it revokes — among which are those depending on
 * it — and the two ways out. It claims no more than the catalog shows.
 */
function refusalReason(refused: RefusedRevoke): string
{
    const grants = refused.grantsByOthers;
    const listing = grants === undefined ? '' : `\n   The grants on ${grantsObject(grants)} of what it revokes that roles other than its owner made, `
        + `with a grant option they held; the ones that depend on what it removes are among them:\n     ${grants.grants.map(grantLine).join('\n     ')}`;

    return `PostgreSQL refused ${refused.statement}: other grants depend on the grant option it takes (2BP01).${listing}\n   `
        + 'Either their grantors revoke them, or the owner runs the refused statement with CASCADE, which removes the grants that depend on it '
        + '(the step never cascades: that decision is yours). Then run spfn db grant; it reports the next statement PostgreSQL refuses, if any, the same way.';
}

/** `schema.relation`, or `schema <name>` for a REVOKE on the schema itself. */
function grantsObject(grants: NonNullable<RefusedRevoke['grantsByOthers']>): string
{
    return grants.name === undefined ? `schema ${grants.schema}` : `${grants.schema}.${grants.name}`;
}

/** `grantor → grantee: PRIVILEGE (column)`, and whether it was given with its grant option. */
function grantLine(grant: GrantByOther): string
{
    const column = grant.column === undefined ? '' : ` (${grant.column})`;

    return `${grant.grantor} → ${grant.grantee ?? 'PUBLIC'}: ${grant.privilege.toUpperCase()}${column}${grant.grantable ? ' WITH GRANT OPTION' : ''}`;
}

/**
 * The target of `db push`: the managed schemas, the declarations of the
 * entities it loads (`imports`), and each function package's manifest.
 *
 * @throws AppPrivilegesManifestError when a package's manifest cannot be read
 */
export function entityGrantTarget(schemas: string[], imports: Record<string, unknown>, functions: FunctionMigrationInfo[]): AppPrivilegesTarget
{
    return {
        schemas,
        tables: [...declaredAppPrivileges(Object.values(imports)), ...functions.flatMap(info => manifestTables(readMigrationsAppPrivileges(info.migrationsDir)))],
        defaults: DEFAULT_APP_PRIVILEGES,
    };
}

/** The project's part of a target: its schemas, and the declarations of their tables. */
interface ProjectDeclaration
{
    schemas: string[];
    tables: AppTablePrivileges[];
}

/**
 * The target of `db migrate` and `spfn add`, from manifests only: the
 * project's (`src/server/drizzle/privileges.json`), each function package's,
 * and `drizzle`. Neither may load app source, so a project without a manifest
 * manages no project schema here: which schemas are the project's is the
 * manifest's to say (`manifestGrantTargetOrExit` warns).
 *
 * @throws AppPrivilegesManifestError when a manifest cannot be read
 */
export function manifestGrantTarget(functions: FunctionMigrationInfo[], cwd: string = process.cwd()): AppPrivilegesTarget
{
    return grantTarget(manifestDeclaration(cwd) ?? { schemas: [], tables: [] }, functions);
}

/** The target of `db grant` and `db status`, and which of the project's declarations it was read from. */
export interface ProjectGrantTarget
{
    target: AppPrivilegesTarget;
    /** `manifest src/server/drizzle/privileges.json`, or `entities` */
    source: string;
}

/**
 * The target of `db grant` and `db status`: the project's declaration from
 * its manifest when it has one, else from its entities, loaded as `db push`
 * loads them — so a project that only pushes is granted what push grants —
 * then each function package's manifest, and `drizzle`. Which one it read is
 * `source`, for the command to say: a manifest left behind decides over the
 * entities, and the two are never compared.
 *
 * @throws AppGrantRefusal when the project has no manifest and its entities cannot be loaded: its tables cannot be seen;
 * AppPrivilegesManifestError when a manifest cannot be read
 */
export async function projectGrantTarget(functions: FunctionMigrationInfo[], databaseUrl: string, cwd: string = process.cwd()): Promise<ProjectGrantTarget>
{
    const manifest = manifestDeclaration(cwd);

    return {
        target: grantTarget(manifest ?? await entityDeclaration(databaseUrl, cwd), functions),
        source: manifest ? `manifest ${relative(cwd, join(projectMigrationsDir(cwd), APP_PRIVILEGES_MANIFEST_FILE))}` : 'entities',
    };
}

/** `project`, each function package's schema and manifest, and `drizzle`. */
function grantTarget(project: ProjectDeclaration, functions: FunctionMigrationInfo[]): AppPrivilegesTarget
{
    const packages = functions.map(info => ({ schema: packageNameToSchema(info.packageName), tables: manifestTables(readMigrationsAppPrivileges(info.migrationsDir)) }));
    const tables = [...project.tables, ...packages.flatMap(entry => entry.tables)];
    const schemas = [...project.schemas, ...tables.map(entry => entry.schema), ...packages.map(entry => entry.schema), 'drizzle'];

    return { schemas: [...new Set(schemas)], tables, defaults: DEFAULT_APP_PRIVILEGES };
}

/** The project's manifest, its schemas those of the tables it lists; undefined without one. */
function manifestDeclaration(cwd: string): ProjectDeclaration | undefined
{
    const projectDir = projectMigrationsDir(cwd);
    const declared = existsSync(projectDir) ? readMigrationsAppPrivileges(projectDir) : undefined;

    if (declared === undefined || declared.kind === 'none')
    {
        return undefined;
    }

    const tables = manifestTables(declared);

    return { schemas: tables.map(entry => entry.schema), tables };
}

/**
 * The project's entities, as `db push` loads them: its schemas push's
 * (`resolvePushSchemaFilter`), its tables' declarations their markers.
 *
 * @throws AppGrantRefusal when no entity file is found or one cannot be loaded
 */
async function entityDeclaration(databaseUrl: string, cwd: string): Promise<ProjectDeclaration>
{
    const loaded = await loadEntityDeclaration(databaseUrl, cwd)
        .catch((error: unknown) => `its entities could not be loaded (${error instanceof Error ? error.message : String(error)})`);

    if (typeof loaded === 'string')
    {
        throw new AppGrantRefusal(`The project's tables cannot be seen: src/server/drizzle has no privileges.json, and ${loaded}. `
            + 'Run spfn db generate to write the manifest, or run this where the entities load.');
    }

    return loaded;
}

/** `entityDeclaration`'s load; why not, as text, when the source names no entity file. */
async function loadEntityDeclaration(databaseUrl: string, cwd: string): Promise<ProjectDeclaration | string>
{
    const source = await resolvePushSchemaSource(undefined, cwd);
    const resolved = await resolveProjectSchemaFiles(databaseUrl, source, cwd);

    if (resolved.files.length === 0)
    {
        return `no entity file was found (${source?.label ?? resolved.source})`;
    }

    const imports = await loadProjectEntities(resolved, cwd);

    return { schemas: resolvePushSchemaFilter(source?.schemaFilter, imports, cwd), tables: declaredAppPrivileges(Object.values(imports)) };
}

/**
 * `projectGrantTarget`, ending the command when the project's tables cannot
 * be seen or a manifest cannot be read — never "nothing to change".
 */
export async function projectGrantTargetOrExit(functions: FunctionMigrationInfo[], databaseUrl: string): Promise<ProjectGrantTarget>
{
    return projectGrantTarget(functions, databaseUrl).catch((error: unknown) =>
    {
        const headline = error instanceof AppGrantRefusal ? 'Privileges not applied' : 'Invalid app privileges manifest — nothing was applied';

        console.error(chalk.red(`❌ ${headline}: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    });
}

/**
 * `manifestGrantTarget`, ending the command — before anything is applied —
 * when a manifest cannot be read, and saying so when the project's migrations
 * folder has none.
 */
export function manifestGrantTargetOrExit(functions: FunctionMigrationInfo[]): AppPrivilegesTarget
{
    try
    {
        return warnWithoutProjectManifest(manifestGrantTarget(functions));
    }
    catch (error)
    {
        console.error(chalk.red(`❌ Invalid app privileges manifest — nothing was applied: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

/** `target`, after one warning when the project's migrations folder has no manifest to name its schemas. */
function warnWithoutProjectManifest(target: AppPrivilegesTarget, cwd: string = process.cwd()): AppPrivilegesTarget
{
    const projectDir = projectMigrationsDir(cwd);

    if (existsSync(projectDir) && readMigrationsAppPrivileges(projectDir).kind === 'none')
    {
        console.log(chalk.yellow('⚠️  src/server/drizzle has no privileges.json, so the project\'s schemas are unknown: '
            + 'its tables get no grants until spfn db generate writes the manifest.'));
    }

    return target;
}

/** A manifest's tables, each `"default"` resolved to the manifest's own default set; none for a folder without one. */
function manifestTables(declared: MigrationsAppPrivileges): AppTablePrivileges[]
{
    if (declared.kind === 'none')
    {
        return [];
    }

    const { manifest } = declared;

    return manifest.tables.map(entry => ({ ...entry, privileges: entry.privileges === 'default' ? manifest.default : entry.privileges }));
}
