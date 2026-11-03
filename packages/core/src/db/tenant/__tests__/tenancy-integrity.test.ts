/**
 * Tenancy integrity — rows I1–I7 of the #158 part 2 design case table, and
 * I8–I10 of the #159/#160 design (a required reference with `onDelete: 'restrict'`)
 *
 * The foreign keys `tenancy.table` and `tenancy.reference` generate, exercised
 * through TenantRepository as the app role. Skips when no test database is
 * available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTenancyDb } from './tenancy-db';
import { TENANCY_SCHEMA } from './tenancy-fixtures';
import { AuthorRepository, NoteRepository, WorkspaceRepository } from './tenancy-repositories';

/** The database's message for a query that failed; drizzle wraps it as the cause. */
async function failureOf(query: PromiseLike<unknown>): Promise<string>
{
    const error = await Promise.resolve(query).then(() => undefined, (reason: unknown) => reason as Error & { cause?: Error });

    return error?.cause?.message ?? error?.message ?? 'no failure';
}

describe('tenancy integrity (app role, integration)', () =>
{
    const db = createTenancyDb();
    const noteRepository = new NoteRepository();
    const authorRepository = new AuthorRepository();
    const workspaceRepository = new WorkspaceRepository();

    /** `table`'s rows as `id:tenant`, read by the owner. */
    const rowsOf = async (table: string) =>
        (await db.owner.unsafe(`select id, tenant_id from ${TENANCY_SCHEMA}.${table} order by id`))
            .map((row) => `${row.id}:${row.tenant_id}`);

    beforeAll(async () =>
    {
        await db.setup();
    });

    beforeEach(async () =>
    {
        if (!db.isAvailable) return;

        await db.seed();
    });

    afterAll(async () =>
    {
        await db.teardown();
    });

    it('I1 a row for a tenant missing from the tenant list is refused by its foreign key', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(authorRepository.create(8, 'Nobody')))
            .toMatch(/violates foreign key constraint "authors_tenant_id_fk"/);
        expect(await rowsOf('authors')).toEqual(['1:7', '2:9', '3:7']);
    });

    it('I2 a tenant 7 note pointing at a tenant 9 author is refused by the composite foreign key', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(noteRepository.create(7, { authorId: 2, title: 'cross' })))
            .toMatch(/violates foreign key constraint "notes_author_fk"/);
        expect(await rowsOf('notes')).toEqual(['1:7', '2:7', '3:9']);
    });

    it('I3 a note pointing at an author of the same tenant is stored', async () =>
    {
        if (!db.isAvailable) return;

        const note = await noteRepository.create(7, { authorId: 3, title: 'same tenant' });

        expect(note).toMatchObject({ tenantId: 7, authorId: 3 });
        expect(await rowsOf('notes')).toContain(`${note.id}:7`);
    });

    it('I4 deleting a workspace that still has rows is refused; workspace and rows stay', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(workspaceRepository.remove(7))).toMatch(/violates foreign key constraint "authors_tenant_id_fk"/);
        expect((await db.owner`select id from ${db.owner(TENANCY_SCHEMA)}.workspaces order by id`).map((row) => Number(row.id)))
            .toEqual([7, 9, 11]);
        expect(await rowsOf('notes')).toEqual(['1:7', '2:7', '3:9']);
    });

    it('I5 deleting an author deletes the notes that require it, and no other tenant\'s rows', async () =>
    {
        if (!db.isAvailable) return;

        await authorRepository.remove(7, 1);

        expect(await rowsOf('authors')).toEqual(['2:9', '3:7']);
        expect(await rowsOf('notes')).toEqual(['3:9']);
    });

    it('I6 an optional reference left null is stored', async () =>
    {
        if (!db.isAvailable) return;

        const note = await noteRepository.create(7, { authorId: 1, reviewerId: null, title: 'unreviewed' });

        expect(note.reviewerId).toBeNull();
    });

    it('I7 deleting an author an optional reference points at is refused; author and note stay', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(authorRepository.remove(7, 3))).toMatch(/violates foreign key constraint "notes_reviewer_fk"/);
        expect(await rowsOf('authors')).toEqual(['1:7', '2:9', '3:7']);
        expect(await rowsOf('notes')).toEqual(['1:7', '2:7', '3:9']);
    });

    it('I8 deleting a note a restrict reference points at is refused; note and revision stay', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(noteRepository.remove(9, 3))).toMatch(/violates foreign key constraint "revisions_note_fk"/);
        expect(await rowsOf('notes')).toEqual(['1:7', '2:7', '3:9']);
        expect(await rowsOf('revisions')).toEqual(['1:9']);
    });

    it('I9 deleting a note no revision points at succeeds; other notes and the revision stay', async () =>
    {
        if (!db.isAvailable) return;

        await noteRepository.remove(7, 1);

        expect(await rowsOf('notes')).toEqual(['2:7', '3:9']);
        expect(await rowsOf('revisions')).toEqual(['1:9']);
    });

    it('I10 a cascade that reaches a restrict reference refuses the whole delete; author, note and revision stay', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(authorRepository.remove(9, 2))).toMatch(/violates foreign key constraint "revisions_note_fk"/);
        expect(await rowsOf('authors')).toEqual(['1:7', '2:9', '3:7']);
        expect(await rowsOf('notes')).toEqual(['1:7', '2:7', '3:9']);
        expect(await rowsOf('revisions')).toEqual(['1:9']);
    });
});
