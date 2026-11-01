# @spfn/core/db — Type-safe PostgreSQL data access (Drizzle ORM)

Standalone CRUD helpers, a `BaseRepository` base class, transaction-aware read/write
routing, schema helpers, and PostgreSQL error mapping — built on PostgreSQL Drizzle drivers,
with postgres.js as the default and external providers such as PGlite supported. Connection
management, schema column helpers, and transactions each live in a
sub-module with its own README (linked below); this file covers the **main module**
(helpers, repository, query-utils, postgres-errors) and the connection/transaction entry
points re-exported from it.

## Import paths

Everything ships from a **single** entry point:

```typescript
import {
    // CRUD helpers
    findOne, findMany, create, createMany, upsert,
    updateOne, updateMany, deleteOne, deleteMany, count,
    // Repository
    BaseRepository, TenantRepository, RepositoryError,
    // Connection (sub-module: manager/)
    initDatabase, getDatabase, closeDatabase, getDatabaseInfo,
    // Transactions (sub-module: transaction/)
    Transactional, runWithTransaction, getTransaction,
    onBeforeCommit, onAfterCommit, onAfterRollback,
    // Schema helpers (sub-module: schema/)
    id, uuid, timestamps, foreignKey, tenantKey, enumText, typedJsonb, createSchema,
    // Error mapping
    fromPostgresError,
} from '@spfn/core/db';
```

There is no deeper public import path (no `@spfn/core/db/helpers`); import from
`@spfn/core/db`.

---

## Public API (complete)

Everything re-exported from `@spfn/core/db` (`src/db/index.ts`):

**CRUD helpers** (`helpers.ts`) — standalone, no class needed:
`findOne`, `findMany`, `create`, `createMany`, `upsert`, `updateOne`, `updateMany`,
`deleteOne`, `deleteMany`, `count`

**Repository** (`repository.ts`, `tenant/`):
`BaseRepository` (abstract class), `TenantRepository` (abstract class, tables shared by many
tenants), `RepositoryError` (class), `RepositoryDatabase` (type), `CountOptions` (type)

