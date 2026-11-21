# Entities

Define your Drizzle ORM entities here. These are your database table schemas.

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

Create entity files with Drizzle's `pgTable` and SPFN's column helpers from
`@spfn/core/db`, as `example.entity.ts` does:

```typescript
// src/server/entities/users.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from '@spfn/core/db';

export const users = pgTable('users', {
    id: id(),                 // bigserial primary key
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    ...timestamps(),          // createdAt + updatedAt, timezone-aware
});

// Type inference for TypeScript
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

`timestamps()` stamps both columns from the database clock. Never write `updatedAt`:
every Drizzle `update()` and every `onConflictDoUpdate` sets `updated_at = now()` for you;
only raw SQL you write yourself says `updated_at = now()`.

## Entity with Relationships

```typescript
// src/server/entities/posts.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { foreignKey, id, timestamps } from '@spfn/core/db';
import { users } from './users';

export const posts = pgTable('posts', {
    id: id(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    authorId: foreignKey('author', () => users.id),   // author_id bigint, on delete cascade
    ...timestamps(),
});

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
```

## Indexes and Constraints

Use the array callback pattern to define indexes and constraints:

```typescript
// src/server/entities/products.ts
import { pgTable, text, numeric, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, timestamps } from '@spfn/core/db';

export const products = pgTable('products', {
    id: id(),
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    categoryId: bigint('category_id', { mode: 'number' }),
    ...timestamps(),
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
# Development: create or alter the tables from your entities
npx spfn db push

# Migration-based deployment: generate a migration from your entities, then apply it
npx spfn db generate
npx spfn db migrate
```

## Learn More

- [Getting Started](https://spfn.dev/docs/getting-started)
- [Routing Guide](https://spfn.dev/docs/routing)
- [Database Helpers](https://spfn.dev/docs/database)
- [Transaction Management](https://spfn.dev/docs/transactions)