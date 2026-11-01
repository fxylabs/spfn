/**
 * Tenancy Boot Check
 *
 * A tenancy table is protected by its row-level security policy only when the
 * role the app connects as is subject to it. PostgreSQL skips the policy for
 * the table's owner (and any role that inherits the owner's privileges), for a
 * superuser and for a BYPASSRLS role — and then every query sees every tenant.
 * Nothing fails, so the gap would go unnoticed; this check names it at boot.
 *
 * It runs only when the app declared tenancy tables and a database was
 * initialized; with no tenancy table it sends no query at all. In production
 * (`NODE_ENV=production`) a finding refuses the boot; elsewhere it is one
 * warning line — local development usually connects as the `postgres`
 * superuser. A check query that fails is one warning line and boot continues:
 * a diagnostic never fails what it inspects.
 *
 * Messages name the role, the tables and the fix, never a connection string.
 */

import { getDatabase, listTenancyTables } from '@spfn/core/db';
import { env } from '@spfn/core/config';

import { serverLogger } from './logger';

/** The README section on the owner and app roles. */
const ROLES_HELP = 'see "Tenancy → Database roles" in the @spfn/core db README';

/** What the check found on one database connection. */
export interface TenancyRoleFinding
{
    readonly role: string;
    readonly superuser: boolean;
    readonly bypassRls: boolean;
    /** Tenancy tables (`schema.table`) the role owns or inherits ownership of. */
    readonly ownedTables: string[];
}

export type TenancyGateResult =
    | { state: 'skipped'; reason: string }
    | { state: 'ok' }
    | { state: 'unprotected'; findings: TenancyRoleFinding[] }
    | { state: 'unavailable'; reason: string };

/** Thrown when the check refuses a production boot. Not an HTTP error. */
export class TenancyRoleError extends Error
{
    readonly findings: TenancyRoleFinding[];

    constructor(message: string, findings: TenancyRoleFinding[])
    {
        super(message);
        this.name = 'TenancyRoleError';
        this.findings = findings;
    }
}

/** A database the check can query: drizzle's `execute`. */
export interface TenancyGateDb
{
    execute(query: string): PromiseLike<unknown>;
}

/**
 * Check the roles the app's write and read connections use against its tenancy
 * tables.
 *
 * @throws TenancyRoleError in production when a role escapes the policy
 */
export async function runTenancyBootGate(databases?: TenancyGateDb[]): Promise<TenancyGateResult>
{
    const tables = listTenancyTables().map((table) => `${table.schema ?? 'public'}.${table.name}`);

    if (tables.length === 0)
    {
        return { state: 'skipped', reason: 'no tenancy tables' };
    }

    const targets = databases ?? appDatabases();

    if (targets.length === 0)
    {
        return { state: 'skipped', reason: 'no database initialized' };
    }

    const inspected = await Promise.all(targets.map((db) => inspectRole(db, tables))).then(
        (findings) => ({ findings }),
        (error: unknown) => ({ error }),
    );

    if ('error' in inspected)
    {
        const reason = inspected.error instanceof Error ? inspected.error.message : String(inspected.error);

        serverLogger.warn(`Could not check the database role against the tenancy tables: ${reason}. Starting anyway.`);

        return { state: 'unavailable', reason };
    }

    return report(distinct(inspected.findings.filter(escapesPolicy)));
}

/** Write and read pools of one role find the same thing; report it once. */
function distinct(findings: TenancyRoleFinding[]): TenancyRoleFinding[]
{
    return [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
}

/** The write database and, when it is a different connection, the read one. */
function appDatabases(): TenancyGateDb[]
{
    const write = existingDatabase('write');
    const read = existingDatabase('read');

    return [write, read].filter((db, index, all): db is TenancyGateDb => db !== undefined && all.indexOf(db) === index);
}

function existingDatabase(type: 'write' | 'read'): TenancyGateDb | undefined
{
    try
    {
        return getDatabase(type) as unknown as TenancyGateDb;
    }
    catch
    {
        return undefined;
    }
}

/**
 * One query: the connected role's attributes and every relation whose owner's
 * privileges it holds — `pg_has_role(owner, 'USAGE')` is what PostgreSQL's own
 * ownership check grants the policy exemption on.
 */
const ROLE_QUERY = `
select r.rolname as role,
       r.rolsuper as superuser,
       r.rolbypassrls as bypass_rls,
       coalesce((
           select json_agg(n.nspname || '.' || c.relname)
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and pg_has_role(c.relowner, 'USAGE')
       ), '[]'::json) as owned
from pg_roles r
where r.rolname = current_user`;

async function inspectRole(db: TenancyGateDb, tables: string[]): Promise<TenancyRoleFinding>
{
    const rows = await db.execute(ROLE_QUERY) as { role: string; superuser: boolean; bypass_rls: boolean; owned: string[] }[];
    const row = rows[0];

    return {
        role: row.role,
        superuser: row.superuser,
        bypassRls: row.bypass_rls,
        ownedTables: tables.filter((table) => row.owned.includes(table)),
    };
}

function escapesPolicy(finding: TenancyRoleFinding): boolean
{
    return finding.superuser || finding.bypassRls || finding.ownedTables.length > 0;
}

function report(findings: TenancyRoleFinding[]): TenancyGateResult
{
    if (findings.length === 0)
    {
        return { state: 'ok' };
    }

    const message = `Tenancy tables are not isolated: ${findings.map(describeFinding).join('; ')}. `
        + `Connect the app as a role that owns no table and is neither superuser nor BYPASSRLS, and run migrations through DATABASE_OWNER_URL — ${ROLES_HELP}.`;

    if (env.NODE_ENV === 'production')
    {
        serverLogger.error(`Refusing to start: ${message}`);

        throw new TenancyRoleError(message, findings);
    }

    serverLogger.warn(message);

    return { state: 'unprotected', findings };
}

function describeFinding(finding: TenancyRoleFinding): string
{
    const reasons = [
        finding.superuser ? 'is a superuser' : undefined,
        finding.bypassRls ? 'has BYPASSRLS' : undefined,
        finding.ownedTables.length > 0 ? `owns ${finding.ownedTables.join(', ')}` : undefined,
    ].filter(Boolean);

    return `the app role "${finding.role}" ${reasons.join(' and ')}, so row-level security does not apply to it`;
}
