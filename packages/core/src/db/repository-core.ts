/**
 * Repository core
 *
 * The database access every repository shares: the write and read instances,
 * which resolve to the ambient transaction when there is one, and the error
 * context wrapper. BaseRepository and TenantRepository both extend it and add
 * their own query methods.
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AnyRelations, EmptyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core';
import { getDatabase } from './manager';
import { reportDatabaseError } from './manager/reconnect-trigger';
import { getTransaction } from './transaction';
import type { DrizzleDatabase } from './manager/types';

/** Database surface available to repositories inside and outside transactions. */
export type RepositoryDatabase<TDatabase extends DrizzleDatabase> =
    TDatabase extends PgAsyncDatabase<infer TQueryResult, infer TRelations>
        ? PgAsyncDatabase<TQueryResult, TRelations>
        : never;

/**
 * Enhanced error class that includes repository context
 */
export class RepositoryError extends Error
{
    constructor(
        message: string,
        public readonly repository: string,
        public readonly method?: string,
        public readonly table?: string,
        public readonly originalError?: Error,
    )
    {
        super(message);
        this.name = 'RepositoryError';

        // Preserve original stack trace if available
        if (originalError?.stack)
        {
            this.stack = originalError.stack;
        }
    }
}

/**
 * Shared base of BaseRepository and TenantRepository
 *
 * @template TRelations - Drizzle relations type (defaults to no relations)
 * @template TDatabase - PostgreSQL Drizzle driver type (defaults to postgres.js)
 */
export abstract class RepositoryCore<
    TRelations extends AnyRelations = EmptyRelations,
    TDatabase extends DrizzleDatabase = PostgresJsDatabase<TRelations>,
>
{
    /**
     * Write database instance
     *
     * Automatically resolves to:
     * - Transaction DB if running within transaction context
     * - Global write (primary) instance otherwise
     *
     * Use this for INSERT, UPDATE, DELETE operations.
     *
     * @example
     * ```typescript
     * async create(data: NewUser) {
     *     return await this.db.insert(users).values(data).returning();
     * }
     * ```
     */
    protected get db(): RepositoryDatabase<TDatabase>
    {
        // Transaction context takes precedence
        const txDb = getTransaction<TDatabase>();
        if (txDb)
        {
            return txDb as RepositoryDatabase<TDatabase>;
        }

        // Fall back to global write instance
        return getDatabase<TDatabase>('write') as unknown as RepositoryDatabase<TDatabase>;
    }

    /**
     * Read database instance
     *
     * Automatically resolves to:
     * - Transaction DB if running within transaction context
     * - Global read (replica) instance otherwise
     *
     * Use this for SELECT operations to leverage read replicas
     * and reduce load on the primary database.
     *
     * @example
     * ```typescript
     * async findById(id: string) {
     *     return await this.readDb
     *         .select()
     *         .from(users)
     *         .where(eq(users.id, id));
     * }
     * ```
     */
    protected get readDb(): RepositoryDatabase<TDatabase>
    {
        // Transaction context takes precedence
        const txDb = getTransaction<TDatabase>();
        if (txDb)
        {
            return txDb as RepositoryDatabase<TDatabase>;
        }

        // Fall back to global read instance (uses replica if configured)
        return getDatabase<TDatabase>('read') as unknown as RepositoryDatabase<TDatabase>;
    }

    /**
     * Wrap query execution with repository context
     *
     * Enhances error messages with repository information to make debugging easier.
     * When an error occurs, it will include:
     * - Repository class name
     * - Method name
     * - Table name (if provided)
     * - Original error details
     *
     * @param queryFn - Query function to execute
     * @param context - Context information (operation name, table name, etc.)
     * @returns Query result
     * @throws RepositoryError with enhanced context
     *
     * @example
     * ```typescript
     * async findById(id: number) {
     *     return await this.withContext(
     *         () => this.readDb.select().from(users).where(eq(users.id, id)),
     *         { method: 'findById', table: 'users' }
     *     );
     * }
     * ```
     */
    protected async withContext<T>(
        queryFn: () => Promise<T>,
        context: { method?: string; table?: string } = {},
    ): Promise<T>
    {
        try
        {
            return await queryFn();
        }
        catch (error)
        {
            // Feed query errors to the reconnect-trigger so repeated
            // connection-level failures can force a pool rebuild.
            reportDatabaseError(error);

            const err = error instanceof Error ? error : new Error(String(error));
            const repositoryName = this.constructor.name;

            // Create enhanced error with repository context
            throw new RepositoryError(
                err.message,
                repositoryName,
                context.method,
                context.table,
                err,
            );
        }
    }
}
