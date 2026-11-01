/**
 * Schema Helper Functions
 *
 * Common field patterns for Drizzle ORM entities to reduce boilerplate.
 *
 * @example
 * ```typescript
 * import { pgTable, text } from 'drizzle-orm/pg-core';
 * import { id, timestamps } from '@spfn/core';
 *
 * export const users = pgTable('users', {
 *     id: id(),
 *     email: text('email').unique(),
 *     ...timestamps(),
 * });
 * ```
 */

import { sql } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { bigserial, bigint as pgBigint, timestamp, text, uuid as pgUuid, jsonb } from 'drizzle-orm/pg-core';
import { registerTenantColumn } from '../tenant/registry';

/**
 * Standard auto-incrementing primary key
 *
 * @returns bigserial primary key column
 *
 * @example
 * ```typescript
 * export const users = pgTable('users', {
 *     id: id(),
 *     // ...
 * });
 * ```
 */
export function id()
{
    return bigserial('id', { mode: 'number' }).primaryKey();
}

/**
 * Tenant column for a table that many tenants share
 *
 * A not-null bigint holding the tenant's id. Declaring it is what makes the table
 * tenant-aware: TenantRepository requires it, adds `tenant = $id` to every query
 * it builds, and the development query warning checks hand-written queries for
 * it. A table may declare one.
 *
 * It does not create an index — a drizzle column cannot. Declare the table's
 * indexes in its third argument, each starting with the tenant column, so a
 * query that filters on the tenant reads only that tenant's part of the index.
 *
 * @param name - Column name (default `tenant_id`)
 * @returns not-null bigint column (JS `number`)
 *
 * @example
 * ```typescript
 * export const notes = schema.table('notes', {
 *     id: id(),
 *     tenantId: tenantKey(),
 *     title: text('title').notNull(),
 * }, (t) => [index('notes_tenant_id_idx').on(t.tenantId, t.id)]);
 * ```
 */
export function tenantKey(name: string = 'tenant_id')
{
    const builder = pgBigint(name, { mode: 'number' }).notNull();
    const buildable = builder as unknown as { build: (table: object) => Column };
    const build = buildable.build;

    buildable.build = function (this: unknown, table: object): Column
    {
        const column = build.call(this, table);

        registerTenantColumn(table, column);

        return column;
    };

    return builder;
}

/**
 * Standard timestamp fields (createdAt, updatedAt)
 *
 * Both fields are timezone-aware and come from the database clock, never from the
 * application process. On insert both take `now()` through their column default, so a
 * new row's two timestamps are equal. On update Drizzle sets `updated_at = now()` for
 * you — do not pass `new Date()` yourself.
 *
 * Stamping `updated_at` from the application would read a second clock: the app host
 * and the database host are the same machine in development and different machines in
 * production, so a row could record an update earlier than its own creation, and
 * ordering rows by `updated_at` would order by whichever host's clock ran ahead.
 *
 * `now()` is the transaction's start time, matching what `.defaultNow()` writes. It is
 * not a commit-order sequence — anything that needs a true sequence needs a sequence
 * column, not a timestamp.
 *
 * @returns Object with createdAt and updatedAt columns
 *
 * @example
 * ```typescript
 * export const users = pgTable('users', {
 *     id: id(),
 *     email: text('email'),
 *     ...timestamps(),
 * });
 *
 * // updated_at is stamped by the database — it is not named here
 * await db.update(users)
 *     .set({ email: 'new@example.com' })
 *     .where(eq(users.id, userId));
 * ```
 */
export function timestamps()
{
    return {
        createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
            .defaultNow()
            .notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
            .defaultNow()
            .notNull()
            .$onUpdate(() => sql`now()`),
    };
}

/**
 * Foreign key reference to another table
 *
 * Creates a bigint column with cascade delete.
 * Type-safe: ensures the reference points to a valid PostgreSQL column.
 *
 * @param name - Column name (e.g., 'author' creates 'author_id')
 * @param reference - Reference to parent table column
 * @param options - Optional foreign key options
 *
 * @example
 * ```typescript
 * import { users } from './users';
 *
 * export const posts = pgTable('posts', {
 *     id: id(),
 *     authorId: foreignKey('author', () => users.id),
 *     ...timestamps(),
 * });
 * ```
 */
