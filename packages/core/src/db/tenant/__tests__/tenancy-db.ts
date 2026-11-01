/**
 * Database harness for the tenancy tests: an owner and an app connection
 *
 * PostgreSQL skips row-level security for a table's owner and for superusers,
 * so a policy test run as the owner passes whatever the policy says. The
 * harness therefore keeps two roles apart:
 *
 * - the owner — `TEST_DATABASE_URL` — creates the schema from the SQL drizzle-kit
 *   generates, seeds it, and grants the app role row privileges, as
 *   `spfn db migrate` does through `DATABASE_OWNER_URL`;
 * - the app — `TEST_APP_DATABASE_URL`, or else the same host and database with
 *   whichever of the two non-superuser roles scripts/test-services.sh creates
 *   (`testuser`, `authtest`) is not the owner — is what `initDatabase` serves to
 *   the code under test.
 *
 * Every statement each app pool sends, BEGIN and COMMIT included, is recorded,
 * so a test can say which pool ran what.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres';
import { closeDatabase, initDatabase } from '../../manager';
import { TEST_DATABASE_URL } from '../../__tests__/helpers/db-fixture';
import { SEED_ROWS, TENANCY_SCHEMA, TENANCY_TABLES } from './tenancy-fixtures';

/** The non-superuser roles scripts/test-services.sh creates on every machine. */
const TEST_ROLES = [
    { user: 'testuser', password: 'testpass' },
    { user: 'authtest', password: 'authtest123' },
];

/** The SQL drizzle-kit generates to create `imports` on an empty database. */
export async function generatedSql(imports: Record<string, unknown>): Promise<string[]>
{
    return generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(imports));
}

/** The app role's URL: TEST_APP_DATABASE_URL, or the owner URL with the other test role. */
export function appDatabaseUrl(ownerUrl: string = TEST_DATABASE_URL): string
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

export interface TenancyDb
{
    readonly isAvailable: boolean;
    /** The owner connection: DDL, seeding, inspection. RLS does not apply to it. */
    readonly owner: postgres.Sql;
    /** Statements the app's write pool and read pool sent, in order. */
    readonly writeLog: string[];
    readonly readLog: string[];
    readonly appRole: string;
    setup(): Promise<void>;
    seed(): Promise<void>;
    teardown(): Promise<void>;
}

/**
 * Create the harness. `setup` applies the generated schema as the owner and
 * calls `initDatabase` with the app pools: write (two connections, so a
 * `requiresNew` transaction can open beside its outer one) and read (one
 * connection, so concurrent reads share it).
 */
export function createTenancyDb(): TenancyDb
{
    const writeLog: string[] = [];
    const readLog: string[] = [];
    const appUrl = appDatabaseUrl();
    const appRole = decodeURIComponent(new URL(appUrl).username);
    const owner = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    const appWrite = postgres(appUrl, { max: 2, onnotice: () => undefined, debug: (_c, query) => void writeLog.push(query) });
    const appRead = postgres(appUrl, { max: 1, onnotice: () => undefined, debug: (_c, query) => void readLog.push(query) });
    let available = false;

    return {
        get isAvailable()
        {
            return available;
        },
        owner,
        writeLog,
        readLog,
        appRole,

        async setup()
        {
            available = await owner`select 1`.then(() => true, () => false);

            if (!available)
            {
                console.log('\n⚠️  PostgreSQL not available - skipping tenancy integration tests\n');

                return;
            }

            await createSchema(owner, appRole);
            await initDatabase({
                provider: { write: drizzle({ client: appWrite }), read: drizzle({ client: appRead }), kind: 'tenancy-test' },
            });
        },

        async seed()
        {
            for (const statement of SEED_ROWS)
            {
                await owner.unsafe(statement);
            }

            writeLog.length = 0;
            readLog.length = 0;
        },

        async teardown()
        {
            if (available)
            {
                await closeDatabase();
                await owner.unsafe(`DROP SCHEMA IF EXISTS ${TENANCY_SCHEMA} CASCADE`);
            }

            await Promise.all([owner.end(), appWrite.end(), appRead.end()]);
        },
    };
}

async function createSchema(owner: postgres.Sql, appRole: string): Promise<void>
{
    await owner.unsafe(`DROP SCHEMA IF EXISTS ${TENANCY_SCHEMA} CASCADE`);

    for (const statement of await generatedSql(TENANCY_TABLES))
    {
        await owner.unsafe(statement);
    }

    await owner.unsafe(`GRANT USAGE ON SCHEMA ${TENANCY_SCHEMA} TO ${appRole}`);
    await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${TENANCY_SCHEMA} TO ${appRole}`);
    await owner.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${TENANCY_SCHEMA} TO ${appRole}`);
}
