/**
 * Tenant Repository
 *
 * A repository for tables that many tenants share. Every method takes the
 * tenant id first and puts it into the query itself — the WHERE of a read,
 * update or delete, the tenant column of an insert, the ON clause of each
 * joined tenant-aware table — so no query this class builds can reach another
 * tenant's rows.
 *
 * It does not extend BaseRepository: BaseRepository's `_findOne(table, where)`
 * would stay callable without a tenant, and TypeScript does not let a subclass
 * change a method's parameter list. Both extend RepositoryCore, so `this.db`,
 * `this.readDb` and `withContext` behave the same. A query written by hand on
 * `this.db` / `this.readDb` is not scoped, and neither is a subquery passed in
 * as a condition or a join source; the development query warning reports one
 * that leaves a tenant-aware table without its tenant condition.
 *
 * @example
 * ```typescript
 * export class NoteRepository extends TenantRepository
 * {
 *     async list(tenantId: number, after?: number)
 *     {
 *         return this._findManyKeyset(tenantId, notes, { cursorColumn: notes.id, after, limit: 50 });
 *     }
 *
 *     async listWithAuthor(tenantId: number)
 *     {
 *         return this._select(tenantId, { title: notes.title, author: authors.name })
 *             .from(notes)
 *             .innerJoin(authors, eq(notes.authorId, authors.id));
 *     }
 * }
 * ```
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AnyRelations, EmptyRelations, InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import { and, asc, desc, gt, lt } from 'drizzle-orm';
import type { PgAsyncSelectBuilder, PgColumn, PgTable, SelectedFields } from 'drizzle-orm/pg-core';
import { RepositoryCore } from '../repository-core';
import { buildWhereClause, clampRowLimit, countRows, type CountOptions } from '../query-utils';
import type { DrizzleDatabase } from '../manager/types';
import { assertTenantId, requireTenantColumn, tenantCondition } from './condition';
import { scopeSelectBuilder } from './select';

type WhereInput = Record<string, any> | SQL | undefined;

/**
 * @template TRelations - Drizzle relations type (defaults to no relations)
 * @template TDatabase - PostgreSQL Drizzle driver type (defaults to postgres.js)
 */
export abstract class TenantRepository<
    TRelations extends AnyRelations = EmptyRelations,
    TDatabase extends DrizzleDatabase = PostgresJsDatabase<TRelations>,
