# @spfn/core/db/schema — Drizzle entity column helpers & schema namespacing

Reusable column-definition helpers and package-scoped PostgreSQL schema utilities for
defining Drizzle ORM entities (`pgTable`) with consistent, type-safe boilerplate.

## Import paths

There is **no** `@spfn/core/db/schema` subpath export. Everything in this module is
re-exported from `@spfn/core/db`. Import from there.

```typescript
import {
    id, uuid, timestamps,
    foreignKey, optionalForeignKey,
    auditFields, publishingFields, softDelete,
    verificationTimestamp, utcTimestamp, enumText, typedJsonb,
    createSchema, packageNameToSchema, getSchemaInfo,
} from '@spfn/core/db';

// Column primitives (text, integer, index, etc.) come from drizzle directly:
import { pgTable, text } from 'drizzle-orm/pg-core';
```

> There is **no** root `.` export for `@spfn/core`. `import { id } from '@spfn/core'`
> does **not** resolve — always use `@spfn/core/db`. (Some JSDoc examples in the source
> still show `from '@spfn/core'`; that is stale.)

---

## Public API (complete)

Column helpers (`entity-helper.ts`):

- `id()` — bigserial primary key
- `uuid()` — uuid primary key (`gen_random_uuid()`)
- `timestamps()` — `createdAt` + `updatedAt` (timestamptz, not null, both written by the database clock)
- `foreignKey(name, reference, options?)` — required FK (bigint, cascade by default)
- `optionalForeignKey(name, reference, options?)` — nullable FK (set null by default)
- `auditFields()` — `createdBy` + `updatedBy` (text, nullable)
- `publishingFields()` — `publishedAt` (timestamptz, nullable) + `publishedBy` (text)
- `softDelete()` — `deletedAt` (timestamptz, nullable) + `deletedBy` (text)
- `verificationTimestamp(fieldName)` — single nullable timestamptz, `{fieldName}At`
- `utcTimestamp(fieldName, mode?)` — single timestamptz column (chainable)
- `enumText(fieldName, values)` — text column with enum constraint (chainable)
- `typedJsonb<T>(fieldName)` — jsonb column typed as `T` (chainable)

Schema namespacing (`schema-helper.ts`):

- `createSchema(packageName)` → `PgSchema` (drizzle `pgSchema`) for `schema.table(...)`
- `packageNameToSchema(packageName)` → `string` schema name
- `getSchemaInfo(packageName)` → `{ schemaName, isScoped, scope }`

> The following **do not exist** in the current code — do not use them:
> `autoUpdateTimestamp()`, `statusEnum()`, the `timestamps({ autoUpdate })` option, and
> the `__autoUpdate` marker. Earlier docs referenced these; they were removed. For
> auto-updating `updatedAt`, set it manually (`.set({ updatedAt: new Date() })`) — the
> helpers do not auto-update it.

---

## Quick Start

```typescript
// src/server/entities/users.ts
import { pgTable, text, boolean } from 'drizzle-orm/pg-core';
import { id, timestamps, enumText } from '@spfn/core/db';

export const USER_ROLES = ['admin', 'user', 'guest'] as const;

export const users = pgTable('users', {
    id: id(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: enumText('role', USER_ROLES).notNull().default('user'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
});

// Type inference straight from the table
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

Spread helpers that return multiple columns (`timestamps()`, `auditFields()`,
`publishingFields()`, `softDelete()`, `verificationTimestamp()`); call directly the ones
that return a single column (`id()`, `uuid()`, `foreignKey()`, `enumText()`,
`utcTimestamp()`, `typedJsonb()`).

---

## Column helpers

### Primary keys — `id()`, `uuid()`

```typescript
id: id(),     // bigserial('id', { mode: 'number' }).primaryKey()  → bigserial PK
id: uuid(),   // uuid('id').defaultRandom().primaryKey()           → uuid PK
```

`id()` is the default. Use `uuid()` for distributed/public-facing IDs. Both produce a
column named `id`.

### `timestamps()`

```typescript
...timestamps(),
// createdAt: timestamptz, defaultNow(), notNull()
// updatedAt: timestamptz, defaultNow(), notNull(), $onUpdate(() => sql`now()`)
```

DB column names are `created_at` / `updated_at`. Both come from the database clock —
`now()` on insert through the column default, and `now()` again on update, which Drizzle
adds to the SET clause for you. **Do not pass `updatedAt` yourself:**

```typescript
await db.update(users)
    .set({ name: 'new' })   // updated_at = now() is added automatically
    .where(eq(users.id, userId));
