---
title: "Multi-tenancy"
description: "Keep each workspace's (or each user's) rows apart with defineTenancy: composite foreign keys, a row-level security policy, a route guard, and per-tenant export and import"
order: 16
available: true
---

# Multi-tenancy

This guide takes you from an empty app to a feature whose data is kept apart per tenant by the
database itself. The rules behind each step are in the package READMEs; the guide links to them
instead of repeating them.

## Goal

At the end you will have:

- a `notes` feature where each workspace sees only its own notes;
- a database that refuses a query for another workspace's rows, even one written by hand;
- routes that answer 400 for a malformed workspace id and 403 for a workspace the caller is not a
  member of;
- a server that refuses to start in production when it could bypass that isolation;
- a command that copies one workspace out of the database and back in.

**What a tenant is.** A tenant is the owner of a set of rows. Pick it from who owns the data:

| The data belongs to | Tenant | Tenant list table |
| --- | --- | --- |
| an organisation, team or customer | the workspace | your own `workspaces` table |
| one person (a diary, settings, drafts) | the user | `users` from `@spfn/auth/server`, with a guard that resolves the signed-in user |

**When not to use it.** Public data that everyone reads, and rows shared by several people who
do not belong to one workspace (a direct message between two users, a shared document with a
list of collaborators), are ordinary tables. Check access in the app, in the route or the
service, as you would without tenancy.

## Before you start

- PostgreSQL 14 or later.
- An app on `@spfn/core` 0.3.0-beta.35 and `spfn` 0.3.0-beta.21 or later.
- `@spfn/auth` set up as in the [Authentication guide](./authentication.md); the examples read the
  signed-in user with `getAuth(c)`.
- `psql`, to create the roles and check each step.

The examples use a schema named `acme_notes` (`createSchema('@acme/notes')`), an owner role
`app_owner` and an app role `app_user`. Use your own names.

## Steps

### 1. Create two database roles

Row-level security (RLS) is a PostgreSQL feature: a policy attached to a table filters every
query on it, so a query that forgets its `WHERE tenant_id = …` still sees only one tenant's rows.
PostgreSQL does **not** apply a policy to the table's owner, to a superuser, or to a role with
`BYPASSRLS`. So the role that creates the tables and the role the server connects as must be
different:

| Role | Connects through | Does |
| --- | --- | --- |
| owner (`app_owner`) | `DATABASE_OWNER_URL` | runs `spfn db migrate`, `backup`, `restore`, `drop`; owns every table |
| app (`app_user`) | `DATABASE_URL` (and `DATABASE_WRITE_URL` / `DATABASE_READ_URL` if you use them) | runs the server; owns nothing, is not a superuser, has no `BYPASSRLS` |

As a superuser (on a local install, usually `postgres`), create both roles and the database:

```sql
CREATE ROLE app_owner LOGIN PASSWORD 'owner-password';
CREATE ROLE app_user LOGIN PASSWORD 'app-password' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE acme OWNER app_owner;
```

Then, connected to `acme` as `app_owner`, give the app role read and write access to everything
the owner creates from now on, in every schema — your own, `@spfn/auth`'s and the `drizzle`
schema where migrations are recorded (the server reads it at boot to check for pending
migrations):

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT USAGE ON SCHEMAS TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT USAGE ON SEQUENCES TO app_user;
```

Default privileges only cover objects created afterwards. In a database whose tables already
exist, grant them per schema as well, and move ownership off the app role if it created them —
see [Database roles](../../packages/core/src/db/README.md#database-roles) in the `@spfn/core` db
README.

Set both URLs in `.env.server`:

```bash
DATABASE_URL=postgresql://app_user:app-password@localhost:5432/acme
DATABASE_OWNER_URL=postgresql://app_owner:owner-password@localhost:5432/acme
```

`DATABASE_OWNER_URL` is read only by the four `spfn db` commands above; the server never uses
it. Without it, they fall back to `DATABASE_URL`
([config reference](../../packages/core/src/config/README.md)).

**Check:**

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user';
-- app_user | f | f
```

### 2. Declare the tenancy and its tables

