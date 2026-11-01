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

    if (!reachable && process.env.CI)
    {
        throw new Error(`${label}: PostgreSQL is not reachable, and CI runs it — failing instead of skipping`);
    }

    if (!reachable)
    {
        console.log(`\n⚠️  PostgreSQL not available - skipping ${label}\n`);
    }

    return reachable;
}
