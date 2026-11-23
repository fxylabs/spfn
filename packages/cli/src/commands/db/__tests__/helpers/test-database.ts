/**
 * Connection settings for the CLI tests that run against a real PostgreSQL
 *
 * - The owner is TEST_DATABASE_URL — the core package's test database by
 *   default, which is what CI provides.
 * - The app role is TEST_APP_DATABASE_URL, or the owner URL with whichever of
 *   the two non-superuser roles scripts/test-services.sh creates is not the owner.
 * - The tenant import target is TEST_TARGET_DATABASE_URL, else the owner's
 *   database: a test then exports first and recreates its schema before it
 *   imports, so one database serves as both source and target.
 *
 * Each test file works in a schema of its own and drops it when done, beside
 * the core suite on the same cluster.
 */

import postgres from 'postgres';

export const OWNER_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass@localhost:5432/spfn_test';

export const TARGET_URL = process.env.TEST_TARGET_DATABASE_URL || OWNER_URL;

/** The non-superuser roles scripts/test-services.sh creates on every machine. */
const TEST_ROLES = [
    { user: 'testuser', password: 'testpass' },
    { user: 'authtest', password: 'authtest123' },
];

/** The app role's URL on the database of `ownerUrl`: TEST_APP_DATABASE_URL, or the owner URL with the other test role. */
export function appUrl(ownerUrl: string = OWNER_URL): string
{
    if (process.env.TEST_APP_DATABASE_URL)
    {
        return process.env.TEST_APP_DATABASE_URL;
    }

    const url = new URL(ownerUrl);
    const app = TEST_ROLES.find((role) => role.user !== decodeURIComponent(url.username))!;

    url.username = app.user;
    url.password = app.password;

    return url.toString();
}

/**
 * Whether the database answers. Outside CI an unreachable one skips the file's
 * rows; in CI, which runs PostgreSQL, it fails them instead of hiding them.
 */
export async function requireDatabase(sql: postgres.Sql, label: string): Promise<boolean>
{
    const reachable = await sql`select 1`.then(() => true, () => false);

    if (!reachable && runsInCi())
    {
        throw new Error(`${label}: PostgreSQL is not reachable, and CI runs it — failing instead of skipping`);
    }

    if (!reachable)
    {
        console.log(`\n⚠️  PostgreSQL not available - skipping ${label}\n`);
    }

    return reachable;
}

/**
 * Why rows needing both roles cannot run here, or undefined when they can: the
 * owner must answer and the app role connect. Under CI it throws instead, as
 * core's tenancy harness does: CI's PostgreSQL has both roles, so a skip there
 * would mean the rows stopped running.
 */
export async function twoRoleUnavailability(owner: postgres.Sql, app: postgres.Sql): Promise<string | undefined>
{
    const reason = await owner`select 1`.then(
        () => app`select 1`.then(
            () => undefined,
            () => `the app role cannot connect (set TEST_APP_DATABASE_URL, or create ${TEST_ROLES.map((role) => role.user).join('/')})`,
        ),
        () => 'PostgreSQL not available at TEST_DATABASE_URL',
    );

    if (reason !== undefined && runsInCi())
    {
        throw new Error(`${reason}, and CI provides both roles — failing instead of skipping`);
    }

    return reason;
}

/**
 * Why rows needing an owner that cannot act for the role `role` cannot run
 * here, or undefined when they can: the owner (`owner`'s `current_user`) must
 * not hold `role`'s privileges — `pg_has_role(role, 'USAGE')`, the test the
 * ownership checks make, true for a superuser and for a member that inherits
 * `role`. Under CI it throws instead: the roles scripts/test-services.sh
 * creates are plain login roles, neither a superuser nor a member of the
 * other, so the rows must run there.
 */
export async function ownerActsForUnavailability(owner: postgres.Sql, role: string): Promise<string | undefined>
{
    const [{ actsFor }] = await owner`SELECT pg_has_role(${role}::name, 'USAGE') AS "actsFor"`;
    const reason = actsFor
        ? `the owner role holds ${role}'s privileges (a superuser, or a member inheriting it), so no object of ${role}'s is another role's to it`
        : undefined;

    if (reason !== undefined && runsInCi())
    {
        throw new Error(`${reason}, and CI's roles hold none of each other's — failing instead of skipping`);
    }

    return reason;
}

/**
 * `CI` set to anything but nothing, `false` or `0`: the definition core's test
 * helpers use (`src/db/__tests__/helpers/ci.ts`). A truthiness test took
 * `CI=false` for CI and turned a skip into a failure.
 */
function runsInCi(): boolean
{
    const value = process.env.CI?.trim().toLowerCase();

    return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}
