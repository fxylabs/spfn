/**
 * Base Repository Pattern
 *
 * Provides automatic database instance management with transaction context support.
 * Eliminates the need for manual `getDatabaseOrThrow()` calls in repository classes.
 *
 * Features:
 * - Automatic transaction context detection and usage
 * - Read/Write connection separation (with replica support)
 * - Type-safe schema generics
 * - Consistent database access pattern across all repositories
 * - Enhanced error tracking with repository context
 *
 * @example Basic Repository
 * ```typescript
 * import { BaseRepository } from '@spfn/core/db';
 * import { users } from './schema';
 * import { eq } from 'drizzle-orm';
 *
 * export class UserRepository extends BaseRepository {
 *     async findById(id: string) {
 *         // Uses read replica when available
 *         return await this.readDb
 *             .select()
 *             .from(users)
 *             .where(eq(users.id, id));
 *     }
 *
 *     async create(data: NewUser) {
 *         // Uses write primary
 *         return await this.db
 *             .insert(users)
 *             .values(data)
 *             .returning();
 *     }
 * }
 * ```
 *
 * @example With Transactions
 * ```typescript
 * import { runInTransaction } from '@spfn/core/db';
 *
 * const userRepo = new UserRepository();
 *
 * await runInTransaction(async () => {
 *     // Both db and readDb automatically use the transaction context
 *     const user = await userRepo.create({ name: 'John' });
 *     await userRepo.findById(user.id); // Uses same transaction
 * });
 * ```
 *
 * @example With Custom Schema Type
 * ```typescript
 * import type { AppRelations } from './relations';
 *
 * export class UserRepository extends BaseRepository<AppRelations> {
 *     // Now this.db and this.readDb preserve the app's Drizzle relations
 * }
 * ```
 *
 * @example With Enhanced Error Tracking
 * ```typescript
 * export class UserRepository extends BaseRepository {
 *     async updateStatus(id: string, status: string) {
 *         // Errors will include repository context automatically
 *         return await this.db
 *             .update(users)
 *             .set({ status })
 *             .where(eq(users.id, id))
 *             .returning();
 *     }
 * }
 * // On error: logs will show "UserRepository" context
 * ```
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AnyRelations, EmptyRelations, InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import { and, gt, lt, asc, desc } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { isSQLWrapper, buildWhereFromObject, buildWhereClause, clampRowLimit, countRows, type CountOptions } from './query-utils';
import type { DrizzleDatabase } from './manager/types';
import { RepositoryCore } from './repository-core';

export { RepositoryError } from './repository-core';
export type { RepositoryDatabase } from './repository-core';

/**
 * Base Repository class for database operations
 *
 * Provides automatic database instance management with transaction support.
 * Extend this class to create domain-specific repositories.
 *
 * The repository automatically detects if running within a transaction context
 * and uses the appropriate database instance:
 * - Inside transaction: Uses transaction DB
 * - Outside transaction: Uses global DB instance (with read/write separation)
 *
 * @template TRelations - Drizzle relations type (defaults to no relations)
 * @template TDatabase - PostgreSQL Drizzle driver type (defaults to postgres.js)
 */
export abstract class BaseRepository<
    TRelations extends AnyRelations = EmptyRelations,
    TDatabase extends DrizzleDatabase = PostgresJsDatabase<TRelations>,