`defineTenancy` names the tenant list table and the rule for who may act for a tenant.
`tenancy.table` builds a table that belongs to one tenant: it adds the `tenant_id` column, a
foreign key to the tenant list, a unique key on `(tenant_id, id)` and the RLS policy. Do not
declare the tenant column yourself; every tenancy table needs an `id`.

Keep the tenant list and the membership table in a module of their own, so the repository that
`authorize` calls does not import the module that calls it:

```typescript
// src/server/entities/workspaces.ts
import { createSchema, foreignKey, id } from '@spfn/core/db';
import { users } from '@spfn/auth/server';
import { text } from 'drizzle-orm/pg-core';

export const schema = createSchema('@acme/notes');

// The tenant list: one row per workspace. An ordinary table.
export const workspaces = schema.table('workspaces', {
    id: id(),
    name: text('name').notNull(),
});

// Who belongs to which workspace. Also ordinary: authorize reads it before any tenant is set.
export const workspaceMembers = schema.table('workspace_members', {
    id: id(),
    workspaceId: foreignKey('workspace', () => workspaces.id),
    userId: foreignKey('user', () => users.id),
});
```

```typescript
// src/server/entities/notes.ts
import { defineTenancy, id, timestamps } from '@spfn/core/db';
import { getAuth } from '@spfn/auth/server';
import { text } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { memberRepository } from '../repositories/member.repository';
import { schema, workspaces } from './workspaces';

export const tenancy = defineTenancy({
    tenants: workspaces,
    authorize: (c, workspaceId) => memberRepository.isMember(workspaceId, Number(getAuth(c).userId)),
});

export const authors = tenancy.table(schema, 'authors', {
    id: id(),
    name: text('name').notNull(),
});

export const notes = tenancy.table(schema, 'notes', {
    id: id(),
    authorId: tenancy.reference('author', () => authors),                            // required
    reviewerId: tenancy.reference('reviewer', () => authors, { optional: true }),    // may be null
    parentId: tenancy.reference('parent', (): PgTable => notes, { optional: true }), // a reply
    title: text('title').notNull(),
    ...timestamps(),
});
```

Export both modules from your entities file (`src/server/entities/config.ts` by default), as
for any other table.

`tenancy.reference('author', () => authors)` creates an `author_id` column whose foreign key is
`(tenant_id, author_id) → authors (tenant_id, id)`: a note can only point at an author of the
same workspace. The target is a function, so it may name a table defined further down; a
reference to the table itself (`parentId` above) spells out the return type `(): PgTable`.

| Reference | Column | When the referenced row is deleted |
| --- | --- | --- |
| required (default) | `NOT NULL` | the referencing rows are deleted too (`ON DELETE CASCADE`) |
| `{ optional: true }` | nullable | the delete is refused while a row still points at it (`NO ACTION`) |

`tenancy.reference` accepts only tables of the same tenancy. To point at an ordinary table, use
`foreignKey` as usual.

The `memberRepository` used by `authorize` is an ordinary repository:

```typescript
// src/server/repositories/member.repository.ts
import { BaseRepository } from '@spfn/core/db';
import { workspaceMembers } from '../entities/workspaces';

class MemberRepository extends BaseRepository
{
    async isMember(workspaceId: number, userId: number): Promise<boolean>
    {
        return await this._findOne(workspaceMembers, { workspaceId, userId }) !== null;
    }
}

export const memberRepository = new MemberRepository();
```

**Data owned by one person.** Use `users` as the tenant list, and let the guard (step 5) resolve
the signed-in user:

```typescript
import { getAuth, users } from '@spfn/auth/server';

export const personal = defineTenancy({
    tenants: users,
    authorize: (c, userId) => userId === Number(getAuth(c).userId),
});
```

**Check:** the server type-checks, and `pnpm spfn db generate` (next step) does not throw. A
reference to a table outside the tenancy, a declared `tenant_id` column or a table without `id`
throws there with the table's name.

### 3. Generate and apply the migration

```bash
pnpm spfn db generate
pnpm spfn db migrate
```