> extends RepositoryCore<TRelations, TDatabase>
{
    // ============================================================================
    // Reads
    // ============================================================================

    /** One row of the tenant matching `where`, or null. */
    protected async _findOne<T extends PgTable>(
        tenantId: number,
        table: T,
        where: WhereInput,
    ): Promise<InferSelectModel<T> | null>
    {
        const condition = this.requiredWhere(tenantId, table, where, 'findOne');
        const rows = await this.readDb.select().from(table as any).where(condition).limit(1);

        return (rows[0] as InferSelectModel<T>) ?? null;
    }

    /** Rows of the tenant, with the same options and DB_MAX_ROWS ceiling as BaseRepository. */
    protected async _findMany<T extends PgTable>(
        tenantId: number,
        table: T,
        options?: {
            where?: WhereInput;
            orderBy?: SQL | SQL[];
            limit?: number;
            offset?: number;
        },
    ): Promise<InferSelectModel<T>[]>
    {
        let query = this.readDb.select().from(table as any).where(this.tenantWhere(tenantId, table, options?.where));

        if (options?.orderBy)
        {
            query = query.orderBy(...(Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy])) as any;
        }

        const limit = clampRowLimit(options?.limit && options.limit > 0 ? options.limit : undefined);

        if (limit)
        {
            query = query.limit(limit) as any;
        }

        if (options?.offset)
        {
            query = query.offset(options.offset) as any;
        }

        return query as unknown as Promise<InferSelectModel<T>[]>;
    }

    /**
     * Keyset (cursor) page of the tenant's rows. Index the table on
     * (tenant column, cursor column) so a page reads only its own rows.
     */
    protected async _findManyKeyset<T extends PgTable>(
        tenantId: number,
        table: T,
        options: {
            cursorColumn: PgColumn;
            limit: number;
            after?: string | number | bigint | Date;
            order?: 'asc' | 'desc';
            where?: WhereInput;
        },
    ): Promise<InferSelectModel<T>[]>
    {
        const { cursorColumn, after, order = 'asc' } = options;
        const cursor = after === undefined
            ? undefined
            : (order === 'desc' ? lt(cursorColumn, after as any) : gt(cursorColumn, after as any));
        const query = this.readDb.select().from(table as any)
            .where(and(this.tenantWhere(tenantId, table, options.where), cursor))
            .orderBy(order === 'desc' ? desc(cursorColumn) : asc(cursorColumn))
            .limit(clampRowLimit(options.limit) as number);

        return query as unknown as Promise<InferSelectModel<T>[]>;
    }

    /** Number of the tenant's rows; with `cap`, at most `cap + 1` ("more than cap"). */
    protected async _count<T extends PgTable>(
        tenantId: number,
        table: T,
        where?: WhereInput,
        options?: CountOptions,
    ): Promise<number>
    {
        const condition = this.tenantWhere(tenantId, table, where);

        return countRows(this.readDb, table, condition, options);
    }

    /**
     * A select whose `from` table and every joined tenant-aware table carry the
     * tenant condition: the `from` table in WHERE, a joined one in its ON clause.
     * `innerJoin` and `leftJoin` are scoped; right, full, cross and lateral joins,
     * set operators and a joined view throw.
     */
    protected _select(tenantId: number): PgAsyncSelectBuilder<undefined>;
    protected _select<TSelection extends SelectedFields>(tenantId: number, fields: TSelection): PgAsyncSelectBuilder<TSelection>;
    protected _select(tenantId: number, fields?: SelectedFields): unknown
    {
        assertTenantId(tenantId);

        return scopeSelectBuilder(fields ? this.readDb.select(fields) : this.readDb.select(), tenantId);
    }

    // ============================================================================
    // Writes
    // ============================================================================

    /** Insert one row for the tenant; a different tenant value in `data` throws. */
    protected async _create<T extends PgTable>(
        tenantId: number,
        table: T,
        data: InferInsertModel<T>,
    ): Promise<InferSelectModel<T>>
    {
        const values = this.withTenantValue(tenantId, table, data);
        const rows = await this.db.insert(table).values(values as any).returning();

        return (rows as unknown as InferSelectModel<T>[])[0];
    }

    /** Insert rows for the tenant; every row is checked before any is written. */
    protected async _createMany<T extends PgTable>(
        tenantId: number,
        table: T,
        data: InferInsertModel<T>[],
    ): Promise<InferSelectModel<T>[]>
    {
        const values = data.map((row) => this.withTenantValue(tenantId, table, row));
        const rows = await this.db.insert(table).values(values as any).returning();

        return rows as unknown as InferSelectModel<T>[];
    }

    /**
     * Insert, or update on conflict. The conflict target must include the
     * tenant column: on `id` alone, an insert could collide with another
     * tenant's row and update it.
     */
    protected async _upsert<T extends PgTable>(
        tenantId: number,
        table: T,
        data: InferInsertModel<T>,
        options: {
            target: PgColumn[];
            set?: Partial<InferInsertModel<T>> | Record<string, SQL | any>;
        },
    ): Promise<InferSelectModel<T>>
    {
        const values = this.withTenantValue(tenantId, table, data);

        this.assertTargetHasTenant(table, options.target);
        this.assertTenantUnchanged(table, options.set);

        const rows = await this.db
            .insert(table)
            .values(values as any)
            .onConflictDoUpdate({ target: options.target, set: (options.set || values) as any })
            .returning();

        return (rows as unknown as InferSelectModel<T>[])[0];
    }

    /** Update the tenant's rows matching `where`; returns the first, or null. */
    protected async _updateOne<T extends PgTable>(
        tenantId: number,
        table: T,
        where: WhereInput,
        data: Partial<InferInsertModel<T>>,
    ): Promise<InferSelectModel<T> | null>
    {
        const rows = await this.updateRows(tenantId, table, where, data, 'updateOne');

        return rows[0] ?? null;
    }

    /** Update the tenant's rows matching `where`. */
    protected async _updateMany<T extends PgTable>(
        tenantId: number,
        table: T,
        where: WhereInput,
        data: Partial<InferInsertModel<T>>,
    ): Promise<InferSelectModel<T>[]>
    {
        return this.updateRows(tenantId, table, where, data, 'updateMany');
    }

    /** Delete the tenant's rows matching `where`; returns the first, or null. */
    protected async _deleteOne<T extends PgTable>(
        tenantId: number,
        table: T,
        where: WhereInput,
    ): Promise<InferSelectModel<T> | null>
    {
        const rows = await this.deleteRows(tenantId, table, where, 'deleteOne');

        return rows[0] ?? null;
    }

    /** Delete the tenant's rows matching `where`. */
    protected async _deleteMany<T extends PgTable>(
        tenantId: number,
        table: T,
        where: WhereInput,
    ): Promise<InferSelectModel<T>[]>
    {
        return this.deleteRows(tenantId, table, where, 'deleteMany');
    }

    // ============================================================================
    // Internals — private, so a subclass cannot reach an unscoped path through them
    // ============================================================================

    private async updateRows<T extends PgTable>(
        tenantId: number,
        table: T,
        where: WhereInput,
        data: Partial<InferInsertModel<T>>,
        method: string,
    ): Promise<InferSelectModel<T>[]>
    {
        const condition = this.requiredWhere(tenantId, table, where, method);

        this.assertTenantUnchanged(table, data);

        const rows = await this.db.update(table).set(data as any).where(condition).returning();

        return rows as unknown as InferSelectModel<T>[];
    }

    private async deleteRows<T extends PgTable>(
        tenantId: number,
        table: T,
        where: WhereInput,
        method: string,
    ): Promise<InferSelectModel<T>[]>
    {
        const condition = this.requiredWhere(tenantId, table, where, method);
        const rows = await this.db.delete(table).where(condition).returning();

        return rows as unknown as InferSelectModel<T>[];
    }

    /** `tenant condition AND where`, after checking the tenant id and the table. */
    private tenantWhere(tenantId: number, table: PgTable, where: WhereInput): SQL
    {
        assertTenantId(tenantId);

        return and(tenantCondition(table, tenantId), buildWhereClause(table, where)) as SQL;
    }

    /** As tenantWhere, and `where` itself must filter on something besides the tenant. */
    private requiredWhere(tenantId: number, table: PgTable, where: WhereInput, method: string): SQL
    {
        assertTenantId(tenantId);

        const tenant = tenantCondition(table, tenantId);
        const filter = buildWhereClause(table, where);

        if (!filter)
        {
            throw new Error(`${method} requires at least one where condition`);
        }

        return and(tenant, filter) as SQL;
    }

    private withTenantValue<T extends PgTable>(tenantId: number, table: T, data: InferInsertModel<T>): InferInsertModel<T>
    {
        assertTenantId(tenantId);

        const { key } = requireTenantColumn(table);
        const given = (data as Record<string, unknown>)[key];

        if (given !== undefined && given !== tenantId)
        {
            throw new Error(`${key} ${String(given)} does not match the tenant ${tenantId}`);
        }

        return { ...data, [key]: tenantId };
    }

    private assertTenantUnchanged(table: PgTable, data: object | undefined): void
    {
        const { key } = requireTenantColumn(table);

        if (data && (data as Record<string, unknown>)[key] !== undefined)
        {
            throw new Error(`${key} cannot be changed through TenantRepository`);
        }
    }

    private assertTargetHasTenant(table: PgTable, target: PgColumn[]): void
    {
        const { column } = requireTenantColumn(table);

        if (!target.some((targetColumn) => targetColumn.name === column.name))
        {
            throw new Error(`upsert target must include the tenant column "${column.name}"`);
        }
    }
}