> extends RepositoryCore<TRelations, TDatabase>
{
    // ============================================================================
    // CRUD Methods
    // ============================================================================

    /**
     * Find a single record
     *
     * @param table - Drizzle table schema
     * @param where - Object or SQL condition
     * @returns Single record or null
     *
     * @example
     * ```typescript
     * // Object-based
     * const user = await this._findOne(users, { id: 1 });
     *
     * // SQL-based
     * const user = await this._findOne(users, eq(users.id, 1));
     * ```
     */
    protected async _findOne<T extends PgTable>(
        table: T,
        where: Record<string, any> | SQL | undefined,
    ): Promise<InferSelectModel<T> | null>
    {
        const whereClause = isSQLWrapper(where)
            ? where
            : where ? buildWhereFromObject(table, where as Record<string, any>) : undefined;

        if (!whereClause)
        {
            throw new Error('findOne requires at least one where condition');
        }

        const results = await this.readDb.select().from(table as any).where(whereClause).limit(1);

        return (results[0] as InferSelectModel<T>) ?? null;
    }

    /**
     * Find multiple records
     *
     * @param table - Drizzle table schema
     * @param options - Query options
     * @returns Array of records
     *
     * @example
     * ```typescript
     * const users = await this._findMany(users, {
     *     where: { active: true },
     *     orderBy: desc(users.createdAt),
     *     limit: 10
     * });
     * ```
     */
    protected async _findMany<T extends PgTable>(
        table: T,
        options?: {
            where?: Record<string, any> | SQL | undefined;
            orderBy?: SQL | SQL[];
            limit?: number;
            offset?: number;
        },
    ): Promise<InferSelectModel<T>[]>
    {
        let query = this.readDb.select().from(table as any);

        // Apply where
        if (options?.where)
        {
            const whereClause = isSQLWrapper(options.where)
                ? options.where
                : options.where ? buildWhereFromObject(table, options.where as Record<string, any>) : undefined;

            if (whereClause)
            {
                query = query.where(whereClause) as any;
            }
        }

        // Apply orderBy
        if (options?.orderBy)
        {
            const orderByArray = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy];
            query = query.orderBy(...orderByArray) as any;
        }

        // Apply limit, with the DB_MAX_ROWS safety ceiling
        const effectiveLimit = clampRowLimit(options?.limit && options.limit > 0 ? options.limit : undefined);

        if (effectiveLimit)
        {
            query = query.limit(effectiveLimit) as any;
        }

        // Apply offset
        if (options?.offset)
        {
            query = query.offset(options.offset) as any;
        }

        return query as unknown as Promise<InferSelectModel<T>[]>;
    }

    /**
     * Keyset (cursor) pagination — O(limit) instead of OFFSET's O(offset).
     *
     * Pages by a strictly-ordered, unique column instead of a numeric offset, so a
     * deep page doesn't scan and discard everything before it. Pass the cursor
     * column's value from the last row of the previous page as `after`; omit it for
     * the first page. The column must be unique and the sole sort key (e.g. an
     * auto-increment id or a ULID).
     *
     * @example
     * ```typescript
     * const page1 = await this._findManyKeyset(users, { cursorColumn: users.id, limit: 20 });
     * const page2 = await this._findManyKeyset(users, {
     *     cursorColumn: users.id,
     *     after: page1.at(-1)?.id,
     *     limit: 20,
     * });
     * ```
     */
    protected async _findManyKeyset<T extends PgTable>(
        table: T,
        options: {
            cursorColumn: PgColumn;
            limit: number;
            after?: string | number | bigint | Date;
            order?: 'asc' | 'desc';
            where?: Record<string, any> | SQL | undefined;
        },
    ): Promise<InferSelectModel<T>[]>
    {
        const { cursorColumn, after, order = 'asc', where } = options;

        // Clamp the page size to the same safety ceiling as _findMany
        const limit = clampRowLimit(options.limit) as number;

        const baseWhere = where
            ? (isSQLWrapper(where) ? where : buildWhereFromObject(table, where as Record<string, any>))
            : undefined;

        // Cursor predicate: rows strictly past `after` in the sort direction
        const cursorPredicate = after !== undefined
            ? (order === 'desc' ? lt(cursorColumn, after as any) : gt(cursorColumn, after as any))
            : undefined;

        const whereClause = baseWhere && cursorPredicate
            ? and(baseWhere, cursorPredicate)
            : (cursorPredicate ?? baseWhere);

        let query = this.readDb.select().from(table as any);

        if (whereClause)
        {
            query = query.where(whereClause) as any;
        }

        query = query.orderBy(order === 'desc' ? desc(cursorColumn) : asc(cursorColumn)) as any;
        query = query.limit(limit) as any;

        return query as unknown as Promise<InferSelectModel<T>[]>;
    }

    /**
     * Create a new record
     *
     * @param table - Drizzle table schema
     * @param data - Insert data
     * @returns Created record
     *
     * @example
     * ```typescript
     * const user = await this._create(users, {
     *     email: 'test@example.com',
     *     name: 'Test User'
     * });
     * ```
     */
    protected async _create<T extends PgTable>(
        table: T,
        data: InferInsertModel<T>,
    ): Promise<InferSelectModel<T>>
    {
        const results = await this.db.insert(table).values(data as any).returning();
        const result = (results as unknown as InferSelectModel<T>[])[0];

        return result as InferSelectModel<T>;
    }

    /**
     * Create multiple records
     *
     * @param table - Drizzle table schema
     * @param data - Array of insert data
     * @returns Array of created records
     *
     * @example
     * ```typescript
     * const users = await this._createMany(users, [
     *     { email: 'user1@example.com', name: 'User 1' },
     *     { email: 'user2@example.com', name: 'User 2' }
     * ]);
     * ```
     */
    protected async _createMany<T extends PgTable>(
        table: T,
        data: InferInsertModel<T>[],
    ): Promise<InferSelectModel<T>[]>
    {
        const results = await this.db.insert(table).values(data as any).returning();

        return results as InferSelectModel<T>[];
    }

    /**
     * Upsert a record (INSERT or UPDATE on conflict)
     *
     * @param table - Drizzle table schema
     * @param data - Insert data
     * @param options - Conflict resolution options
     * @returns Upserted record
     *
     * @example
     * ```typescript
     * const cache = await this._upsert(cache, {
     *     key: 'config',
     *     value: {...}
     * }, {
     *     target: [cache.key],
     *     set: { value: data.value } // updatedAt is stamped by the database
     * });
     * ```
     */
    protected async _upsert<T extends PgTable>(
        table: T,
        data: InferInsertModel<T>,
        options: {
            target: PgColumn[];
            set?: Partial<InferInsertModel<T>> | Record<string, SQL | any>;
        },
    ): Promise<InferSelectModel<T>>
    {
        const results = await this.db
            .insert(table)
            .values(data as any)
            .onConflictDoUpdate({
                target: options.target,
                set: (options.set || data) as any,
            })
            .returning();
        const result = (results as unknown as InferSelectModel<T>[])[0];

        return result as InferSelectModel<T>;
    }

    /**
     * Update a single record
     *
     * @param table - Drizzle table schema
     * @param where - Object or SQL condition
     * @param data - Update data
     * @returns Updated record or null
     *
     * @example
     * ```typescript
     * const user = await this._updateOne(users,
     *     { id: 1 },
     *     { name: 'Updated Name' }
     * );
     * ```
     */
    protected async _updateOne<T extends PgTable>(
        table: T,
        where: Record<string, any> | SQL | undefined,
        data: Partial<InferInsertModel<T>>,
    ): Promise<InferSelectModel<T> | null>
    {
        const whereClause = isSQLWrapper(where)
            ? where
            : where ? buildWhereFromObject(table, where as Record<string, any>) : undefined;

        if (!whereClause)
        {
            throw new Error('updateOne requires at least one where condition');
        }

        const results = await this.db.update(table).set(data as any).where(whereClause).returning();
        const result = (results as unknown as InferSelectModel<T>[])[0];

        return (result as InferSelectModel<T>) ?? null;
    }

    /**
     * Update multiple records
     *
     * @param table - Drizzle table schema
     * @param where - Object or SQL condition
     * @param data - Update data
     * @returns Array of updated records
     *
     * @example
     * ```typescript
     * const users = await this._updateMany(users,
     *     { role: 'user' },
     *     { verified: true }
     * );
     * ```
     */
    protected async _updateMany<T extends PgTable>(
        table: T,
        where: Record<string, any> | SQL | undefined,
        data: Partial<InferInsertModel<T>>,
    ): Promise<InferSelectModel<T>[]>
    {
        const whereClause = isSQLWrapper(where)
            ? where
            : where ? buildWhereFromObject(table, where as Record<string, any>) : undefined;

        if (!whereClause)
        {
            throw new Error('updateMany requires at least one where condition');
        }

        const results = await this.db.update(table).set(data as any).where(whereClause).returning();

        return results as InferSelectModel<T>[];
    }

    /**
     * Delete a single record
     *
     * @param table - Drizzle table schema
     * @param where - Object or SQL condition
     * @returns Deleted record or null
     *
     * @example
     * ```typescript
     * const user = await this._deleteOne(users, { id: 1 });
     * ```
     */
    protected async _deleteOne<T extends PgTable>(
        table: T,
        where: Record<string, any> | SQL | undefined,
    ): Promise<InferSelectModel<T> | null>
    {
        const whereClause = isSQLWrapper(where)
            ? where
            : where ? buildWhereFromObject(table, where as Record<string, any>) : undefined;

        if (!whereClause)
        {
            throw new Error('deleteOne requires at least one where condition');
        }

        const results = await this.db.delete(table).where(whereClause).returning();
        const result = (results as unknown as InferSelectModel<T>[])[0];

        return (result as InferSelectModel<T>) ?? null;
    }

    /**
     * Delete multiple records
     *
     * @param table - Drizzle table schema
     * @param where - Object or SQL condition
     * @returns Array of deleted records
     *
     * @example
     * ```typescript
     * const users = await this._deleteMany(users, { verified: false });
     * ```
     */
    protected async _deleteMany<T extends PgTable>(
        table: T,
        where: Record<string, any> | SQL | undefined,
    ): Promise<InferSelectModel<T>[]>
    {
        const whereClause = isSQLWrapper(where)
            ? where
            : where ? buildWhereFromObject(table, where as Record<string, any>) : undefined;

        if (!whereClause)
        {
            throw new Error('deleteMany requires at least one where condition');
        }

        const results = await this.db.delete(table).where(whereClause).returning();

        return results as InferSelectModel<T>[];
    }

    /**
     * Count records
     *
     * @param table - Drizzle table schema
     * @param where - Optional object or SQL condition
     * @param options - `cap` stops counting past that many rows
     * @returns Number of records; with `cap`, at most `cap + 1`, which means "more than cap"
     *
     * @example
     * ```typescript
     * const total = await this._count(users);
     * const activeUsers = await this._count(users, { active: true });
     *
     * // A list label: 1001 reads as "1,000+"
     * const shown = await this._count(users, undefined, { cap: 1000 });
     * ```
     */
    protected async _count<T extends PgTable>(
        table: T,
        where?: Record<string, any> | SQL | undefined,
        options?: CountOptions,
    ): Promise<number>
    {
        return countRows(this.readDb, table, buildWhereClause(table, where), options);
    }
}