export function foreignKey<T extends PgColumn>(
    name: string,
    reference: () => T,
    options?: { onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action' },
)
{
    return pgBigint(`${name}_id`, { mode: 'number' })
        .notNull()
        .references(reference, { onDelete: options?.onDelete ?? 'cascade' });
}

/**
 * Optional foreign key reference (nullable)
 *
 * Type-safe: ensures the reference points to a valid PostgreSQL column.
 *
 * @param name - Column name (e.g., 'author' creates 'author_id')
 * @param reference - Reference to parent table column
 * @param options - Optional foreign key options
 *
 * @example
 * ```typescript
 * export const posts = pgTable('posts', {
 *     id: id(),
 *     authorId: optionalForeignKey('author', () => users.id),
 * });
 * ```
 */
export function optionalForeignKey<T extends PgColumn>(
    name: string,
    reference: () => T,
    options?: { onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action' },
)
{
    return pgBigint(`${name}_id`, { mode: 'number' })
        .references(reference, { onDelete: options?.onDelete ?? 'set null' });
}

/**
 * UUID primary key
 *
 * Creates a UUID column as primary key with automatic default value generation.
 * Useful for distributed systems or when you need globally unique identifiers.
 *
 * @returns uuid primary key column with gen_random_uuid() default
 *
 * @example
 * ```typescript
 * export const sessions = pgTable('sessions', {
 *     id: uuid(),
 *     userId: foreignKey('user', () => users.id),
 *     ...timestamps(),
 * });
 * ```
 */
export function uuid()
{
    return pgUuid('id').defaultRandom().primaryKey();
}

/**
 * Audit fields for tracking record creators and updaters
 *
 * Adds createdBy and updatedBy fields for user tracking.
 * Typically stores user IDs, emails, or usernames.
 *
 * @returns Object with createdBy and updatedBy columns
 *
 * @example
 * ```typescript
 * export const posts = pgTable('posts', {
 *     id: id(),
 *     title: text('title'),
 *     ...timestamps(),
 *     ...auditFields(),
 * });
 *
 * // Usage in route
 * await db.insert(posts).values({
 *     title: 'New Post',
 *     createdBy: currentUser.email,
 * });
 * ```
 */
export function auditFields()
{
    return {
        createdBy: text('created_by'),
        updatedBy: text('updated_by'),
    };
}

/**
 * Publishing fields for content management
 *
 * Tracks when and by whom content was published.
 * Useful for CMS, blog posts, articles, etc.
 *
 * @returns Object with publishedAt and publishedBy columns
 *
 * @example
 * ```typescript
 * export const articles = pgTable('articles', {
 *     id: id(),
 *     title: text('title'),
 *     status: text('status'), // draft/published/archived
 *     ...publishingFields(),
 *     ...timestamps(),
 * });
 *
 * // Publishing an article
 * await db.update(articles)
 *     .set({
 *         status: 'published',
 *         publishedAt: new Date(),
 *         publishedBy: currentUser.email,
 *     })
 *     .where(eq(articles.id, articleId));
 * ```
 */
export function publishingFields()
{
    return {
        publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
        publishedBy: text('published_by'),
    };
}

/**
 * Custom verification timestamp field
 *
 * Creates a nullable timestamp field for tracking verification status.
 * Useful for email verification, phone verification, etc.
 *
 * @param fieldName - Field name in camelCase (e.g., 'emailVerified', 'phoneVerified')
 * @returns Object with verification timestamp column (converts to snake_case + '_at')
 *
 * @example
 * ```typescript
 * export const users = pgTable('users', {
 *     id: id(),
 *     email: text('email'),
 *     phone: text('phone'),
 *     ...verificationTimestamp('emailVerified'),  // emailVerifiedAt -> email_verified_at
 *     ...verificationTimestamp('phoneVerified'),  // phoneVerifiedAt -> phone_verified_at
 *     ...timestamps(),
 * });
 *
 * // Verify email
 * await db.update(users)
 *     .set({ emailVerifiedAt: new Date() })
 *     .where(eq(users.email, userEmail));
 * ```
 */
export function verificationTimestamp(fieldName: string)
{
    // Convert camelCase to snake_case and add '_at' suffix
    const columnName = fieldName
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase()
        .replace(/^_/, '') + '_at';

    return {
        [fieldName + 'At']: timestamp(columnName, { withTimezone: true, mode: 'date' }),
    };
}

/**
 * Soft delete fields
 *
 * Adds deletedAt and deletedBy for logical deletion.
 * Records are marked as deleted instead of being physically removed.
 *
 * @returns Object with deletedAt and deletedBy columns
 *
 * @example
 * ```typescript
 * export const posts = pgTable('posts', {
 *     id: id(),
 *     title: text('title'),
 *     ...timestamps(),
 *     ...softDelete(),
 * });
 *
 * // Soft delete
 * await db.update(posts)
 *     .set({
 *         deletedAt: new Date(),
 *         deletedBy: currentUser.email,
 *     })
 *     .where(eq(posts.id, postId));
 *
 * // Query only non-deleted records
 * const activePosts = await db.select()
 *     .from(posts)
 *     .where(isNull(posts.deletedAt));
 * ```
 */
export function softDelete()
{
    return {
        deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
        deletedBy: text('deleted_by'),
    };
}

/**
 * UTC timestamp field
 *
 * Creates a timezone-aware timestamp column (TIMESTAMPTZ) that stores values in UTC.
 * PostgreSQL automatically converts between client timezone and UTC.
 * Chain with .notNull(), .defaultNow(), etc. for additional constraints.
 *
 * @param fieldName - Database column name (in snake_case)
 * @param mode - Data type mode: 'date' (Date object) or 'string' (ISO string)
 * @returns Timestamp column with timezone support
 *
 * @example
 * ```typescript
 * export const users = pgTable('users', {
 *     id: id(),
 *     email: text('email'),
 *
 *     // Nullable timestamp
 *     emailVerifiedAt: utcTimestamp('email_verified_at'),
 *
 *     // Required with default
 *     lastLoginAt: utcTimestamp('last_login_at').defaultNow().notNull(),
 *
 *     // String mode
 *     processedAt: utcTimestamp('processed_at', 'string'),
 *
 *     ...timestamps(),
 * });
 * ```
 */
export function utcTimestamp(
    fieldName: string,
    mode: 'date' | 'string' = 'date',
) 
{
    return timestamp(fieldName, {
        withTimezone: true,
        mode,
    });
}

/**
 * Type-safe enum text field
 *
 * Creates a text column with enum constraint.
 * Chain with .notNull(), .default(), etc. for additional constraints.
 *
 * @param fieldName - Database column name (e.g., 'status', 'role', 'provider')
 * @param values - Const array of allowed values
 * @returns Text column with enum constraint
 *
 * @example
 * ```typescript
 * export const USER_STATUSES = ['active', 'inactive', 'suspended'] as const;
 * export type UserStatus = typeof USER_STATUSES[number];
 *
 * export const SOCIAL_PROVIDERS = ['google', 'github', 'kakao'] as const;
 * export type SocialProvider = typeof SOCIAL_PROVIDERS[number];
 *
 * export const users = pgTable('users', {
 *     id: id(),
 *     // Nullable
 *     role: enumText('role', USER_STATUSES),
 *
 *     // Required
 *     provider: enumText('provider', SOCIAL_PROVIDERS).notNull(),
 *
 *     // Required with default
 *     status: enumText('status', USER_STATUSES).default('active').notNull(),
 *
 *     ...timestamps(),
 * });
 * ```
 */
export function enumText<T extends readonly [string, ...string[]]>(
    fieldName: string,
    values: T,
)
{
    // readonly를 제거하되 타입 정보는 유지
    return text(fieldName, { enum: values as T & [string, ...string[]] });
}

/**
 * Type-safe JSONB field
 *
 * Creates a JSONB column with required type parameter to ensure type safety.
 * Prevents the common mistake of using jsonb without type annotation,
 * which would result in `unknown` type and require type assertions.
 *
 * Chain with .notNull(), .default(), etc. for additional constraints.
 *
 * @param fieldName - Database column name (in snake_case)
 * @returns JSONB column with specified type
 *
 * @example
 * ```typescript
 * // Define your types
 * type LabelValue =
 *   | { type: 'text'; content: string }
 *   | { type: 'image'; url: string; alt?: string };
 *
 * type CachedContent = Record<string, LabelValue>;
 *
 * export const cmsPublishedCache = pgTable('published_cache', {
 *     id: id(),
 *     section: text('section').notNull(),
 *
 *     // Type-safe JSONB field - no more `as any` needed!
 *     content: typedJsonb<CachedContent>('content').notNull(),
 *
 *     ...timestamps(),
 * });
 *
 * // Usage in route - no type assertion needed
 * const cache = await db.select().from(cmsPublishedCache)...;
 * const labels = cache.content; // Type: CachedContent ✅
 *
 * // For simple objects
 * metadata: typedJsonb<Record<string, any>>('metadata'),
 *
 * // For arrays
 * tags: typedJsonb<string[]>('tags').notNull(),
 * ```
 */
export function typedJsonb<T>(fieldName: string)
{
    return jsonb(fieldName).$type<T>();
}
