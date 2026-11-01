import net from 'net';
import chalk from 'chalk';
import prompts from 'prompts';
import { env } from '@spfn/core/config';

/** What the owner-connection commands print when neither URL is set. */
export const OWNER_URL_MISSING = '❌ Neither DATABASE_OWNER_URL nor DATABASE_URL is set';

/**
 * The URL `db migrate`, `backup`, `restore` and `drop` connect with: the table
 * owner's, `DATABASE_OWNER_URL`, else `DATABASE_URL` as before it existed.
 *
 * The app connects as a role that owns no table, so row-level security applies
 * to it; the owner is who creates the tables, and who `pg_dump` (refused for a
 * role a policy applies to) and `COPY FROM` on restore need. Never log the
 * value — it carries the owner's password.
 */
export function ownerDatabaseUrl(): string | undefined
{
    return env.DATABASE_OWNER_URL ?? env.DATABASE_URL;
}

/**
 * Parse DATABASE_URL into connection info
 */
export interface DbConnectionInfo
{
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
}

export function parseDatabaseUrl(dbUrl: string): DbConnectionInfo
{
    try
    {
        const url = new URL(dbUrl);

        return {
            host: url.hostname,
            port: url.port || '5432',
            user: url.username,
            password: url.password,
            database: url.pathname.slice(1), // Remove leading /
        };
    }
    catch (error)
    {
        throw new Error(`Invalid DATABASE_URL format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isRemoteHost(host: string): boolean
{
    return !LOCAL_HOSTS.has(host);
}

/**
 * Extra confirmation for destructive operations against a remote host
 * or a production environment: the user must type the exact database name.
 */
export async function confirmDangerousTarget(dbInfo: DbConnectionInfo): Promise<void>
{
    if (!isRemoteHost(dbInfo.host) && process.env.NODE_ENV !== 'production')
    {
        return;
    }

    const { typed } = await prompts({
        type: 'text',
        name: 'typed',
        message: `Remote/production database detected. Type the database name "${dbInfo.database}" to continue:`,
    });

    if (typed !== dbInfo.database)
    {
        console.log(chalk.gray('Cancelled (database name mismatch).'));
        process.exit(0);
    }
}

/**
 * Check if a port is available
 */
export async function isPortAvailable(port: number): Promise<boolean>
{
    return new Promise((resolve) =>
    {
        const server = net.createServer();

        server.once('error', () =>
        {
            server.close();
            resolve(false);
        });

        server.once('listening', () =>
        {
            server.close();
            resolve(true);
        });

        server.listen(port, '127.0.0.1');
    });
}

/**
 * Find an available port starting from the given port
 */
export async function findAvailablePort(startPort: number, maxAttempts: number = 10): Promise<number>
{
    for (let i = 0; i < maxAttempts; i++)
    {
        const port = startPort + i;
        if (await isPortAvailable(port))
        {
            return port;
        }
    }

    throw new Error(`No available ports found between ${startPort} and ${startPort + maxAttempts - 1}`);
}