**Tenancy** (`tenant/tenancy.ts` — see [Tenancy](#tenancy-definetenancy--tenant-tables-enforced-by-the-database)):
`defineTenancy`, `TenantMismatchError` (class), `listTenancyTables` (internal: the boot check)
Types: `Tenancy`, `TenancyOptions`, `TenancyGuardOptions`, `TenancyReferenceOptions`,
`TenantListTable`, `TenantSource`

**PostgreSQL error mapping** (`postgres-errors.ts`):
`fromPostgresError`

**Connection / manager** (sub-module — see [manager/README](./manager/README.md)):
`createDatabaseFromEnv`, `initDatabase`, `getDatabase`, `setDatabase`,
`setDatabaseProvider`, `closeDatabase`,
`getDatabaseInfo`, `forceReconnectDatabase`, `createDatabaseConnection`, `checkConnection`,
`reportDatabaseError`, `isConnectionLevelError`, `resetConnectionErrorCounter`,
`getDrizzleConfig`, `detectDialect`, `generateDrizzleConfigFile`, `renderDrizzleConfig` (0.3.0-beta.9: `getDrizzleConfig` returns `schemaSource` and `schemaRegistry`; the `autoDetectSchemas` option is gone — the CLI derives PostgreSQL schemas from the loaded modules, and a hand-written config passes `schemaFilter` itself)
Types: `DatabaseClients`, `DatabaseInitOptions`, `DatabaseOptions`, `DatabaseProvider`,
`DatabaseTransaction`, `DefaultDatabase`, `DrizzleDatabase`, `PoolConfig`, `RetryConfig`,
`DrizzleConfigOptions`

**Transactions** (sub-module — see [transaction/README](./transaction/README.md);
`runInTransaction(fn, { tenant })` binds a transaction to a tenant, see [Tenancy](#tenancy-definetenancy--tenant-tables-enforced-by-the-database)):
`Transactional`, `getTransaction`, `runWithTransaction`, `runInTransaction`,
`onBeforeCommit`, `onAfterCommit`, `onAfterRollback`
Types: `TransactionContext`, `TransactionDB`, `TransactionalOptions`,
`RunInTransactionOptions`, `BeforeCommitCallback`, `AfterCommitCallback`,
`AfterRollbackCallback`

**Schema helpers** (sub-module — see [schema/README](./schema/README.md), re-exported via
`export * from './schema'`):
`id`, `uuid`, `timestamps`, `foreignKey`, `optionalForeignKey`, `tenantKey`, `auditFields`,
`publishingFields`, `softDelete`, `verificationTimestamp`, `utcTimestamp`, `enumText`,
`typedJsonb`, `createSchema`, `packageNameToSchema`, `getSchemaInfo`

> **No such API.** There is **no** `update`, `deleteById`, `findById`, `save`, or `insert`
> top-level helper — the helpers are exactly the ten listed above. `BaseRepository` exposes
> CRUD as **protected `_`-prefixed methods** (`_findOne`, `_create`, …) — they are not
> callable from outside the class. There is no public `getDatabaseOrThrow` (use
> `getDatabase`, which already throws when uninitialized) and no `db.update()` chain helper
> beyond what Drizzle itself provides.

---

## Quick Start

```typescript
import { BaseRepository, initDatabase, Transactional } from '@spfn/core/db';
import { id, timestamps, enumText } from '@spfn/core/db';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { desc, isNull } from 'drizzle-orm';

// 1. Define a table with schema helpers
const USER_STATUS = ['active', 'inactive'] as const;

export const users = pgTable('users', {
    id: id(),                                       // bigserial PK
    email: text('email').notNull().unique(),
    name: text('name'),
    status: enumText('status', USER_STATUS).default('active').notNull(),
    ...timestamps(),                                // createdAt, updatedAt (timestamptz)
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// 2. Repository — extend BaseRepository, export a singleton
export class UserRepository extends BaseRepository
{
    async findById(id: number): Promise<User | null>
    {
        return this._findOne(users, { id });
    }

    async findActive(limit = 10): Promise<User[]>
    {
        return this._findMany(users, {
            where: { status: 'active' },
            orderBy: desc(users.createdAt),
            limit,
        });
    }

    async create(data: NewUser): Promise<User>
    {
        return this._create(users, data);
    }
}

export const userRepo = new UserRepository();

// 3. Initialize once (startServer() does this automatically; manual only in scripts)
await initDatabase();

// 4. Use inside a transactional route — auto commit / rollback
export const middlewares = [Transactional()];

export async function POST(c: RouteContext)
{
    const user = await userRepo.create(await c.req.json());
    return c.json(user, 201);
}
```

---

## CRUD helpers (`helpers.ts`)

Standalone functions for operations that don't need a repository class. Each one resolves
the global DB instance internally (`getDatabase('read'|'write')`) and is transaction-aware
only through that instance — they do **not** read the `AsyncLocalStorage` transaction
context. **Inside a transaction, use `BaseRepository` methods or `getTransaction()`
instead** (see Pitfalls).

| Function | Signature | Returns |
|----------|-----------|---------|
| `findOne` | `findOne(table, where)` | `T \| null` |
| `findMany` | `findMany(table, options?)` | `T[]` |
| `create` | `create(table, data)` | `T` |
| `createMany` | `createMany(table, data[])` | `T[]` |
| `upsert` | `upsert(table, data, { target, set? })` | `T` |
| `updateOne` | `updateOne(table, where, data)` | `T \| null` |
| `updateMany` | `updateMany(table, where, data)` | `T[]` |
| `deleteOne` | `deleteOne(table, where)` | `T \| null` |
| `deleteMany` | `deleteMany(table, where)` | `T[]` |
| `count` | `count(table, where?)` | `number` |

Note the argument order: `where` comes **before** `data` for updates
(`updateOne(table, where, data)`), and delete takes only `where`
(`deleteOne(table, where)`). `T` is inferred from the table (`table.$inferSelect`).

```typescript
import {
    findOne, findMany, create, upsert, updateOne, deleteOne, count,
} from '@spfn/core/db';
import { eq, and, gt, desc } from 'drizzle-orm';

// Find — object where (equality, ANDed) OR a Drizzle SQL condition
const user   = await findOne(users, { id: 1 });
const adult  = await findOne(users, and(eq(users.id, 1), gt(users.age, 18)));
const active = await findMany(users, {
    where: { status: 'active' },
    orderBy: desc(users.createdAt),
    limit: 10,
    offset: 0,
});

// Create
const created = await create(users, { email: 'a@b.com', name: 'A' });

// Upsert (INSERT … ON CONFLICT DO UPDATE) — target is required, set defaults to data
const cache = await upsert(cmsCache, data, {
    target: [cmsCache.section, cmsCache.locale],
    set: { content: data.content, updatedAt: new Date() },
});

// Update — where then data; returns null if nothing matched
const updated = await updateOne(users, { id: 1 }, { name: 'New' });

// Delete — returns the deleted row(s)
const deleted = await deleteOne(users, { id: 1 });

// Count — where is optional
const total      = await count(users);
const activeOnly = await count(users, { status: 'active' });
```

`findOne` / `updateOne` / `updateMany` / `deleteOne` / `deleteMany` **throw** if the
resolved where clause is empty (`'<op> requires at least one where condition'`) — you
cannot accidentally update/delete the whole table. `findMany` and `count` allow no where.

---

## BaseRepository (`repository.ts`)

Abstract base class. Extend it to get transaction-aware connections plus the same CRUD set
as protected methods.

```typescript
import { BaseRepository } from '@spfn/core/db';
import { eq, isNull, desc } from 'drizzle-orm';

export class UserRepository extends BaseRepository
{
    // Protected getters provided by BaseRepository:
    //   this.db     → write instance (tx-aware: uses the active transaction if any)
    //   this.readDb → read instance  (replica if configured; tx-aware)

    async findById(id: number)
    {
        return this._findOne(users, { id });
    }

    async findActive()
    {
        // Drop to raw Drizzle for anything the helpers can't express
        return this.readDb.select().from(users).where(isNull(users.deletedAt));
    }
}

export const userRepo = new UserRepository();
```

### Protected CRUD methods

Same semantics and argument order as the standalone helpers, prefixed with `_`. Use these
inside repository methods.

| Method | Returns |
|--------|---------|
| `_findOne(table, where)` | `T \| null` |
| `_findMany(table, options?)` | `T[]` |
| `_findManyKeyset(table, { cursorColumn, limit, after?, order?, where? })` | `T[]` |
| `_create(table, data)` | `T` |
| `_createMany(table, data[])` | `T[]` |
| `_upsert(table, data, { target, set? })` | `T` |
| `_updateOne(table, where, data)` | `T \| null` |
| `_updateMany(table, where, data)` | `T[]` |
| `_deleteOne(table, where)` | `T \| null` |
| `_deleteMany(table, where)` | `T[]` |
| `_count(table, where?, { cap? })` | `number` — with `cap`, at most `cap + 1` |

`_count` with `cap` stops counting past `cap` rows: it reads at most `cap + 1` rows through a
limited subquery, and a result of `cap + 1` means "more than `cap`". A list label such as
"1,000+" needs nothing more, and the count no longer scans every matching row on each
request.

These are `protected` — calling `userRepo._findOne(...)` from outside is a TypeScript
error. Expose a domain method (`findById`) instead.

### `this.db` vs `this.readDb`

Both getters first check for an active transaction (`getTransaction()`); if one exists,
both return that transaction's DB so all work runs in the same transaction. Outside a
transaction, `this.db` returns the write/primary instance and `this.readDb` the read/replica
instance. Use `readDb` for SELECT, `db` for INSERT/UPDATE/DELETE. The `_`-helpers already do
this (`_findOne`/`_findMany`/`_count` use `readDb`; writes use `db`).

Their type is the injected database **or its matching transaction type**. Common Drizzle
query methods remain available in both contexts, while driver-only members such as a raw
`$client` are intentionally not exposed through these transaction-aware getters. Use the
provider outside repository operations when direct driver access is required.

### `withContext` — error tracking

Wrap a raw query to attach repository/method/table context to failures and feed the
reconnect fast-path (see manager/README). On error it throws a `RepositoryError` carrying
`{ repository, method, table, originalError }`.

```typescript
async findById(id: number)
{
    return this.withContext(
        () => this.readDb.select().from(users).where(eq(users.id, id)),
        { method: 'findById', table: 'users' },
    );
}
```

The built-in `_`-helpers do **not** auto-wrap with `withContext`; wrap raw `this.db` /
`this.readDb` queries yourself when you want the enriched error + reconnect reporting.

### Typed relations (optional)

```typescript
import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema);
export type AppRelations = typeof relations;

export class UserRepository extends BaseRepository<AppRelations>
{
    // this.db and this.readDb preserve AppRelations
}
```

For an injected driver, pass its database type as the second generic:

```typescript
import type { PgliteDatabase } from 'drizzle-orm/pglite';

type AppDatabase = PgliteDatabase<AppRelations>;

export class UserRepository extends BaseRepository<AppRelations, AppDatabase>
{
    // this.db and this.readDb are AppDatabase
}
```

---

## TenantRepository (`tenant/`) — tables shared by many tenants

For an app that keeps many tenants (workspaces, organizations, customers) in the same
tables. Mark a table's tenant column with `tenantKey()`; extend `TenantRepository` instead of
`BaseRepository`. Every method takes the tenant id first and writes the tenant condition
into the query itself, so a query this class builds cannot reach another tenant's rows.
Packages that never call `tenantKey()` are unaffected.

```typescript
import { createSchema, foreignKey, id, tenantKey, timestamps, TenantRepository } from '@spfn/core/db';
import { index, text } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const schema = createSchema('@acme/notes');

export const authors = schema.table('authors', {
    id: id(),
    tenantId: tenantKey(),                          // tenant_id bigint not null
    name: text('name').notNull(),
}, (t) => [index('authors_tenant_id_idx').on(t.tenantId, t.id)]);

export const notes = schema.table('notes', {
    id: id(),
    tenantId: tenantKey(),
    authorId: foreignKey('author', () => authors.id),
    title: text('title').notNull(),
    ...timestamps(),
}, (t) => [index('notes_tenant_id_idx').on(t.tenantId, t.id)]);

export class NoteRepository extends TenantRepository
{
    async list(tenantId: number, after?: number)
    {
        return this._findManyKeyset(tenantId, notes, { cursorColumn: notes.id, after, limit: 50 });
    }

    async listWithAuthor(tenantId: number)
    {
        return this._select(tenantId, { title: notes.title, author: authors.name })
            .from(notes)
            .innerJoin(authors, eq(notes.authorId, authors.id));
    }
}
```

`listWithAuthor(7)` runs:

```sql
select "notes"."title", "authors"."name"
from "acme_notes"."notes"
inner join "acme_notes"."authors"
    on ("notes"."author_id" = "authors"."id" and "authors"."tenant_id" = $1)
where "notes"."tenant_id" = $2
```

| Method | Tenant handling |
|--------|-----------------|
| `_findOne(tenantId, table, where)` | added to WHERE |
| `_findMany(tenantId, table, options?)` | added to WHERE |
| `_findManyKeyset(tenantId, table, options)` | added to WHERE |
| `_count(tenantId, table, where?, { cap? })` | added to WHERE |
| `_create` / `_createMany(tenantId, table, data)` | written to the tenant column; a different tenant value in `data` throws, and `_createMany` checks every row before writing any |
| `_upsert(tenantId, table, data, { target, set? })` | written to the tenant column; `target` must include the tenant column, `set` must not change it |
| `_updateOne` / `_updateMany(tenantId, table, where, data)` | added to WHERE; `data` naming the tenant column throws |
| `_deleteOne` / `_deleteMany(tenantId, table, where)` | added to WHERE |
| `_select(tenantId, fields?)` | the `from` table in WHERE, each joined tenant-aware table in its ON clause |

- **The tenant id must be a positive safe integer.** Anything else — `0`, `NaN`,
  `undefined`, a string — throws before a query is built.
- **Every method takes tenant-aware tables only.** An ordinary table throws; it can still be
  joined in `_select`, where it gets no tenant condition.
- **Joined tables get the condition in ON, not WHERE.** In WHERE, a left join's unmatched
  rows would be filtered out and it would behave as an inner join. `_select` scopes
  `innerJoin` and `leftJoin` (aliases included); `rightJoin`, `fullJoin`, `crossJoin`, the
  lateral joins and set operators (`union`, … — the methods and the standalone functions)
  throw — write those on `this.readDb`.
- **A view cannot be joined.** A view's columns are its own, so `_select` cannot tell which
  holds the tenant; joining one throws, as `.from(view)` does. Join the underlying table.
- **The upsert target must include the tenant column.** With `target: [table.id]`, an insert
  could collide with another tenant's row and update it.
- **Update and delete still need a where of their own,** as in `BaseRepository`: the tenant
  condition alone does not count, so a bare call cannot rewrite or delete a whole tenant.
- **Index on the tenant column first.** `tenantKey()` cannot create an index (a Drizzle
  column cannot); declare each index in the table's third argument starting with the tenant
  column, e.g. `(tenant_id, id)` for keyset pages.
- **`this.db` / `this.readDb` remain available and are not scoped,** nor is a subquery you
  pass as a condition or join source. In local and development runs (`NODE_ENV` `local` or
  `development`; an unset `NODE_ENV` is `local`), the database connection logs a warning —
  once per SQL text, with the SQL — when a query reads, updates or deletes a tenant-aware
  table without a condition on its tenant column. It reads SQL text, so it is a development
  aid, not isolation: an alias it cannot resolve, a raw `sql` template or an unusual shape can
  make it miss a query or warn about a scoped one. A failure inside the check never fails the
  query. Other environments attach no logger.
- **Tenancy tables add rules R1–R6.** For a table made with `tenancy.table` (next section)
  every method also decides where the query runs and refuses a mismatched tenant; a
  `tenantKey()`-only table keeps the behaviour above, plus the two mismatch checks.

---

## Tenancy (`defineTenancy`) — tenant tables enforced by the database

`TenantRepository` keeps the queries it builds inside one tenant. A tenancy makes the
database enforce it as well, for every query: declare the tenant list once, build the tenant
tables from it, and each table gets composite foreign keys and a row-level security policy.

```typescript
// server/entities/tenancy.ts
import { createSchema, defineTenancy, id, timestamps } from '@spfn/core/db';
import { getAuth } from '@spfn/auth/server';
import { text } from 'drizzle-orm/pg-core';

const schema = createSchema('@acme/notes');

export const workspaces = schema.table('workspaces', {
    id: id(),
    name: text('name').notNull(),
});

export const tenancy = defineTenancy({
    tenants: workspaces,                     // or `users` from @spfn/auth/server: tenant = user
    authorize: async (c, tenantId) => memberRepository.isMember(tenantId, Number(getAuth(c).userId)),
    // column: 'workspace_id',               // default 'tenant_id'
});

export const authors = tenancy.table(schema, 'authors', {
    id: id(),                                // required
    name: text('name').notNull(),
});

export const notes = tenancy.table(schema, 'notes', {
    id: id(),
    authorId: tenancy.reference('author', () => authors),                      // required
    reviewerId: tenancy.reference('reviewer', () => authors, { optional: true }),
    title: text('title').notNull(),
    ...timestamps(),
});
```

```typescript
// server/routes/notes.ts
export const listNotes = route.get('/workspaces/:workspaceId/notes')
    .use([tenancy.guard({ param: 'workspaceId' })])
    .handler(async (c) => noteRepository.list(tenancy.of(c)));

export const createNote = route.post('/workspaces/:workspaceId/notes')
    .input({ body: Type.Object({ authorId: Type.Number(), title: Type.String() }) })
    .use([tenancy.guard({ param: 'workspaceId' }), Transactional()])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return noteRepository.create(tenancy.of(c), body);
    });

// Personal data: the tenant is the signed-in user
export const listDiaries = route.get('/me/diaries')
    .use([tenancy.guard({ resolve: (c) => Number(getAuth(c).userId) })])
    .handler(async (c) => diaryRepository.list(tenancy.of(c)));

// Outside a request (a script, a job)
await runInTransaction(() => noteRepository.archiveOld(42), { tenant: 42 });
```

`spfn db generate` writes, for `notes`:

```sql
CREATE TABLE "acme_notes"."notes" (
    "id" bigserial PRIMARY KEY,
    "tenant_id" bigint NOT NULL,
    "author_id" bigint NOT NULL,
    "reviewer_id" bigint,
    "title" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "notes_tenant_id_id_key" UNIQUE("tenant_id","id")
);
ALTER TABLE "acme_notes"."notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acme_notes"."notes" ADD CONSTRAINT "notes_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "acme_notes"."workspaces"("id");
ALTER TABLE "acme_notes"."notes" ADD CONSTRAINT "notes_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "acme_notes"."authors"("tenant_id","id") ON DELETE CASCADE;
ALTER TABLE "acme_notes"."notes" ADD CONSTRAINT "notes_reviewer_fk" FOREIGN KEY ("tenant_id","reviewer_id") REFERENCES "acme_notes"."authors"("tenant_id","id");
CREATE POLICY "notes_tenant_isolation" ON "acme_notes"."notes" AS PERMISSIVE FOR ALL TO public
    USING ("tenant_id" = current_setting('app.tenant_id')::bigint)
    WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::bigint);
```

- **`unique (tenant_id, id)`** is what the composite foreign keys point at, and doubles as the
  `(tenant_id, id)` index keyset pages need.
- **A reference cannot cross tenants.** `(tenant_id, author_id) → authors (tenant_id, id)`:
  a tenant 7 note pointing at a tenant 9 author is refused by the database. A required
  reference is `ON DELETE CASCADE`; an optional one is `NO ACTION` — the author cannot be
  deleted while a note names it (`SET NULL` would null `tenant_id` too, and the column-list
  form needs PostgreSQL 15). A null optional reference is not checked (`MATCH SIMPLE`).
- **A tenant with rows cannot be deleted**: the tenant foreign key is `NO ACTION`.
- **A connection that set no tenant gets an error, not rows**: the policy reads
  `current_setting('app.tenant_id')` without `missing_ok`.
- **The tenant column is added for you** (`tenantId`, column `tenant_id` or
  `defineTenancy({ column })`); declaring it in `columns` throws, and so does a table
  without `id`. The third argument adds your own indexes and constraints after these.
- **`tenancy.reference` points at a `tenancy.table` of the same tenancy only** — anything
  else throws when drizzle reads the table (`getTableConfig`, `spfn db generate`). The target
  is a function, so it may name a table defined later; a reference to its own table spells
  out the return type, as drizzle's `.references()` does: `(): PgTable => notes`.
- **Constraint names are fixed**: `<table>_tenant_id_id_key`, `<table>_tenant_id_fk`,
  `<table>_<reference>_fk`, `<table>_tenant_isolation`. A name over PostgreSQL's 63-byte
  limit becomes its first 54 bytes, `_`, and 8 hex digits of a hash of the whole name.

### Where a TenantRepository query runs (R1–R6)

| # | Situation | What happens |
|---|-----------|--------------|
| R1 | no open transaction, read method | `BEGIN` + `SET TRANSACTION READ ONLY` on the **read** connection → `set_config('app.tenant_id', t, true)` → query → `COMMIT` |
| R2 | no open transaction, write method | `BEGIN` on the write connection → `set_config` → query → `COMMIT` |
| R3 | in a transaction with no tenant yet | `set_config(t)` in it first, and the transaction is bound to `t` |
| R4 | in a transaction bound to `t` | the query |
| R5 | in a transaction bound to another tenant | `TenantMismatchError`, no SQL |
| R6 | `tenancy.guard()` authorized another tenant for this request | `TenantMismatchError`, no SQL |

- The tenant id is a bound parameter; no SQL text is built from it. `set_config(..., true)`
  ends with the transaction, so a pooled connection never carries it further.
- The short transactions of R1/R2 are invisible to the transaction context: no hooks, no
  nesting, and code after the call sees no transaction.
- The binding lives on the **root** transaction; a savepoint shares it. A savepoint that set
  it and then rolled back undoes it, and the next call sets it again.
- `runInTransaction(fn, { tenant })` sets it right after `BEGIN`. A nested call naming
  another tenant throws before its `SAVEPOINT`; `requiresNew: true` is a root on its own
  connection and may name its own tenant.
- `_select` applies R1–R6 when the builder runs (`await`, `.then`, `.execute()`), not when
  it is built; `toSQL()` is unchanged. `.prepare()` on a query that reads a tenancy table
  throws — the statement would run later, outside these rules.
- **`tenantKey()`-only tables** (no policy) keep part 1's behaviour — no short transaction,
  no `set_config` — with R5 and R6 added.
- **Hand-written queries** (`this.db`, `this.readDb`) get no rule: inside a transaction bound
  to a tenant the policy shows that tenant's rows only; anywhere else they fail.

### `tenancy.guard` and `tenancy.of`

`tenancy.guard({ param: 'workspaceId' })` reads the route parameter, `tenancy.guard({ resolve })`
calls your function — exactly one of the two, checked when `guard()` is called.

1. The id must be a positive safe integer: anything else answers **400** (`ValidationError`)
   and `authorize` does not run. An error thrown by `resolve` propagates unchanged.
2. `authorize(c, tenantId)`: anything but `true` answers **403** (`ForbiddenError`); a throw
   propagates unchanged.
3. The rest of the request runs bound to the tenant (an `AsyncLocalStorage`, so concurrent
   requests never see each other's); `tenancy.of(c)` returns it, and throws on a route
   without the guard.

The guard opens no transaction, so reads keep using the read replica. Add `Transactional()`
to a write route — in either order: the first repository call binds the transaction.

### Database roles

| Role | URL | Used by | Owns the tables |
|------|-----|---------|-----------------|
| owner | `DATABASE_OWNER_URL` | `spfn db migrate`, `backup`, `restore`, `drop` | yes — row-level security does not apply to it |
| app | `DATABASE_URL` / `DATABASE_WRITE_URL` / `DATABASE_READ_URL` | the running app | no; not superuser, not `BYPASSRLS` |

PostgreSQL skips row-level security for a table's owner (and roles inheriting its
privileges), superusers and `BYPASSRLS` roles. Without `DATABASE_OWNER_URL` the four commands
use `DATABASE_URL`, as before. `pg_dump` stops with an error on a table whose policy applies
to its role, and PostgreSQL refuses `COPY FROM` into one — so backup and restore need the
owner too. `FORCE ROW LEVEL SECURITY` is not used: it would subject the owner, and break
both, and any data migration across tenants.

Grant the app role its row privileges once, as the owner:

```sql
GRANT USAGE ON SCHEMA acme_notes TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA acme_notes TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA acme_notes TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA acme_notes
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA acme_notes
    GRANT USAGE ON SEQUENCES TO app_user;
```

An app already deployed with the app role as owner moves the tables once (nothing does it
automatically), as a superuser or the current owner:

```sql
ALTER TABLE acme_notes.notes OWNER TO app_owner;   -- per table, sequences follow their table
-- or everything app_user owns in this database:
REASSIGN OWNED BY app_user TO app_owner;
```

**Boot check.** When the app declares tenancy tables, the server checks the role of its
write and read connections at startup: a role that owns a tenancy table, or is a superuser
or `BYPASSRLS`, refuses to boot in production (`NODE_ENV=production`) and logs one warning
line elsewhere — local development usually runs as the `postgres` superuser. A check that
cannot run logs one warning and the server starts. An app without tenancy tables sends no
query.

---

## Where clauses & query options (`query-utils.ts`)

Both the helpers and `BaseRepository._*` methods accept the same two `where` forms,
resolved by the internal `buildWhereFromObject` / `isSQLWrapper` utilities (not exported):

```typescript
import { eq, and, or, gt, like, isNull, inArray, desc, asc } from 'drizzle-orm';

// 1. Object form — equality only, ANDed together. undefined values are dropped.
await this._findOne(users, { email: 'a@b.com', status: 'active' });
//   → WHERE email = 'a@b.com' AND status = 'active'

// 2. SQL form — any Drizzle condition, for non-equality / OR / IN / NULL / etc.
await this._findMany(users, { where: and(eq(users.role, 'admin'), gt(users.age, 18)) });
await this._findMany(users, { where: or(eq(users.role, 'admin'), eq(users.role, 'mod')) });
await this._findMany(users, { where: inArray(users.id, [1, 2, 3]) });
await this._findMany(users, { where: isNull(users.deletedAt) });
await this._findMany(users, { where: like(users.email, '%@example.com') });
```

`findMany` / `_findMany` options: `{ where?, orderBy?, limit?, offset? }`.
`orderBy` accepts a single `SQL` or an array:

```typescript
await this._findMany(users, {
    where: { status: 'active' },
    orderBy: [desc(users.createdAt), asc(users.name)],
    limit: 20,
    offset: 40,
});
```

> An **empty object** `{}` (or one whose values are all `undefined`) resolves to *no
> condition*. For `findOne`/`updateOne`/`deleteOne` that triggers the
> "requires at least one where condition" throw — build the SQL `where` conditionally
> (`conditions.length ? and(...conditions) : undefined`) only for `findMany`/`count`,
> which permit it.

---

## PostgreSQL error mapping (`postgres-errors.ts`)

`fromPostgresError(error)` maps a postgres.js / Drizzle error (by SQLSTATE `code`) to a
typed `@spfn/core/errors` class with the right HTTP status:

```typescript
import { fromPostgresError } from '@spfn/core/db';

try {
    await create(users, data);
} catch (err) {
    throw fromPostgresError(err);
}
```

| SQLSTATE | Mapped error |
|----------|--------------|
| `08xxx`, `53xxx`, `57xxx` (connection / resources / operator) | `ConnectionError` |
| `23505` unique_violation | `DuplicateEntryError` (parses `Key (field)=(value)`) |
| `23502`/`23503`/`23514`/`23000`/`23001` constraints | `ConstraintViolationError` |
| `40001` etc. transaction rollback | `TransactionError` |
| `40P01` deadlock_detected | `DeadlockError` |
| `42xxx` syntax / undefined object | `QueryError` (status 400) |
| anything else | `QueryError` (status 500) |

Inside `BaseRepository.withContext` and `Transactional` middleware, query errors are already
reported to the reconnect fast-path; `fromPostgresError` is for explicit conversion to a
client-facing typed error.

---

## Sub-modules

These have their own READMEs — do not duplicate their APIs here, link to them:

- [manager/README.md](./manager/README.md) — connection lifecycle (`initDatabase`,
  `getDatabase`, `closeDatabase`, `getDatabaseInfo`), pooling, env vars
  (`DATABASE_URL` / `DATABASE_WRITE_URL` / `DATABASE_READ_URL`), health checks, pool
  rebuild / reconnect (`forceReconnectDatabase`, `reportDatabaseError`), and the Drizzle
  config generator.
- [transaction/README.md](./transaction/README.md) — `Transactional()` middleware,
  `runWithTransaction` / `runInTransaction`, `getTransaction`, the `onBeforeCommit` /
  `onAfterCommit` / `onAfterRollback` hooks, and the `AsyncLocalStorage`-based context.
- [schema/README.md](./schema/README.md) — column helpers (`id`, `uuid`, `timestamps`,
  `foreignKey`, `enumText`, `typedJsonb`, …) and PostgreSQL schema isolation
  (`createSchema`, `packageNameToSchema`, `getSchemaInfo`).
- [migrations/index.ts](https://github.com/fxylabs/spfn/blob/main/packages/core/src/db/migrations/index.ts)
  (linked to the source on GitHub: this sub-module has no README, and the package ships
  only READMEs) — which migrations each installed function
  package ships and which the database has applied: `discoverFunctionMigrations`,
  `collectMigrationStatus`, `pendingMigrationTargets`, `countPendingMigrations`. Read-only
  — applying migrations is `spfn db migrate`. One implementation behind `spfn db status`,
  the server's migration boot gate and the detailed health payload, so they cannot
  disagree about what "pending" means.

---

## Pitfalls & anti-patterns

- **`getDatabase()` throws when uninitialized — it does not return `null`.** Call
  `initDatabase()` first (the server does this for you; only scripts/tests need it).
  Helpers and repositories surface this as a thrown "Database not initialized" error.
- **Standalone helpers are not transaction-context aware.** `findOne`/`create`/… resolve the
  *global* read/write instance, not the `AsyncLocalStorage` transaction. Inside a
  `Transactional()` route or `runInTransaction`, call **`BaseRepository._*` methods**
  (which check `getTransaction()`) or `getTransaction()` directly — otherwise the write
  escapes the transaction and won't roll back.
- **`_findOne`/`_updateOne`/`_deleteOne` (and their plural update/delete forms) throw on an
  empty where.** This is a safety rail against full-table writes — pass a real condition.
  Only `findMany`/`_findMany`/`count`/`_count` accept "no where".
- **Argument order is `(table, where, data)` for updates** and `(table, where)` for deletes.
  Don't pass `data` before `where`.
- **Object where is equality + AND only.** For `>`, `<`, `LIKE`, `IN`, `IS NULL`, or `OR`,
  use a Drizzle SQL condition (`and(eq(...), gt(...))`) — passing an object can't express
  those.
- **Protected `_` methods aren't callable externally.** `userRepo._findOne(...)` is a
  compile error by design; wrap them in a domain method on the repository.
- **Use `this.readDb` for reads, `this.db` for writes in raw queries.** Reaching for
  `this.db` on a SELECT skips the read replica; reaching for `this.readDb` on a write hits
  the replica (read-only / stale). The `_`-helpers already route correctly.
- **Export repositories as singletons.** `export const userRepo = new UserRepository()`.
  Transaction propagation works through `AsyncLocalStorage`, so a shared instance is correct
  — you do not pass a `db`/`tx` handle around. (Fresh instances in tests are fine.)
- **Don't start your own transaction inside repository write methods.** Let route
  `Transactional()` middleware (or an explicit `runInTransaction`) own the boundary.
- **`upsert` requires `target`.** `set` is optional and defaults to the inserted `data`;
  pass `set` explicitly (e.g. `updatedAt: new Date()`, or a `sql\`…\`` expression) when the
  conflict update should differ from the insert.

---

## Complete example

```typescript
// src/server/entities/users.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps, softDelete, enumText } from '@spfn/core/db';

const ROLE = ['user', 'admin'] as const;

export const users = pgTable('users', {
    id: id(),
    email: text('email').notNull().unique(),
    name: text('name'),
    role: enumText('role', ROLE).default('user').notNull(),
    ...softDelete(),     // deletedAt, deletedBy
    ...timestamps(),     // createdAt, updatedAt
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

```typescript
// src/server/repositories/user.repository.ts
import { BaseRepository } from '@spfn/core/db';
import { and, eq, desc, isNull } from 'drizzle-orm';
import { users, type User, type NewUser } from '../entities/users';

export class UserRepository extends BaseRepository
{
    async findById(id: number): Promise<User | null>
    {
        return this._findOne(users, { id });
    }

    async createWithDedup(data: NewUser): Promise<User>
    {
        const existing = await this._findOne(users, { email: data.email });
        if (existing)
        {
            throw new Error('Email already exists');
        }
        return this._create(users, data);
    }

    async softDelete(id: number, deletedBy: string): Promise<User | null>
    {
        return this._updateOne(users, { id }, { deletedAt: new Date(), deletedBy });
    }

    async findActiveAdmins(): Promise<User[]>
    {
        return this._findMany(users, {
            where: and(eq(users.role, 'admin'), isNull(users.deletedAt)),
            orderBy: desc(users.createdAt),
        });
    }

    async paginate(page: number, limit: number)
    {
        const offset = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this._findMany(users, { orderBy: desc(users.createdAt), limit, offset }),
            this._count(users),
        ]);
        return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
}

export const userRepo = new UserRepository();
```

```typescript
// src/server/routes/users.ts — Transactional boundary owned by the route
import { Transactional, runInTransaction } from '@spfn/core/db';
import { userRepo } from '../repositories/user.repository';
import { profileRepo } from '../repositories/profile.repository';

export const middlewares = [Transactional()];

export async function POST(c: RouteContext)
{
    // Single transaction (middleware) — both writes commit/rollback together
    const user = await userRepo.createWithDedup(await c.req.json());
    return c.json(user, 201);
}

// Or an explicit boundary outside a route:
export async function signup(data: NewUser, profile: NewProfile)
{
    return runInTransaction(async () =>
    {
        const user = await userRepo.createWithDedup(data);
        await profileRepo.create({ ...profile, userId: user.id });
        return user;
    });
}
```

---

## Types reference

```typescript
// Inferred per-table (Drizzle):
type User    = typeof users.$inferSelect;  // SELECT row shape
type NewUser = typeof users.$inferInsert;  // INSERT shape

// BaseRepository generic:
abstract class BaseRepository<
    TRelations extends AnyRelations = EmptyRelations,
    TDatabase extends DrizzleDatabase = PostgresJsDatabase<TRelations>,
>

// RepositoryError fields:
class RepositoryError extends Error {
    repository: string;
    method?: string;
    table?: string;
    originalError?: Error;
}
```

Connection, transaction, and schema types are documented in their sub-module READMEs.

## Related

- [manager/README.md](./manager/README.md) — connection lifecycle, pooling, reconnect
- [transaction/README.md](./transaction/README.md) — transaction context & middleware
- [schema/README.md](./schema/README.md) — column helpers & schema isolation
- [@spfn/core/errors](../errors/README.md) — error classes returned by `fromPostgresError`
- [Drizzle ORM](https://orm.drizzle.team/) — `eq`/`and`/`sql`/`pgTable` and the query builder
