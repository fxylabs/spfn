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
    // App privileges (privileges/)
    appPrivileges,
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
tenants), `RepositoryError` (class), `RepositoryDatabase` (type), `CountOptions` (type), `ReadOptions` (type: `{ primary? }`)

**Tenancy** (`tenant/tenancy.ts` — see [Tenancy](#tenancy-definetenancy--tenant-tables-enforced-by-the-database)):
`defineTenancy`, `tenantList`, `TenantMismatchError` (class), `listTenancyTables` (internal: the boot check)
Types: `Tenancy`, `TenancyOptions`, `TenancyGuardOptions`, `TenancyOnDelete`, `TenancyReferenceOptions`,
`TenancyTableOptions`, `TenantListOptions`, `TenantListTable`, `TenantListWhereValue`, `TenantBindingKey`,
`TenantSource`

**App privileges** (`privileges/` — see [App privileges](#app-privileges-appprivileges)):
`appPrivileges`, `declaredAppPrivileges`, `isAppPrivilege`, `readAppPrivilegesManifest`, `readMigrationsAppPrivileges`,
`renderAppPrivilegesManifest`, `writeAppPrivilegesManifest`, `AppPrivilegesError` (class), `AppPrivilegesManifestError` (class), `APP_PRIVILEGES`,
`DEFAULT_APP_PRIVILEGES`, `APP_PRIVILEGES_MARKER`, `APP_PRIVILEGES_MANIFEST_FILE`, `APP_PRIVILEGES_MANIFEST_VERSION`
Types: `AppPrivilege`, `AppPrivilegesManifest`, `AppTablePrivileges`, `MigrationsAppPrivileges`

**PostgreSQL error mapping** (`postgres-errors.ts`):
`fromPostgresError`

**Connection / manager** (sub-module — see [manager/README](./manager/README.md)):
`createDatabaseFromEnv`, `initDatabase`, `getDatabase`, `setDatabase`,
`setDatabaseProvider`, `closeDatabase`,
`getDatabaseInfo`, `forceReconnectDatabase`, `createDatabaseConnection`, `checkConnection`,
`reportDatabaseError`, `isConnectionLevelError`, `resetConnectionErrorCounter`,
`getDrizzleConfig`, `detectDialect`, `drizzleKitSchemaFiles` (the files drizzle-kit loads for a config's `schema`, no database URL needed), `renderSchemaFilesConfig` (a project's drizzle.config.ts with its `schema` replaced by such files, each matching only itself in drizzle-kit's glob), `generateDrizzleConfigFile`, `renderDrizzleConfig` (0.3.0-beta.9: `getDrizzleConfig` returns `schemaSource` and `schemaRegistry`; the `autoDetectSchemas` option is gone — the CLI derives PostgreSQL schemas from the loaded modules, and a hand-written config passes `schemaFilter` itself)
Types: `DatabaseClients`, `DatabaseInitOptions`, `DatabaseOptions`, `DatabaseProvider`,
`DatabaseTransaction`, `DefaultDatabase`, `DrizzleDatabase`, `PoolConfig`, `RetryConfig`,
`DrizzleConfigOptions`

**Transactions** (sub-module — see [transaction/README](./transaction/README.md);
`runInTransaction(fn, { tenant, user })` binds a transaction to a tenant and a user, see [Tenancy](#tenancy-definetenancy--tenant-tables-enforced-by-the-database)):
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
    set: { content: data.content },   // updated_at = now() is stamped by the database
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
| `_findOne(table, where, { primary? })` | `T \| null` |
| `_findMany(table, { …, primary? })` | `T[]` |
| `_findManyKeyset(table, { cursorColumn, limit, after?, order?, where?, primary? })` | `T[]` |
| `_create(table, data)` | `T` |
| `_createMany(table, data[])` | `T[]` |
| `_upsert(table, data, { target, set? })` | `T` |
| `_updateOne(table, where, data)` | `T \| null` |
| `_updateMany(table, where, data)` | `T[]` |
| `_deleteOne(table, where)` | `T \| null` |
| `_deleteMany(table, where)` | `T[]` |
| `_count(table, where?, { cap?, primary? })` | `number` — with `cap`, at most `cap + 1` |

`{ primary: true }` goes after `where` (`_findOne(table, { id }, { primary: true })`, `_count(table,
undefined, { primary: true })`) or into the `_findMany` / `_findManyKeyset` options object: in the
`where` position (`_findOne(table, { primary: true })`) it type-checks, since `where` is
`Record<string, any>`, and fails at run time as malformed SQL (`syntax error at or near "="`).

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
this (`_findOne`/`_findMany`/`_findManyKeyset`/`_count` use `readDb`; writes use `db`).

A replica can lag behind the primary. A read that must see a write made a moment ago — by this
request or another — passes `{ primary: true }` to `_findOne`, `_findMany`, `_findManyKeyset` or
`_count`, or runs inside a transaction; a transaction runs on the primary, and inside one the
option changes nothing.

```typescript
// Just written by another request: the replica may not have it yet
const user = await this._findOne(users, { id }, { primary: true });
```

Their type is the injected database **or its matching transaction type**. Common Drizzle
query methods remain available in both contexts, while driver-only members such as a raw
`$client` are intentionally not exposed through these transaction-aware getters. Use the
provider outside repository operations when direct driver access is required.

### `withContext` — error tracking

Wrap a raw query to attach repository/method/table context to failures and feed the
reconnect fast-path (see manager/README). On error it throws a `RepositoryError` carrying
`{ repository, method, table, originalError }`, with the fixed message `<Repository>.<method>
failed` and the caught error as its `cause` — never the caught error's message or stack, which
for a drizzle query error hold every bound value (#382). Read the database fields through the
cause chain; `describeError` from `@spfn/core/logger` does.

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
| `_findOne(tenantId, table, where, { primary? })` | added to WHERE |
| `_findMany(tenantId, table, { …, primary? })` | added to WHERE |
| `_findManyKeyset(tenantId, table, { …, primary? })` | added to WHERE |
| `_count(tenantId, table, where?, { cap?, primary? })` | added to WHERE |
| `_create` / `_createMany(tenantId, table, data)` | written to the tenant column; a different tenant value in `data` throws, and `_createMany` checks every row before writing any |
| `_upsert(tenantId, table, data, { target, set? })` | written to the tenant column; `target` must include the tenant column, `set` must not change it |
| `_updateOne` / `_updateMany(tenantId, table, where, data)` | added to WHERE; `data` naming the tenant column throws |
| `_deleteOne` / `_deleteMany(tenantId, table, where)` | added to WHERE |
| `_select(tenantId, fields?, { primary? })` | the `from` table in WHERE, each joined tenant-aware table in its ON clause |
| `_selectOfUser(userId, fields?, { primary? })` | by person, not by tenant: the `from` table must be a `visibleTo` tenancy table and gets `user = userId` in WHERE, each joined `visibleTo` table in its ON clause; see [A second key](#a-second-key-visibleto) |

`{ primary: true }` goes after `where` here too (`_findOne(tenantId, table, { id }, { primary:
true })`), never in its place: `_findOne(tenantId, table, { primary: true })` type-checks, since
`where` is `Record<string, any>`, and fails at run time as malformed SQL (`syntax error at or near "="`).

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
- **A read outside a transaction goes to the replica,** which can lag behind the primary. A
  read that must see a write made a moment ago — by this request or another — passes
  `{ primary: true }`, or runs inside a transaction. `_select` and `_selectOfUser` take it as
  the third argument (`_select(tenantId, undefined, { primary: true })` selects every column).
  The read keeps every rule above: still scoped to its tenant, still a short read-only
  transaction with the tenant set on a tenancy table — only on the write connection. A raw
  primary handle is not offered: on a tenancy table, `this.db` outside a transaction fails
  for want of the tenant setting.

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
    // property: 'workspaceId',              // default 'tenantId': the key rows carry it under
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
  deleted while a note names it. A null optional reference is not checked (`MATCH SIMPLE`).
- **`{ onDelete }` chooses another delete action**: `'cascade'`, `'restrict'` or
  `'no action'`, on a required or an optional reference —
  `tenancy.reference('session', () => sessions, { onDelete: 'restrict' })` refuses to
  delete a session while a record still points at it. `SET NULL` and
  `SET DEFAULT` are not offered: the tenant column is part of the same foreign key, so they
  would change `tenant_id` too (the column-list form that avoids it needs PostgreSQL 15).
  Any other value throws when the schema module loads. A cascade that reaches a
  `restrict` reference refuses the whole delete.
- **A tenant with rows cannot be deleted**: the tenant foreign key is `NO ACTION`.
- **A connection that set no tenant gets an error, not rows**: the policy reads
  `current_setting('app.tenant_id')` without `missing_ok`.
- **The tenant column is added for you** (property `tenantId` or
  `defineTenancy({ property })`, column `tenant_id` or `defineTenancy({ column })`);
  declaring it in `columns`, under its property or its column name, throws, and so does a table
  without `id`. The third argument adds your own indexes and constraints after these.
  `property` lets an app whose code already reads `row.workspaceId` adopt a tenancy without
  renaming it; pass a string literal, because the row types are keyed by it, and not `id`.
  With another property, `tenantId` is an ordinary key a table may use.
- **`tenancy.reference` points at a `tenancy.table` of the same tenancy only** — anything
  else throws when drizzle reads the table (`getTableConfig`, `spfn db generate`). The target
  is a function, so it may name a table defined later; a reference to its own table spells
  out the return type, as drizzle's `.references()` does: `(): PgTable => notes`.
- **Constraint names are fixed**: `<table>_tenant_id_id_key`, `<table>_tenant_id_fk`,
  `<table>_<reference>_fk`, `<table>_tenant_isolation`. A name over PostgreSQL's 63-byte
  limit becomes its first 54 bytes, `_`, and 8 hex digits of a hash of the whole name.

### A second key: `visibleTo`

A membership table belongs to a tenant like any other, but a person also reads it across
tenants — after sign-in, at the workspace picker, when deleting an account — before any
tenant is known. Declare it as a tenancy table with a second key, the column naming the user:

```typescript
export const members = tenancy.table(schema, 'members', {
    id: id(),
    userId: foreignKey('user', () => users.id),
    role: enumText('role', ['owner', 'member']).notNull(),
    status: enumText('status', ['active', 'invited']).notNull(),
}, (t) => [unique('members_workspace_user_key').on(t.workspaceId, t.userId)], {
    visibleTo: 'userId',                     // last argument; fourth when there is no extra config
});
```

It gets the tenancy table's constraints, an index on the user column, and four policies in
place of `_tenant_isolation` — reads admit the tenant's rows **or** the rows of the user in
`app.user_id`; inserts, updates and deletes still need the tenant:

```sql
CREATE INDEX "members_user_id_idx" ON "acme_notes"."members" ("user_id");
CREATE POLICY "members_tenant_isolation" ON "acme_notes"."members" AS PERMISSIVE FOR SELECT TO public
    USING ("workspace_id" = (case when nullif(current_setting('app.user_id', true), '') is null
                                  then current_setting('app.tenant_id')
                                  else nullif(current_setting('app.tenant_id', true), '') end)::bigint
        OR "user_id" = nullif(current_setting('app.user_id', true), '')::bigint);
CREATE POLICY "members_tenant_insert" ON "acme_notes"."members" AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ("workspace_id" = current_setting('app.tenant_id')::bigint);
CREATE POLICY "members_tenant_update" ON "acme_notes"."members" AS PERMISSIVE FOR UPDATE TO public
    USING ("workspace_id" = current_setting('app.tenant_id')::bigint)
    WITH CHECK ("workspace_id" = current_setting('app.tenant_id')::bigint);
CREATE POLICY "members_tenant_delete" ON "acme_notes"."members" AS PERMISSIVE FOR DELETE TO public
    USING ("workspace_id" = current_setting('app.tenant_id')::bigint);
```

- **`visibleTo` names a declared integer column** (bigint or integer), not `id` and not the
  tenant column; anything else throws when the schema module loads, naming the table and
  the key.
- **A connection bound to neither still gets an error.** The tenant read is lenient only
  while a user is set; a `CASE` evaluates one branch, which an `OR` of permissive policies
  does not promise. `nullif(..., '')` because a pooled connection keeps `''` once a
  transaction that set the value has ended.
- **One policy per command,** because a `FOR ALL` policy applies to reads too and permissive
  policies are OR-ed. A write in a transaction bound to the user only fails instead of
  touching nothing.
- **The user column index `<table>_<user column>_idx` is created for you**; an app that
  already has the same index drops its own.
- **Adding `visibleTo` to an existing tenancy table** generates a migration that drops and
  recreates `_tenant_isolation` and adds three policies and the index. A table without
  `visibleTo` generates the same SQL as before.

`TenantRepository._selectOfUser(userId, fields?)` is `_select` by person: rules U1–U5 bind
`app.user_id` the way R1–R5 bind `app.tenant_id`.

| # | Situation | What happens |
|---|-----------|--------------|
| U1 | no open transaction | `BEGIN` + `SET TRANSACTION READ ONLY` on the read connection (the write connection with `{ primary: true }`) → `set_config('app.user_id', u, true)` → query → `COMMIT` |
| U3 | in a transaction with no user yet | `set_config('app.user_id', u)` in it first, and the transaction is bound to `u` — beside its tenant, if it has one |
| U4 | in a transaction bound to `u` | the query |
| U5 | in a transaction bound to another user | `TenantMismatchError` (`key: 'user'`), no SQL |
| — | `tenancy.guard()` authorized a tenant for this request | no check: a read by person is allowed whatever the tenant |

| Table | `from` | `innerJoin` / `leftJoin` |
|-------|--------|--------------------------|
| `visibleTo` tenancy table | WHERE `user = u` | `user = u` in ON |
| tenancy table without `visibleTo`, `tenantKey()`-only table | throws | throws — read it with `_select(tenantId)` |
| ordinary table (the tenant list, `users`) | throws | no condition; a policy on it still applies |

```typescript
class MemberRepository extends TenantRepository
{
    async isMember(workspaceId: number, userId: number)       // the guard's authorize
    {
        // On the primary: a member removed a moment ago must not be admitted
        return await this._findOne(workspaceId, members, { userId, status: 'active' }, { primary: true }) !== null;
    }

    async listWorkspacesOf(userId: number)
    {
        return this._selectOfUser(userId, { id: workspaces.id, name: workspaces.name, role: members.role })
            .from(members)
            .innerJoin(workspaces, eq(members.workspaceId, workspaces.id));
    }
}

// Outside a request: read by person, then write by tenant
const memberships = await runInTransaction(() => memberRepository.listWorkspacesOf(userId), { user: userId });
```

`runInTransaction(fn, { user })` binds a transaction to a user, as `{ tenant }` binds it to a
tenant; with both, both are set. The same right joins, set operators and `.prepare()` are
refused as on `_select`. There are no writes by person: rows are written by tenant.

### The tenant list: `tenantList`

With members visible through `visibleTo`, the tenant list itself can carry policies — a
transaction bound to a tenant sees that tenant's row, one bound to a user the tenants the
user's memberships point at:

```typescript
// server/entities/workspaces.ts — declared before the tenancy that names it
import { createSchema, id, tenantList } from '@spfn/core/db';
import { text, type PgTable } from 'drizzle-orm/pg-core';

export const workspaces = tenantList(schema, 'workspaces', {
    id: id(),
    name: text('name').notNull(),
}, {
    visibleThrough: { table: (): PgTable => members, where: { status: 'active' } },
});
```

```sql
CREATE POLICY "workspaces_tenant_visibility" ON "acme_notes"."workspaces" AS PERMISSIVE FOR SELECT TO public
    USING ("id" = (case when nullif(current_setting('app.user_id', true), '') is null
                        then current_setting('app.tenant_id')
                        else nullif(current_setting('app.tenant_id', true), '') end)::bigint
        OR EXISTS (
        SELECT 1 FROM "acme_notes"."members" "m"
        WHERE "m"."workspace_id" = "workspaces"."id"
          AND "m"."user_id" = nullif(current_setting('app.user_id', true), '')::bigint
          AND "m"."status" = 'active'));
CREATE POLICY "workspaces_tenant_insert" ON "acme_notes"."workspaces" AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (true);
CREATE POLICY "workspaces_tenant_update" ON "acme_notes"."workspaces" AS PERMISSIVE FOR UPDATE TO public
    USING ("id" = current_setting('app.tenant_id')::bigint) WITH CHECK ("id" = current_setting('app.tenant_id')::bigint);
CREATE POLICY "workspaces_tenant_delete" ON "acme_notes"."workspaces" AS PERMISSIVE FOR DELETE TO public
    USING ("id" = current_setting('app.tenant_id')::bigint);
```

- **The membership table is a `visibleTo` table of a tenancy over this list.** Its tenant and
  user columns come from its markers when drizzle reads the table (`spfn db generate`); a table
  that is no tenancy table, of a tenancy over another list, or without `visibleTo` throws then,
  naming both tables. Spell out the thunk's return type, `(): PgTable => members`: the
  membership's type depends on the list through the tenancy, a circle TypeScript cannot infer.
- **`where` keys are membership properties**, written as their column names; values are
  strings (quotes doubled), finite numbers, booleans or `null` (`is null`), rendered as
  literals — the policy lands in a migration file, where a bound parameter cannot.
- **Creating a tenant needs no binding** (its id comes from the insert); **renaming or
  deleting one needs that tenant's** — a guarded route with `Transactional()`, or
  `runInTransaction(fn, { tenant: id })` outside a request.
- **A connection bound to neither gets an error.** A path that walks every tenant (a
  reconciler, a cleanup job) reads the list through the owner connection or an explicit
  all-tenant read of the app's own; it is not offered here.
- The `exists` reads `members` under its own read policy, so no `SECURITY DEFINER` function
  is needed, and `members`' policy never reads `workspaces`, so the two never recurse.

### Where a TenantRepository query runs (R1–R6)

| # | Situation | What happens |
|---|-----------|--------------|
| R1 | no open transaction, read method | `BEGIN` + `SET TRANSACTION READ ONLY` on the **read** connection — a replica when `DATABASE_READ_URL` is set → `set_config('app.tenant_id', t, true)` → query → `COMMIT`; `{ primary: true }` runs the same short read-only transaction on the write connection |
| R2 | no open transaction, write method | `BEGIN` on the write connection → `set_config` → query → `COMMIT` |
| R3 | in a transaction with no tenant yet | `set_config(t)` in it first, and the transaction is bound to `t` |
| R4 | in a transaction bound to `t` | the query |
| R5 | in a transaction bound to another tenant | `TenantMismatchError`, no SQL |
| R6 | `tenancy.guard()` authorized another tenant for this request | `TenantMismatchError`, no SQL |

Inside a request `tenancy.guard()` authorized, the guard's tenant binds the transaction as
early as it can (when the app has tenancy tables): a root transaction opened under the guard
without `{ tenant }` runs `set_config('app.tenant_id', t, true)` right after its `BEGIN`, and a
guard that runs inside an open, still unbound transaction binds it. So
`[tenancy.guard(...), Transactional()]` and `[Transactional(), tenancy.guard(...)]` are both
bound before the handler's first query, and a write a plain `BaseRepository` sends — renaming
the tenant in a `tenantList` — runs under the tenant. `runInTransaction(fn, { tenant: 9 })`
under a guard for 7 binds 9 as asked; its TenantRepository calls are refused by R6, as before.

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

The guard opens no transaction, so reads keep using the read replica — `authorize` too, unless
it asks for the primary. A replica can lag: an `isMember` read there admits a member removed a
moment ago until the replica catches up, so `authorize` reads with `{ primary: true }` (see the
`isMember` example above). Add `Transactional()` to a write route — in either order: the
transaction is bound to the guard's tenant before the handler runs (see R1–R6 above).

### Database roles

| Role | URL | Used by | Owns the tables |
|------|-----|---------|-----------------|
| owner | `DATABASE_OWNER_URL` | every command that changes the schema, the migration bookkeeping or the privileges: `spfn db push` (its `--dry-run` and the function package migrations it applies too), `db migrate`, `spfn add`, `db grant`; and `db backup`, `restore`, `drop`, `tenant import` | yes — row-level security does not apply to it |
| app | `DATABASE_URL` / `DATABASE_WRITE_URL` / `DATABASE_READ_URL` | the running app; `spfn db status`, the `spfn dev`/`start` pre-start check, `db studio`, `db tenant export`, `spfn provision` | no; not superuser, not `BYPASSRLS` |

PostgreSQL skips row-level security for a table's owner (and roles inheriting its
privileges), superusers and `BYPASSRLS` roles. Without `DATABASE_OWNER_URL` the owner's
commands use `DATABASE_URL`, as before: one role. The CLI README's
[Which connection each command uses](../../../cli/README.md#which-connection-each-command-uses)
has the full table. `pg_dump` stops with an error on a table whose policy applies
to its role, and PostgreSQL refuses `COPY FROM` into one — so backup and restore need the
owner too. `FORCE ROW LEVEL SECURITY` is not used: it would subject the owner, and break
both, and any data migration across tenants.

**The app role gets exactly what is declared.** `spfn db push`, `db migrate` and `spfn add` end with a
step that, as the owner and in a transaction of its own, grants the app role what each table
declares (`appPrivileges` below; the default set otherwise) and revokes anything else it holds;
`spfn db grant` runs the step alone — for a database an older CLI set up, or after a step that
failed. Nothing is granted by hand, and no `ALTER DEFAULT PRIVILEGES` is used: the step reads the
access list of every table, view and sequence in the managed schemas, so a table created by any role, a
hand `GRANT` and a hand `REVOKE` are all seen, and it issues only the statements that bring them to
the declaration — a second run issues none.

| Object (in the managed schemas) | App role | Read role (`DATABASE_READ_URL`, when another role) | PUBLIC |
|---|---|---|---|
| the project's schemas, each function package's (`spfn_auth`, …) | `USAGE`, nothing else — `CREATE` revoked | `USAGE`, nothing else | `USAGE` untouched; `CREATE` revoked, except on `public` |
| their tables, foreign tables included | the declared set, else `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `SELECT`, when the set has it | revoked |
| their views (`pgView`) | `SELECT`; a `security_invoker` view (PostgreSQL 15+) with no rule but its SELECT rule and no INSTEAD OF trigger: `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `SELECT` | revoked |
| their materialized views (`pgMaterializedView`) | `SELECT` | `SELECT` | revoked |
| a partition, at any level | nothing — access goes through its root table | — | revoked |
| their sequences (`id()` is a `bigserial`; `nextval` needs it) | `USAGE` | — | revoked |
| `drizzle`, where migrations are recorded | `USAGE` on it, nothing else; `SELECT` on its tables — never a write | nothing beyond `USAGE` | revoked; `CREATE` on it revoked |
| the queue schema (`spfn_queue`, when the app declares jobs) | `USAGE` on it, nothing else; `SELECT`, `INSERT`, `UPDATE`, `DELETE` on every table, partitions included; `SELECT`, `UPDATE` on `version`; `EXECUTE` on its functions | nothing | revoked, `EXECUTE` on its functions included |

- **Managed schemas:** the project's (from the entities on `db push`; from
  `src/server/drizzle/privileges.json` on `db migrate` and `spfn add`, which load no app source; on
  `db grant` and `db status`, from that manifest when there is one, else from the entities as push
  loads them — with neither, `db grant` exits 1 and `db status` reports the privileges unknown,
  since the project's tables cannot be seen), each installed function package's, and
  `drizzle`; and the queue schema when the app declares its jobs (below), by a rule of its own.
  Nothing else: not another app's schema in the same database.
- **Views** run as their owner, so a write granted on one is a write on the tables under it,
  whatever they declare: the app role gets `SELECT` only on a view, and anything more it holds there
  is revoked (`db status` reports it as drift). A view gets the default set (`appPrivileges` takes
  tables only) only when every write through it is checked against the app's own rights on those
  tables: it is created `WITH (security_invoker = true)` (PostgreSQL 15+), **and** has no rule but
  its SELECT rule, **and** has no INSTEAD OF trigger. PostgreSQL applies `security_invoker` to the
  view's SELECT rule only: an `ON INSERT … DO INSTEAD` rule (or an UPDATE or DELETE one) still runs
  with the owner's rights, and an INSTEAD OF trigger runs a function that may be SECURITY DEFINER,
  so either keeps the view at `SELECT`. An app that must write through a view makes it
  `security_invoker` with neither (drizzle: `pgView(…).with({ securityInvoker: true })`), or writes
  the table. A rule or trigger on a table is the table's own, and the step does not look at it. And
  since a view that is not `security_invoker` reads as its owner, the row-level security of the
  tables under it applies to the app only through a `security_invoker` view.
- **Partitions:** a partition gets no privilege of its own — what the app role, the read role or
  PUBLIC holds on one directly is revoked, and `db status` reports it as drift — since access goes
  through the root table, whose declaration and row-level security apply.
- **Revoked:** on a managed table, every privilege the owner granted the app role beyond its set —
  column grants included — the grant option of any it keeps (`REVOKE GRANT OPTION FOR`), and every
  grant to PUBLIC, whoever granted it. A privilege that reaches the app through a group role, or that
  another grantor gave it, is reported, never revoked: the step changes no role but the app role, the
  read role and PUBLIC. So a hand `GRANT TRUNCATE` is taken back, and a hand `REVOKE UPDATE` that the
  table does not declare is granted again — declare it first (`appPrivileges`). The read role is
  brought to exactly what the table above gives it, `USAGE` and `SELECT`: anything else the owner
  granted it on the managed schemas — a write, a sequence's privilege, a `drizzle` table's — is
  revoked the same way.
- **Schemas:** on each managed schema the app role and the read role hold `USAGE` and nothing
  else. The step reads the schema's access list as it reads a table's: `USAGE` is granted when the
  role cannot use the schema by any path, and never revoked; what the schema's owner gave the role
  beyond it — `CREATE`, with which the role creates, and so owns, tables there, and the grant
  option of `USAGE` — is revoked (`REVOKE CREATE ON SCHEMA …`, `REVOKE GRANT OPTION FOR USAGE ON
  SCHEMA …`), and `db status` reports it as drift. PUBLIC keeps `USAGE` — it gives the app nothing
  it does not hold, and other roles the schema's functions and types — and loses a `CREATE` the
  owner gave it, as on a table; on `public`, where PUBLIC is every role of the database, PUBLIC's
  `CREATE` is reported, never revoked (below). `CREATE` that reaches the app role through a group
  role, from another grantor, or through PUBLIC from another grantor, is reported, never revoked.
  `REVOKE CREATE` takes no table the role already created: PostgreSQL keeps it, owned by that role
  (see "A table the app role owns"). A role that owns a schema, or inherits its owner, cannot be
  restricted there: the app role or the read role that does gets no statement on it, and the step
  names it (`db status` lists one the app role owns). The other role still needs `USAGE` there to
  reach its tables, and it and PUBLIC are brought to it as on any schema: a schema the read role
  owns gets the app role `USAGE`, or is listed as one the owner role cannot grant on. Only a schema
  every planned role owns is outside the step, as an owned table is. A managed schema with something to revoke that the owner role neither owns nor
  inherits the owner of is listed, nothing is changed, and the command exits 1 — as for a table.
- **A grant that depends on one the step revokes** — one the app role made with a grant option the
  step takes — makes PostgreSQL refuse that `REVOKE` (2BP01). Every `REVOKE` is plain, never
  `CASCADE`, which would take a privilege from a role the step does not manage, and whether one is
  refused is PostgreSQL's decision, made when it runs: the step does not predict it. The
  transaction rolls back, nothing is changed, and the command exits 1, printing the refused
  statement; the grants on that table of what it revokes that roles other than the owner made
  (each grantor → grantee, privilege, column, and whether with the grant option), among which are
  the ones that depend on it; and the two ways out: their grantors revoke them, or the owner runs
  the refused statement with `CASCADE`, which removes the grants that depend on it — a decision the
  step never takes. The next run tries again. A run reports one refusal: when PostgreSQL refuses
  another statement after that, the next run reports it the same way.
- **A grant to PUBLIC from a grantor other than the owner**, which the owner's `REVOKE` leaves in
  place without an error (PostgreSQL lets a role revoke only its own grants), is listed with the
  `REVOKE` its grantor can run; nothing is changed and the command exits 1.
- **Who the app role is:** the role each app URL connects as — `DATABASE_WRITE_URL`, else
  `DATABASE_URL`, and `DATABASE_READ_URL` — asked with `SELECT current_user`, so a pooler's
  `role.tenant` user name does not mislead it. A migrate job that holds only `DATABASE_OWNER_URL`
  names it with `DATABASE_APP_ROLE`; set beside an app URL naming another role, it is refused, with
  both names, and one naming no role in the database ends the command with exit 1, naming the
  setting and the role, before any statement — a misconfiguration, not a skipped step. With neither, the step prints one warning and grants nothing; the command succeeds.
- **Nothing to grant** without `DATABASE_OWNER_URL`, or when the app role is the owner or inherits
  its privileges: one note, since row-level security does not apply to that app either.
- **A table the owner cannot grant on** — one in a managed schema that another role owns — is
  listed, nothing is granted, and the command exits 1. Move it to the owner (`REASSIGN OWNED`,
  below), then run `spfn db grant`.
- **A table the app role owns**, or whose owner it inherits, is outside the step: no statement on it,
  for the app role, the read role or PUBLIC, whoever `DATABASE_OWNER_URL` connects as — a
  superuser included, who could run one — and `db status` compares nothing on it. PostgreSQL
  applies a `REVOKE` from a table's owner, but the owner holds every grant option and can grant the
  privilege back, to itself or anyone, and `ALTER`, `DROP` and row-level security bypass need none.
  Its declaration is not enforced; the step names the table, and `db status` counts it. To bring
  it under the step, `ALTER TABLE … OWNER TO` the owner role. Unless the owner role is a superuser
  or inherits the app role, such a table is also one the owner cannot grant on (above).
- **Locks:** `GRANT` and `REVOKE` take no lock on a table, so the step does not wait behind the app's
  reads and writes; each does wait on the table's catalog row while another session holds an
  uncommitted DDL on that table. The step sets no `lock_timeout`, and neither do push and migrate
  for their own statements, so it inherits the server's or role's setting — none by default.
- **When the step fails** after the schema changes committed, the command exits 1 with
  `Schema applied; no privilege was changed, so new tables have only what the database gives by
  default`: the step runs in one transaction, so the new tables' grants are not in either — they
  have the default privileges of their creator, if any were set, and no other grant. Then the
  reason — a statement PostgreSQL refused with the grants on its relation and the two ways out, a
  role or table the owner cannot grant on, or the database error — and last, `spfn db grant`, which
  applies the step once the cause is gone.
- **`--dry-run`**: `spfn db grant --dry-run` prints the roles and how each was found, then the
  statements, and runs them in one transaction it always rolls back — `GRANT` and `REVOKE` are
  transactional — so a statement PostgreSQL refuses is reported as on a run, and nothing is
  changed. It executes, so its connection is writable, and it takes what a run takes until it
  rolls back: no lock on a table, and the catalog row of each table it grants or revokes on, so
  DDL on such a table waits for the rollback; an event trigger on `GRANT` or `REVOKE` fires as on
  a run. `spfn db push --dry-run` runs nothing: it plans the statements on the database as it is
  before the push, in read-only transactions, and counts the tables it has not created yet
  (`privileges for N new tables`); a refusal shows on the run, or on `spfn db grant --dry-run`
  after it.
- **PUBLIC `CREATE` on schema `public`** (PostgreSQL before 15) lets any role, the app's too, create —
  and so own — tables there. The step and `db status` report it; neither revokes it, as the change is
  database-wide — on `public` only: on every other managed schema PUBLIC's `CREATE` from the owner
  is revoked (above). As the database owner: `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`.
- **`spfn_queue`** (jobs, pg-boss): an app that declares its jobs in `package.json`
  (`"spfn": { "jobs": true }`, or `{ "schema": "<name>" }`, `readJobsDeclaration` below) has the
  schema installed and migrated by the owner — `db push`, `db migrate` and `db grant` run
  pg-boss's own plans as the owner before this step (`spfn add` does nothing to the queue) — and
  granted by the row above. The server's boot rule (the job README, "Who installs the queue
  schema") lets pg-boss install or migrate it as the app role only where the app role owns it, or
  where nothing is installed and it may `CREATE` on the database; on a queue the owner installed it
  starts pg-boss without a structure statement, and it refuses to start (`JobQueueSchemaError`,
  naming `spfn db migrate`/`push` or `spfn db grant`) on one it would have to install or migrate as
  a role that may not. Revoke the app role's `CREATE` on the database once the owner has installed
  the queue (`REVOKE CREATE ON DATABASE acme FROM app_user;`). A queue the app role installed —
  every jobs deployment from before — belongs to it and keeps working (it migrates it at boot): the
  commands install, migrate and grant nothing there, print the `REASSIGN OWNED` remedy, and exit 0,
  the rest of the step applied; move it to the owner and run `spfn db grant` at once, best while
  jobs are paused (the CLI README, [The queue schema](../../../cli/README.md#the-queue-schema-jobs)).
  Partitioned queues are not supported under the role split (below).

`spfn db status` (as the app) is a view of the step's plan: it reads the catalog the step reads —
every access list entry with its grant option, every column grant — for the roles the step plans
(the app role, and the read role when `DATABASE_READ_URL` connects as another), runs the step's own
plan on it, and keeps what concerns what the app role can do. It says "holds what is declared" only
when the step has no statement that changes what the app role or PUBLIC can do — none on a relation
for the app role, PUBLIC or a role the app is a member of (the read role), none granting the app
role USAGE on a schema, none revoking what it or PUBLIC holds on a schema beyond USAGE — and no
grant to PUBLIC blocks it; USAGE on a schema for the read role
changes nothing the app can do, so status does not report it. Per relation (tables, views, materialized views,
sequences) and grantee — the app role; PUBLIC, whose grants the app holds too; a role the app is a
member of, likewise, named with its path — it lists what is missing, what is held beyond the
declaration (a lost restriction), a declared privilege held `WITH GRANT OPTION` (the app can pass it
on), and column grants; each managed schema the app role cannot use; per schema and grantee, what it
holds there beyond `USAGE`; and each grant to PUBLIC from
another grantor than the owner, which the app holds and which blocks the step, with the `REVOKE`
its grantor can run. What the step leaves the app role holding — as a member of a role the step does
not plan for, or from a grantor other than the owner — it reports apart, as the step does. A table
the app role owns is outside the step (above): status counts it, and compares nothing on it. The
catalog tables are readable by every role unless an administrator revoked that (then status reports
the privileges unchecked, with the error). What the app role cannot see is the owner's side: status
does not know which role `DATABASE_OWNER_URL` connects as, so not whether that role may grant on
each relation and schema, nor whether PostgreSQL would refuse a `REVOKE` (2BP01) — it predicts no
refusal; `spfn db grant --dry-run` runs the statements and reports one. `--json` carries it as
`privileges` (`drift`, `schemasWithoutUsage`, `schemaDrift`, `publicGrantsByOthers`, `heldElsewhere`,
`schemaHeldElsewhere`, `ownedTables`, `ownedSchemas`, `publicMayCreateInPublic`, `readRole`). When
the app declares jobs (`"spfn": { "jobs": … }`), the queue schema is compared too, by the queue's
rule (a function's `EXECUTE` is `kind: "function"` drift), and a `queue` section reports its
installed version against the one this build's pg-boss runs on, its owner, and how the server would
start on it — the boot rule itself. A queue the boot refuses until the owner's step runs (not
installed, older, unreadable) is work to do, as pending migrations are, and status exits 0; it
exits 1 only where no command resolves the refusal (a schema not pg-boss's, a version pg-boss
cannot migrate from); a read role it cannot look up through
`DATABASE_READ_URL` is reported as not checked, with the reason, beside the app role's and PUBLIC's
part. `drift` has one entry per relation and grantee, so one
table can appear more than once (for the app role and for PUBLIC, say): key it by schema, table and
grantee, never by table alone.

The server's boot migration check reads the bookkeeping tables in schema `drizzle`
(`__drizzle_migrations` and one table per function package) through the app role, which the step
grants. Without that grant — the step skipped, or a database an older CLI set up — the check cannot
read them: it logs one warning (`permission denied for schema drizzle`) and the server starts
unchecked. `spfn dev` and `spfn start` print one line saying so before they spawn it; `spfn db status
--json` reports `reason: "permission-denied"`, and `spfn kit install`/`update` refuse their migration
step on it (`CLI_MIGRATION_STATUS_UNREADABLE`). `spfn db grant` is the remedy.

A database migrated by an earlier CLI may also hold `drizzle.__spfn_fn_migrations`: one
shared table where those versions recorded every function package's applied migrations by
content hash and timestamp, with no package column. It is read only for a package that has
no rows in its own `__spfn_fn_<pkg>_migrations` table, and then that package counts as
applied up to its newest migration whose hash the legacy table holds. Because the table
does not say which package a row belongs to, a package installed later whose newest
migration has the same SQL as a migration of another package recorded there (a
drizzle-kit custom-migration template left unedited, say) counts as applied up to that
migration, and its older ones never run. Nothing writes or drops the table. Once every
package the table holds records for has rows of its own — check that
`drizzle."__spfn_fn_<pkg>_migrations"` is non-empty for every function package installed
now, and for any package removed earlier that may be installed again — the table is never
read, and the operator may drop it (`DROP TABLE drizzle."__spfn_fn_migrations"`), which
also removes the limit above. Drop it no earlier: a package without rows of its own
would then count every migration as pending and replay them over existing objects.

The project's own migrations (`src/server/drizzle`, recorded in `drizzle.__drizzle_migrations`)
are applied by drizzle-orm's migrator, and their status is decided by drizzle-orm's own code:
`readMigrationFiles` (`drizzle-orm/migrator`) reads the folder and `getMigrationsToRun`
(`drizzle-orm/migrator.utils`) picks the pending ones from the table's rows, so `spfn db
status`, the boot gate and health name exactly what `spfn db migrate` will run. drizzle decides
by folder name alone: a migration is pending when no row carries its name, whatever its
timestamp. A migration merged with an older timestamp than one already applied is pending, and
so is a folder renamed after it was applied (migrate runs it again). A row whose folder is gone
is ignored, and so is SQL edited after it was applied (the hash is never compared).

A table written by drizzle-orm before 1.0 has no `name` column. `spfn db migrate` names its rows
first — by `created_at` truncated to the second, then by hash — and refuses to run when a row
matches no folder, or when the folder still uses the drizzle-kit ≤0.31 layout
(`meta/_journal.json`; `drizzle-kit up` converts it). Status names the rows the same way without
writing anything, and in either refusal case it reports an error instead of a count —
`` bookkeeping does not match local migrations; `spfn db migrate` will refuse `` — which the boot
gate refuses to start on (`MigrationBookkeepingMismatchError`, exported from `@spfn/core/db`).
The error names each unmatched row and the folder stamp or hash that would match it: restore that
folder, or delete the row after confirming its SQL is applied, then check `spfn db status`.

A folder renamed after it was applied is the one pending case `spfn db migrate` must not fix:
it would run the applied SQL again. Rename the folder back, or set the row's `name` to the new
folder name, then check `spfn db status`.

**`DATABASE_OWNER_URL` never reaches the server.** The server needs only the app role, and the
owner's credentials are the ones row-level security does not apply to. For local development keep
it in `.env.server`, which Next.js never reads, or export it in the shell you run `spfn db`
commands from. `loadEnv()` loads it from a file only for the spfn commands that change the schema
(the `owner` rows of the CLI README's "Which connection each command uses", through
`loadEnv({ ownerCredentials: true })`); the server, `provisionInfrastructure`, every other spfn
command and app code that calls `loadEnv()` leave it out, and the first such load logs one line
at `debug` (`SPFN_LOG_LEVEL=debug`): `` DATABASE_OWNER_URL is in .env.server; the server does not load it; spfn db commands that
change the schema do. `` In production give it to the migrate job's environment alone. A server
entry started with it in its environment — `startServer`, `createServer`, the serverless app,
`provisionInfrastructure` — removes it before any app code runs and logs one warning about that
environment (never the value); `spfn dev`, `spfn start`, `spfn provision` and every other spfn
command that does not change the schema remove it from their own process at their entry.

An app already deployed with the app role as owner — its tables created by `spfn db push`
before push connected as the owner, or by `spfn add` — moves them to the owner once (nothing does
it automatically). Until then `spfn db push` fails on the first statement that alters one of
them, PostgreSQL's `must be owner of table` (printed as `Invalid query (42501)`; under it this
remedy, with the role names and the objects another role owns, which push reads from the catalog
on the owner's connection). Run it as a superuser, or as a role that is a member of both roles (PostgreSQL requires
that for `REASSIGN OWNED`, and membership in the new owner for `ALTER … OWNER TO`):

```sql
ALTER TABLE acme_notes.notes OWNER TO app_owner;   -- per table, sequences follow their table
-- or everything app_user owns in this database:
REASSIGN OWNED BY app_user TO app_owner;
```

`REASSIGN OWNED` moves every object the role owns in the current database — schemas included —
so run it in each database the app role pushed to. Tables created through a superuser's URL —
often `postgres`, the bootstrap superuser — are the exception: PostgreSQL refuses `REASSIGN OWNED
BY` that role, so push prints one `ALTER … OWNER TO <owner role>;` for each of its objects
instead, to run as a superuser.

**One tenant at a time.** `spfn db tenant export <id>` writes one tenant's rows of every
tenant table to a folder, in one snapshot, as the app role — so the policy admits that
tenant's rows only, behind the command's own `WHERE`. `spfn db tenant import <dir>
[--replace]` puts them back in one transaction as the owner, which the policy does not
apply to: it checks every row's tenant column itself, and moves the sequences forward past
the imported ids. Restoring one tenant to a point in time is: restore a copy of the
database to that point, export the tenant from the copy, `import --replace` into
production. The CLI finds tenant tables through the `Symbol.for('spfn.tenant.column')` and
`Symbol.for('spfn.tenancy.table')` markers, so it reads them through any copy of
`@spfn/core` the app's schema loads. A `visibleTo` membership table is exported and imported
like any tenant table; a `tenantList` is not, as the tenant list never was.

**Boot check.** When the app declares tenancy tables, the server checks the role of its
write and read connections at startup: a role that owns a tenancy table, or is a superuser
or `BYPASSRLS`, refuses to boot in production (`NODE_ENV=production`) and logs one warning
line elsewhere — local development usually runs as the `postgres` superuser. A
`tenantList` is checked with them: its policy does not apply to such a role either. A check
that cannot run logs one warning and the server starts. An app without tenancy tables sends no
query.

### App privileges: `appPrivileges`

A table can declare what the app role may do on it, next to the table:

```typescript
import { text } from 'drizzle-orm/pg-core';
import { appPrivileges, createSchema, id } from '@spfn/core/db';

const schema = createSchema('@acme/ledger');

// Append-only: the app may read and add entries, never change or remove one
export const entries = appPrivileges(schema.table('entries', {
    id: id(),
    body: text('body').notNull(),
}), ['select', 'insert']);
```

**The step applies it** — after `db push`, `db migrate` and `spfn add`, and as `spfn db grant`, as
the owner ([Database roles](#database-roles)): the app role holds exactly the declared set on each
table. Missing privileges are granted, any other (a hand `GRANT TRUNCATE`, an `UPDATE` revoked by
hand on a table that does not declare it) is taken back, and a restriction comes back whenever the
table is created again, since the step runs after every command that can create it.

- **Values:** `select`, `insert`, `update`, `delete`, plus `truncate`, `references` and `trigger`
  as explicit opt-ins (`APP_PRIVILEGES`). Table-level only; no column lists.
- **Default:** a table without a declaration has `DEFAULT_APP_PRIVILEGES` —
  `select`, `insert`, `update`, `delete`. `SELECT … FOR UPDATE` needs `update`.
- **Refused where it is written:** an unknown privilege (`'udpate'`), an empty list, or a second,
  different declaration on one table throws `AppPrivilegesError` naming the table (its `schema` and `table`),
  so the schema module fails to load. The same list declared twice is accepted.
- **One shape for every table:** it returns the table it is given, so it wraps `pgTable`,
  `schema.table` (`createSchema`), `tenancy.table` and a function package's table alike. The
  declaration is a `Symbol.for('spfn.app.privileges')` property on the table object
  (`APP_PRIVILEGES_MARKER`), like the tenancy markers, so the CLI reads it through any copy of
  `@spfn/core` the app's schema loads.

**The manifest.** `spfn db migrate` loads no app source, so the declarations travel as a generated
file: `spfn db generate` writes `privileges.json` beside the migrations of the run, in the `out`
of the drizzle config it hands drizzle-kit — `src/server/drizzle`, the folder `db migrate` reads,
unless the project's own `drizzle.config.ts` names another — listing the tables of that config's
schema files. A function package ships its own in its migrations folder (`pnpm db:generate` in
the package writes it); `@spfn/auth`, `@spfn/notification`, `@spfn/monitor`, `@spfn/cms` and
`@spfn/workflow` do. It is generated: never edit it, regenerate it.

**No file means the default set.** A migrations folder without `privileges.json` — a package
published before this format, or one that never declares a privilege — declares nothing: every
table its migrations create has `DEFAULT_APP_PRIVILEGES`. That is the contract the grant step
reads by (`readMigrationsAppPrivileges` below). "No file" is read from the folder's listing: a
`privileges.json` that is there and cannot be read — a dangling symlink, a loop, no permission —
or is not a manifest is an error, never read as no file; so is a folder that cannot be listed,
including one that does not exist (a wrong path would otherwise grant the defaults on a guess).

```json
{
    "$comment": "Generated from the entities' appPrivileges() declarations. Do not edit: regenerate.",
    "version": 1,
    "default": ["select", "insert", "update", "delete"],
    "tables": [
        { "schema": "acme_ledger", "table": "entries", "privileges": ["select", "insert"] },
        { "schema": "acme_ledger", "table": "notes", "privileges": "default" }
    ]
}
```

(The file itself puts each list item on its own line.) Every table of the schema is listed — a
function package's tables are in the package's folder, not the project's — its schema and name as
two fields (a quoted identifier may hold a dot, so `"a.b"."c"` and `"a"."b.c"` are two tables),
with its declared list, in `APP_PRIVILEGES` order, or `"default"`; the default set is recorded
once. A table a file does not list is not one of its schema's tables, which is not the same as a
table with the default set. Tables are sorted by schema, then table, and the format is fixed, so
regenerating from unchanged entities writes the same bytes. `db generate` rewrites the file on every run, also when a
changed declaration changes no DDL and drizzle-kit writes no migration.

**A stale manifest is drift**, like a stale migration: an entity added or a declaration changed
without `spfn db generate` afterwards. `db migrate`, `db grant` and `spfn add` apply the file, not the
entities (only `db push` reads the entities): a stale file grants the old set — a table it does not
list gets the default set, and a restriction declared but not generated is not applied. A project
migrations folder with no `privileges.json` names no project schema, so the step grants nothing on
the project's tables and says so: run `spfn db generate`.
Run `spfn db generate` after every entity change and commit the file with the migrations.

For tools (the CLI's grant step, `db status`): `declaredAppPrivileges(values)` returns the
declarations of the tables among `values` (a schema module's exports) as `{ schema, table,
privileges }` entries (`AppTablePrivileges`), sorted. `readMigrationsAppPrivileges(migrationsDir)`
returns what a migrations folder declares: `{ kind: 'manifest', file, manifest }`, or
`{ kind: 'none', default }` when the folder's listing holds no `privileges.json`.
`readAppPrivilegesManifest(file)` reads and checks one file and throws
`AppPrivilegesManifestError` naming the file on unreadable JSON, a version other than
`APP_PRIVILEGES_MANIFEST_VERSION` (1), a table entry that is not a schema, a table and a privilege
list or `"default"`, or one table listed twice; `readMigrationsAppPrivileges` throws the same for
a file that is there, and for a folder it cannot list. `renderAppPrivilegesManifest` / `writeAppPrivilegesManifest` produce the
file (`APP_PRIVILEGES_MANIFEST_FILE`).

The step itself: `readPrivilegeCatalog(db, schemas, roles)` reads, on the owner's connection, the
access lists of every table and sequence of `schemas` (`PrivilegeCatalog`);
`planAppPrivileges(catalog, target, roles)` is the pure difference — the statements, what it reports
(`heldElsewhere`, `ownedRelations`, `publicGrantsByOthers`, `absentTables`, `publicMayCreateInPublic`, and per `REVOKE`
the grants of what it revokes that roles other than the owner made, `grantsByOthers`) and whether it
is `blocked` (a role name that is no role, a relation another role owns, a schema the role cannot
use and the owner cannot grant, a grant to PUBLIC from another grantor) — on `target.schemas` only:
whatever else the catalog holds is ignored; `applyAppPrivileges(db, target, roles, { rollback? })`
reads, plans and runs the statements in one transaction, none when blocked, and returns the run
(`AppPrivilegesRun`: the plan, whether it was `applied`, and the statement PostgreSQL `refused`
with 2BP01, after which the transaction rolled back); with `rollback` it always rolls back.
`target` is `{ schemas, tables, defaults, queue? }` (`AppPrivilegesTarget`), `roles` is `{ app, read? }`.
`target.queue` — `{ schema }`, the pg-boss queue schema — is planned by a rule of its own, which
the CLI passes when `package.json` declares jobs (`db grant` and its steps, and `spfn db status`
to compare it): the app role gets `USAGE` on the schema and nothing else there (its
`CREATE`, the read role's and PUBLIC's are revoked, as on any managed schema), `SELECT`, `INSERT`, `UPDATE`,
`DELETE` on every table there, **partitions included** (pg-boss names its `job_common` partition
in its statements, and PostgreSQL checks a partition's own privileges when it is named), `SELECT`
and `UPDATE` on `version`, and `EXECUTE` on every function, whose `EXECUTE` for PUBLIC is revoked;
the read role and PUBLIC get nothing. It is a rule over what the catalog holds, not a list of
pg-boss's tables. `readPrivilegeCatalog(db, schemas, roles, queueSchema?)` reads that schema's
relations and its functions (functions nowhere else). When the queue schema, or any object in it,
belongs to a role the owner cannot act for, nothing on the queue is planned and the plan reports
it apart (`plan.queue`: `schemaOwnedElsewhere`, `foreignOwned`) without being `blocked`. A queue
schema is pg-boss's alone: one that is also among `target.schemas` (`public`, `drizzle`, a project's
or a package's schema) would hold the project's tables to the queue rule, so the plan is `blocked`
with `plan.queue.managedSchema` and plans nothing at all for that schema; the CLI's grant step then
names the schema and asks for one of the queue's own in `"spfn": { "jobs": { "schema": … } }`.
Partitioned queues (`createQueue(name, { partition: true })`) attach a table to `job`, which only
its owner may do: under split roles the app role cannot create one.
`checkAppPrivileges(db, target, read?)`, on the app role's connection, reads the catalog for the app
role and the read role — the managed schemas and the queue schema with its functions, as the step
reads them (`readManagedObjects`) — and returns the plan as far as it concerns what the app role can
do (`AppPrivilegesCheck`); the owner, whom the app cannot name, is taken to own every schema, so a
queue the owner installed is compared by the queue's rule, and one the app role owns is reported
in `ownedSchemas`. `compareAppPrivileges(catalog, target, roles)` is its pure half, on a
`PrivilegeCatalog` read as the app (no role taken for the owner, no relation foreign-owned). The plan carries the comparison its
statements are written from: `changes` (`GranteeChange` per relation and grantee) and `withoutUsage`. `foreignOwnedObjects(db, schemas)` is the catalog read
of what another role owns — schemas, relations and enum types — shared with `spfn db push`'s
ownership remedy; `foreignOwnedObjects(db, schemas, queueSchema)` adds the functions of the queue
schema (`FUNCTION`, its `object` with its argument types), and of no other: a project's trigger
function is nothing push or the grant step alters.

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

The typed error keeps the converted error as its `cause` (non-enumerable, so `toJSON()` does not
answer it), and a log line describes the database error under it. Its own message is the driver's
only where `describeError` keeps that (see the logger README: a SQLSTATE class whose messages
name identifiers only, raised by a known server routine); otherwise it is a fixed text for the
class — a class-22 message quotes the rejected input:

| SQLSTATE class | Message when the driver's is not kept |
|----------------|---------------------------------------|
| `08` | `Database connection failed` |
| `22` | `Invalid input value` |
| `23` | `Integrity constraint violated` (`DuplicateEntryError` builds its own: `<field> already exists`) |
| `28` | `Database authentication failed` |
| `40` | `Transaction failed` |
| `42` | `Invalid query` |
| `53` | `Insufficient database resources` |
| `57` | `Database operation interrupted` |
| a postgres.js connection code (`CONNECTION_CLOSED`, …) | `Database connection lost` |
| anything else, or no code | `Database query failed` |

`databaseErrorMessage(error)` is that text without the typed error: the driver's message where
`describeError` keeps it, else the class's text above. The SQLSTATE is read from the description,
so a drizzle query error over a driver error gets its class's text. Use it where a database error is
shown to a person — the `spfn` CLI prints a failed statement with it:

```typescript
import { databaseErrorMessage } from '@spfn/core/db';

databaseErrorMessage(error); // 'Invalid input value' for a 22P02, never the rejected input
```

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
  `collectMigrationStatus`, `pendingFunctionMigrations`, `pendingMigrationTargets`,
  `countPendingMigrations`. Beside them, `readJobsDeclaration(cwd?)` reads the app's jobs
  declaration from its `package.json` — `"spfn": { "jobs": true }` for the queue schema
  `spfn_queue` (`DEFAULT_QUEUE_SCHEMA`), `"spfn": { "jobs": { "schema": "<name>" } }` for another
  — and returns `{ schema }`, or undefined without the key or without a `package.json` at all (a
  directory or image holding only the build and its migrations declares nothing); a file there
  that it cannot read or parse, a
  value that is neither (an unknown key inside `spfn.jobs` included), or `public` or `drizzle` as
  the schema throws `JobsDeclarationError` naming the file and the key. Whether another schema is
  a package's the file cannot tell (a package's name does not say whether it creates one, and a
  package installed through another is not listed), so the app privileges plan, which knows
  every managed schema, refuses those (`plan.queue.managedSchema`). A misspelt `jobs`
  (`"spfn": { "job": true }`, a top-level `"jobs"`) reads as no declaration: `spfn` and the file
  hold other tools' keys, and no rule tells a typo from one of theirs. A key written twice reads
  as `JSON.parse`, npm and pnpm read it, the last one winning. A schema name is exactly
  `[a-z_][a-z0-9_]{0,49}` (`isQueueSchemaName`) — narrower than pg-boss's own check, which also
  takes upper case: pg-boss puts the name in its SQL unquoted, so PostgreSQL folds `MyQueue` to
  `myqueue`, while the catalog and a quoted identifier read it as written; with lower case only,
  the name declared, the name pg-boss's SQL creates and the name the catalog is asked about are
  one. Nor is it a name that SQL breaks on: a PostgreSQL keyword other than an unreserved one
  (`select`, `left`, `between` — the reserved, type or function name and column name keywords
  of PostgreSQL 16, each of which fails pg-boss's install there) or a `pg_` name, which
  PostgreSQL keeps for system schemas. An app whose `.jobs()` names `MyQueue` declares `myqueue`. Read-only — applying migrations is `spfn db migrate`. One
  implementation behind `spfn db status`, the server's migration boot gate, the detailed
  health payload, the `spfn db push` preview and every function-package apply, so they
  cannot disagree about what "pending" means. A function package's legacy records in the
  shared `drizzle.__spfn_fn_migrations` table are read, never written or dropped. The
  project's own migrations are decided by drizzle-orm's `getMigrationsToRun`, the call
  `spfn db migrate` makes (see "Database roles" above).

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
  pass `set` explicitly (e.g. a `sql\`…\`` expression; never `updatedAt`) when the conflict
  update should differ from the insert. On a `timestamps()` table every Drizzle `update()`
  and every upsert sets `updated_at = now()` from the database clock; only raw SQL you write
  yourself says `updated_at = now()`.

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
    message: string;            // '<Repository>.<method> failed'
    cause?: Error;              // the caught error (same as originalError)
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
