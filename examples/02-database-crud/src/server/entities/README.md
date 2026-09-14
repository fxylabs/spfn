# Entities

Define your Drizzle ORM entities here. These are your database table schemas.

## What is already in this directory

| File | Role |
| --- | --- |
| `example.entity.ts` | The `examples` table this app's repository and routes use |
| `config.ts` | Entity registry — read only when this folder holds no entity file (see below) |

`example.entity.ts` uses SPFN's column helpers rather than hand-written columns —
prefer these in new entities so every table gets the same primary key and timestamps:

```typescript
// src/server/entities/example.entity.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from '@spfn/core/db';

export const examples = pgTable('examples', {
    id: id(),                 // bigserial primary key
    name: text('name').notNull(),
    description: text('description').notNull(),
    ...timestamps(),          // createdAt + updatedAt, timezone-aware
});

export type Example = typeof examples.$inferSelect;
export type NewExample = typeof examples.$inferInsert;
```

## Which files are the schema

Every `.ts` file in this folder is part of the schema that `spfn db push`, `db generate`
and `db studio` work with; barrel files (`index.ts`, `config.ts`) are skipped. Nothing
needs registering while the entity files live here.

`config.ts` is the entity registry. It is loaded alone, and only what it exports is the
schema, when the tables live elsewhere: this folder holds no entity file, or the
registry exports a table no file here defines. If a file here defines a table the
registry does not export at the same time, the command stops and names both, since
neither alone would be the whole schema. Re-export with `export *` so a `pgEnum` or
`pgSchema` defined next to a table comes along:

```typescript
// src/server/entities/config.ts
export * from '../(workspace)/entities/example.entity';
```

`DRIZZLE_SCHEMA_PATH` names a different registry file. To name the schema outright, add
a `drizzle.config.ts` (read before the folder scan) or pass `spfn db push --schema <path>`.

## Defining Entities

The examples below are plain Drizzle, spelling out what `id()` and `timestamps()`
generate for you.

Create entity files using Drizzle ORM's `pgTable` for the public schema:

```typescript
// src/server/entities/users.ts
import { sql } from 'drizzle-orm';
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
        .$onUpdate(() => sql`now()`),
});

// Type inference for TypeScript
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

## Entity with Relationships

```typescript
// src/server/entities/posts.ts
import { sql } from 'drizzle-orm';
import { pgTable, serial, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { users } from './users';

export const posts = pgTable('posts', {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
        .$onUpdate(() => sql`now()`),
});

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
```

## Indexes and Constraints

Use the array callback pattern to define indexes and constraints:

```typescript
// src/server/entities/products.ts
import { pgTable, serial, text, numeric, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const products = pgTable('products', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    categoryId: integer('category_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    // Simple index on single column
    index('products_name_idx').on(table.name),

    // Unique index
    uniqueIndex('products_sku_unique_idx').on(table.sku),

    // Composite index on multiple columns
    index('products_category_price_idx').on(table.categoryId, table.price),

    // Index on expression (PostgreSQL)
    index('products_name_lower_idx').on(sql`lower(${table.name})`),
]);
```

**Common index patterns:**
- `index('name')` - Standard B-tree index
- `uniqueIndex('name')` - Unique constraint with index
- Composite indexes - Order columns by selectivity (most selective first)
- Lowercase indexes - For case-insensitive searches

## Database Migration

```bash
# Generate migration from your entities → src/server/drizzle/
pnpm spfn db generate

# Run migrations
pnpm spfn db migrate

# See which migrations are applied vs pending
pnpm spfn db status
```

## Learn More

- [Schema & column helpers](../../../../../packages/core/src/db/schema/README.md) — `id()`, `timestamps()`, `foreignKey()`
- [Database package](https://superfunction.xyz/docs/packages/core/db)
- [Transactions](https://superfunction.xyz/docs/packages/core/db/transaction)
- [Routing](https://superfunction.xyz/docs/packages/core/route)
- [Full-stack tutorial](https://superfunction.xyz/docs/tutorial)