```

An explicit value wins over the automatic one, so stamping `new Date()` reads a second
clock. In production the application host and the database host are different machines:
a row could then record an update earlier than its own creation, and ordering rows by
`updated_at` would order by whichever host's clock ran ahead.

`now()` is the transaction's start time. It is not a commit-order sequence — a sync
cursor or anything else that needs true ordering needs a sequence column, not a
timestamp.

### `foreignKey(name, reference, options?)` / `optionalForeignKey(...)`

```typescript
authorId:   foreignKey('author', () => users.id),         // author_id BIGINT NOT NULL, ON DELETE CASCADE
categoryId: optionalForeignKey('category', () => cats.id), // category_id BIGINT (nullable), ON DELETE SET NULL
```

- Column name is `{name}_id`. Both produce a **bigint** column (`mode: 'number'`) — pair
  with `id()` (bigserial), not `uuid()`.
- `options.onDelete`: `'cascade' | 'set null' | 'restrict' | 'no action'`. Defaults:
  `foreignKey` → `'cascade'`, `optionalForeignKey` → `'set null'`.
- There is **no** `onUpdate` option on these helpers. For `onUpdate` (or FK to a uuid PK),
  use drizzle's table-level `foreignKey({ columns, foreignColumns, onUpdate })` instead.

### `auditFields()`, `publishingFields()`, `softDelete()`

```typescript
...auditFields(),       // created_by TEXT, updated_by TEXT (nullable)
...publishingFields(),  // published_at TIMESTAMPTZ (nullable), published_by TEXT
...softDelete(),        // deleted_at TIMESTAMPTZ (nullable), deleted_by TEXT
```

Soft-delete query pattern — filter manually, there is no automatic scoping:

```typescript
await db.select().from(posts).where(isNull(posts.deletedAt));
```

### `verificationTimestamp(fieldName)`

Single nullable timestamptz. The JS property is `{fieldName}At`, the DB column is
`snake_case(fieldName) + '_at'`.

```typescript
...verificationTimestamp('emailVerified'),  // prop emailVerifiedAt → col email_verified_at
...verificationTimestamp('phoneVerified'),  // prop phoneVerifiedAt → col phone_verified_at
```

### `utcTimestamp(fieldName, mode?)`

Single timestamptz column. `fieldName` is the **DB column name** (snake_case, unlike
`verificationTimestamp`). `mode` is `'date'` (default, `Date`) or `'string'` (ISO string).
Chainable.

```typescript
scheduledAt: utcTimestamp('scheduled_at').notNull(),
lastLoginAt: utcTimestamp('last_login_at').defaultNow().notNull(),
processedAt: utcTimestamp('processed_at', 'string'),  // ISO string
```

### `enumText(fieldName, values)`

Text column constrained to a const tuple; the value type is inferred. Chainable.

```typescript
export const USER_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type UserStatus = typeof USER_STATUSES[number];

status: enumText('status', USER_STATUSES).notNull().default('active'),
```

Backing type is plain `text` (no PG enum type), so adding values needs **no migration**.

### `typedJsonb<T>(fieldName)`

jsonb column typed as `T` — avoids `unknown` / `as any` on reads. Chainable.

```typescript
type Metadata = { theme: 'light' | 'dark'; settings: Record<string, unknown> };

metadata: typedJsonb<Metadata>('metadata').notNull(),
tags:     typedJsonb<string[]>('tags'),
```

---

## Schema namespacing

Isolate a package's tables under a dedicated PostgreSQL schema so multiple SPFN packages
share one database without table-name collisions.

```typescript
import { createSchema, id, timestamps } from '@spfn/core/db';
import { text } from 'drizzle-orm/pg-core';

const schema = createSchema('@spfn/cms');   // PG schema: spfn_cms

export const labels = schema.table('labels', {
    id: id(),
    name: text('name').notNull(),
    ...timestamps(),
});
// → table  spfn_cms.labels
```

Naming rules (`packageNameToSchema`): strip `@`, replace `/` and `-` with `_`.

```typescript
packageNameToSchema('@spfn/cms');      // 'spfn_cms'
packageNameToSchema('@company/auth');  // 'company_auth'
packageNameToSchema('spfn-storage');   // 'spfn_storage'