`db generate` writes the migration; `db migrate` applies it, connected as the owner through
`DATABASE_OWNER_URL`. For each tenancy table the SQL contains:

- the table with a `tenant_id bigint NOT NULL` column and `UNIQUE (tenant_id, id)`;
- `ENABLE ROW LEVEL SECURITY`;
- a foreign key from `tenant_id` to the tenant list, and one composite foreign key per reference;
- the policy `<table>_tenant_isolation`, which admits a row only when its `tenant_id` equals
  the connection's `app.tenant_id` setting.

The full SQL for `notes` is in the
[Tenancy section](../../packages/core/src/db/README.md#tenancy-definetenancy--tenant-tables-enforced-by-the-database)
of the db README.

**Check**, as the app role (`psql "$DATABASE_URL"`):

```sql
SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'acme_notes';
-- authors | authors_tenant_isolation
-- notes   | notes_tenant_isolation

SELECT * FROM acme_notes.notes;
-- ERROR: unrecognized configuration parameter "app.tenant_id"   ← no tenant set: refused

BEGIN;
SELECT set_config('app.tenant_id', '1', true);
SELECT count(*) FROM acme_notes.notes;   -- workspace 1's notes only
COMMIT;
```

The `ERROR` is the point: a connection that has not named a tenant gets an error, never another
tenant's rows.

### 4. Write the repository

A repository for tenancy tables extends `TenantRepository` instead of `BaseRepository`. Every
method takes the tenant id first and puts the tenant condition into the query, and the
repository sets `app.tenant_id` for you, so the policy and the query agree.

```typescript
// src/server/repositories/note.repository.ts
import { TenantRepository } from '@spfn/core/db';
import type { InferInsertModel } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { authors, notes } from '../entities/notes';

type NewNote = Omit<InferInsertModel<typeof notes>, 'tenantId'>;

class NoteRepository extends TenantRepository
{
    async list(workspaceId: number, after?: number)
    {
        return await this._findManyKeyset(workspaceId, notes, { cursorColumn: notes.id, after, limit: 50 });
    }

    async listWithAuthor(workspaceId: number)
    {
        return await this._select(workspaceId, { title: notes.title, author: authors.name })
            .from(notes)
            .innerJoin(authors, eq(notes.authorId, authors.id));
    }

    async create(workspaceId: number, data: NewNote)
    {
        return await this._create(workspaceId, notes, data as InferInsertModel<typeof notes>);
    }

    async rename(workspaceId: number, id: number, title: string)
    {
        return await this._updateOne(workspaceId, notes, { id }, { title });
    }
}

export const noteRepository = new NoteRepository();
```

Where each call runs depends on whether a transaction is open:

- **Outside a transaction**, each call opens a short transaction of its own, sets the tenant and
  commits: a read on the read connection (read-only), a write on the write connection.
- **Inside a transaction** (`Transactional()` on the route, or `runInTransaction`), the first call
  sets the tenant on that transaction, and every later call must name the same tenant. Naming
  another throws `TenantMismatchError` before any SQL runs.

Outside a request — a script, a job — name the tenant when you open the transaction:

```typescript
import { runInTransaction } from '@spfn/core/db';

await runInTransaction(async () =>
{
    const note = await noteRepository.create(42, { authorId: 7, title: 'Imported' });

    await noteRepository.rename(42, note.id, 'Imported (1)');
}, { tenant: 42 });
```

`this.db` and `this.readDb` are still there for queries the methods cannot express, but nothing
scopes them: inside a transaction bound to a tenant the policy shows that tenant's rows only, and
anywhere else they fail with the policy error. The method list and its rules are in
[TenantRepository](../../packages/core/src/db/README.md#tenantrepository-tenant--tables-shared-by-many-tenants).

**Check:** in development (`NODE_ENV` unset, `local` or `development`), a hand-written query on
a tenant table without a `tenant_id` condition logs a warning with its SQL. A clean log for your
feature means every query names its tenant.

### 5. Guard the routes

`tenancy.guard` reads the tenant id for the request, checks it, runs your `authorize` and binds
the rest of the request to that tenant. `tenancy.of(c)` returns it in the handler.

```typescript
// src/server/routes/notes.ts
import { route } from '@spfn/core/route';
import { Transactional } from '@spfn/core/db';
import { Type } from '@sinclair/typebox';
import { tenancy } from '../entities/notes';
import { noteRepository } from '../repositories/note.repository';

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
```

For data owned by one person, resolve the tenant from the session instead of a parameter:

```typescript
export const listDiaries = route.get('/me/diaries')
    .use([personal.guard({ resolve: (c) => Number(getAuth(c).userId) })])
    .handler(async (c) => diaryRepository.list(personal.of(c)));
```

Register the routes in your router as usual. The guard answers:

| Request | Answer |
| --- | --- |
| the id is not a positive integer (`/workspaces/abc/notes`) | **400**, `authorize` does not run |
| `authorize` returns anything but `true` | **403** |
| a handler calls a repository with a tenant other than the guarded one | `TenantMismatchError`, a **500**: a bug in the handler, not in the request |

The guard opens no transaction, so reads keep going to the read replica. Add `Transactional()`
to routes that write; the order of the two does not matter. Details:
[`tenancy.guard` and `tenancy.of`](../../packages/core/src/db/README.md#tenancyguard-and-tenancyof).

**Check:** as a member of workspace 1, `GET /workspaces/1/notes` answers your notes,
`GET /workspaces/2/notes` answers 403, and `GET /workspaces/0/notes` answers 400.

### 6. Start the server

When the app declares tenancy tables, the server checks at startup which role its write and read
connections use. If that role owns a tenancy table, is a superuser or has `BYPASSRLS`, the policy
does not apply to it and every query would see every tenant:

- in **production** (`NODE_ENV=production`) the server logs `Refusing to start: Tenancy tables
  are not isolated: …` and does not start;
- **anywhere else** it logs the same finding once as a warning and starts, because local
  development often connects as the `postgres` superuser.

The message names the role, the reason and the tables, never the connection string. If the check
itself cannot run, it logs one warning and the server starts. See the boot sequence in the
[server README](../../packages/core/src/server/README.md).

**Check:** with `DATABASE_URL` pointing at `app_user`, `pnpm spfn dev` starts without the
`Tenancy tables are not isolated` warning.

### 7. Export one tenant and import it elsewhere

```bash
pnpm spfn db tenant export 42
# → backups/tenant-42-<time>/   manifest.json and one .copy file per tenant table

pnpm spfn db tenant import backups/tenant-42-<time>             # target has no rows for tenant 42
pnpm spfn db tenant import backups/tenant-42-<time> --replace   # replace the rows it has
```

The export reads every tenant table in one snapshot as the app role (`DATABASE_READ_URL`, else
`DATABASE_URL`). It covers `tenancy.table` tables and `tenantKey()` tables alike, and nothing
else: not the tenant list row, not auth data. The import runs in one transaction as the owner
(`DATABASE_OWNER_URL`, else `DATABASE_URL`) and writes nothing if any check fails. The tenant must
already exist in the target's tenant list table — create workspace 42 there first.

**Put one tenant back to an earlier point in time**, leaving the others as they are:

1. Restore a copy of the production database to that point, outside spfn (your provider's
   point-in-time recovery).
2. Point the environment at the copy and run `spfn db tenant export 42`.
3. Point the environment at production and run `spfn db tenant import <folder> --replace`.
4. Only tenant 42's rows change; every other tenant's rows stay as they were.

The checks the import makes are listed in the [CLI README](../../packages/cli/README.md).

**Check:** the import prints one line per table with its row count, then
`✅ Tenant 42 imported`.

## Done when

- [ ] The server's `DATABASE_URL` role owns no table, is not a superuser and has no `BYPASSRLS`;
      `DATABASE_OWNER_URL` points at the owner.
- [ ] Every table that belongs to a tenant is a `tenancy.table`, and every reference between them
      is a `tenancy.reference`.
- [ ] `pg_policies` lists a `<table>_tenant_isolation` policy for each of them.
- [ ] Their repositories extend `TenantRepository`.
- [ ] Every route that touches them has `tenancy.guard`, and handlers take the tenant from
      `tenancy.of(c)`, never from the request body.
- [ ] Another workspace's id answers 403, a malformed one 400.
- [ ] `spfn dev` starts without the isolation warning.
- [ ] An export of one tenant imports into a fresh database with the same row counts.

## Reference

### Where a `TenantRepository` call runs

For a `tenancy.table`, each call follows one of six rules
([R1–R6 in the db README](../../packages/core/src/db/README.md#where-a-tenantrepository-query-runs-r1r6)):

| Rule | When | What happens |
| --- | --- | --- |
| R1 | a read, no transaction open | a short read-only transaction on the read connection sets the tenant, runs the query, commits |
| R2 | a write, no transaction open | the same, on the write connection |
| R3 | a transaction is open and has no tenant yet | the tenant is set on it; the transaction now belongs to that tenant |
| R4 | the open transaction belongs to this tenant | the query runs |
| R5 | the open transaction belongs to another tenant | `TenantMismatchError`, no SQL |
| R6 | the request's guard authorized another tenant | `TenantMismatchError`, no SQL |

The tenant setting ends with its transaction, so a pooled connection never carries it to the next
request. A table with only `tenantKey()` (no policy) skips R1–R3 and keeps R5 and R6.

### Errors

| Error | Where | Meaning |
| --- | --- | --- |
| 400 `ValidationError` | `tenancy.guard` | the tenant id is not a positive integer |
| 403 `ForbiddenError` | `tenancy.guard` | `authorize` did not return `true` |
| `TenantMismatchError` (500) | `TenantRepository`, `runInTransaction` | a call named a tenant other than its transaction's or its request's; `source` is `'transaction'` or `'guard'` |
| `unrecognized configuration parameter "app.tenant_id"` | PostgreSQL | a query on a tenancy table on a connection that never set a tenant |
| `invalid input syntax for type bigint: ""` | PostgreSQL | the same, on a pooled connection where an earlier transaction had set one: no tenant is set now |
| `tenancy.of(c) was called on a route without tenancy.guard()` | `tenancy.of` | add the guard to the route |
| `TenancyRoleError` | server start, production | the app role escapes the policy (step 6) |

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The policy error from a script or job | a hand-written query, or a call outside a transaction bound to a tenant | use `TenantRepository` methods, or wrap the work in `runInTransaction(fn, { tenant })` |
| Every query sees every tenant | the app role owns the tables, or is a superuser / `BYPASSRLS` | connect as `app_user`; move ownership with `ALTER TABLE … OWNER TO app_owner` or `REASSIGN OWNED BY app_user TO app_owner` |
| `permission denied for table …` after a migration | the app role has no privilege on a new table | set the default privileges of step 1, or grant on the table |
| The server logs `permission denied for schema drizzle` at boot and starts without checking migrations | the app role cannot read the `drizzle` schema, where migrations are recorded | grant `USAGE` on schema `drizzle` and `SELECT` on its tables to the app role |
| `spfn db backup` or `restore` fails on a tenancy table | it ran as the app role, to which the policy applies | set `DATABASE_OWNER_URL` |
| A workspace with notes cannot be deleted | the tenant foreign key is `NO ACTION` | delete or move the tenant's rows first |
| An author cannot be deleted | an optional reference still points at it | clear the reference first |
| `.prepare()` throws | a prepared statement would run outside R1–R6 | call the query without `.prepare()` |
| `rightJoin`, `fullJoin`, `union` … throw in `_select` | the tenant condition cannot be placed safely | write that query on `this.readDb`, inside a transaction bound to the tenant |
| `tenant import` refuses: tenant not in its tenant list | the target lacks the tenant row | create the workspace (or user) first |
| `tenant import` refuses: tenant already has rows | the target holds rows for it | add `--replace` |
| `tenant import --replace` refuses, naming foreign keys | a table outside the export would be changed by `ON DELETE CASCADE / SET NULL / SET DEFAULT` | handle those rows yourself first |