getSchemaInfo('@spfn/cms');
// { schemaName: 'spfn_cms', isScoped: true, scope: 'spfn' }
```

Use `schema.table(...)` instead of `pgTable(...)` for every table in that package. The
column helpers above work identically inside `schema.table`.

---

## Pitfalls & anti-patterns

- **`@spfn/core/db/schema` is not an export path; `@spfn/core` (bare) has no root export
  either.** Import everything from `@spfn/core/db`.
- **`id` is bigint, not uuid.** `id()` and `foreignKey()`/`optionalForeignKey()` are all
  bigint-based. Don't point a `foreignKey()` (bigint) at a `uuid()` PK — types won't match.
  For a uuid FK, use drizzle's table-level `foreignKey({ columns, foreignColumns })`.
- **`timestamps()` takes no arguments and does not auto-update `updatedAt`.** Calls like
  `timestamps({ autoUpdate: true })` are from an old API and will fail/no-op. Set
  `updatedAt: new Date()` yourself on updates.
- **`autoUpdateTimestamp()`, `statusEnum()`, and the `__autoUpdate` marker do not exist.**
  Replace `statusEnum([...])` with `enumText('status', [...] as const).notNull().default(...)`.
- **`verificationTimestamp(name)` takes a camelCase logical name; `utcTimestamp(col)` takes
  a snake_case DB column name.** They differ — `verificationTimestamp('emailVerified')`
  yields column `email_verified_at`, but `utcTimestamp('emailVerified')` would create a
  column literally named `emailVerified`.
- **`enumText` is plain text + CHECK, not a PG enum type.** Adding values requires no
  migration; renaming/removing the column still does.
- **Exported tables must be reachable by drizzle-kit to land in migrations.** Entity
  files under `src/server/entities/` are found by the folder scan; tables kept elsewhere
  must be re-exported from the registry (`src/server/entities/config.ts → export * from
  '../(workspace)/entities/users'`), which `spfn db push`, `db generate` and `db studio`
  read when the folder holds no entity file. A table nothing reaches generates no migration.
- **When using `createSchema`, all tables in that package must use `schema.table(...)`.**
  Mixing `pgTable(...)` puts that table in the default `public` schema.
- **Do not re-export an installed function package's tables from the project registry.**
  A package that ships migrations (`@spfn/auth` → `spfn_auth`) owns its schema: it creates
  and alters those tables itself. `spfn db push` leaves them out of the project's diff, and
  `spfn db generate` refuses outright — the schema files it reads become a project migration,
  and a migration that recreates a package's table cannot run on a fresh database and
  collides with the package's own. A relation needs no re-export: `import { users } from
  '@spfn/auth/entities'` and reference it from your own table. Only re-export what the
  project itself defines.

---

## Complete example

```typescript
// src/server/entities/posts.ts
import { pgTable, text, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
    id, foreignKey, optionalForeignKey,
    enumText, typedJsonb,
    timestamps, auditFields, publishingFields, softDelete,
} from '@spfn/core/db';
import { users } from './users';

export const POST_STATUSES = ['draft', 'published', 'archived'] as const;
export type PostStatus = typeof POST_STATUSES[number];

type PostMeta = { seoTitle?: string; tags: string[] };

export const posts = pgTable('posts', {
    id: id(),
    title: text('title').notNull(),
    slug: text('slug').notNull().unique(),

    authorId:   foreignKey('author', () => users.id),                 // NOT NULL, cascade
    reviewerId: optionalForeignKey('reviewer', () => users.id),       // nullable, set null

    status: enumText('status', POST_STATUSES).notNull().default('draft'),
    meta:   typedJsonb<PostMeta>('meta'),

    ...timestamps(),
    ...auditFields(),
    ...publishingFields(),
    ...softDelete(),
}, (table) => [
    index('posts_status_idx').on(table.status),
    index('posts_active_idx').on(table.slug).where(sql`${table.deletedAt} is null`),
]);

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
```

```typescript
// src/server/entities/config.ts — the registry; must re-export so drizzle-kit sees every table
export * from './users';
export * from './posts';
export * from './relations';
```

Indexes, composite primary keys, unique/check constraints, and `relations()` are standard
drizzle features (table callback / `drizzle-orm`) — this module does not wrap them; use
drizzle directly.

---

## Types reference

```typescript
// foreignKey / optionalForeignKey options
type FkOptions = { onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action' };

// utcTimestamp mode
type UtcMode = 'date' | 'string';   // default 'date'

// enumText values
type EnumValues = readonly [string, ...string[]];

// getSchemaInfo return
type SchemaInfo = { schemaName: string; isScoped: boolean; scope: string | null };
```

Column return types are drizzle column builders (`PgColumn`-based); chain
`.notNull()`, `.default(...)`, `.unique()`, `.references(...)` as usual.

## Related

- [@spfn/core/db](../README.md) — DB manager, transactions, repository, postgres errors
- [Drizzle ORM](https://orm.drizzle.team/) — `pgTable`, `pgSchema`, indexes, relations
