/**
 * Repositories over the tenancy fixtures, as an app would write them
 *
 * The `direct*` methods are hand-written queries on `this.db`: TenantRepository
 * does not scope them, so they show what the row-level security policy does on
 * its own.
 */

import { asc, eq, sql } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { BaseRepository } from '../../repository';
import { TenantRepository } from '../tenant-repository';
import { authors, memos, notes, workspaces } from './tenancy-fixtures';

type NewNote = Omit<InferInsertModel<typeof notes>, 'tenantId'>;

export class NoteRepository extends TenantRepository
{
    list(tenantId: number)
    {
        return this._findMany(tenantId, notes, { orderBy: asc(notes.id) });
    }

    create(tenantId: number, data: NewNote)
    {
        return this._create(tenantId, notes, data as InferInsertModel<typeof notes>);
    }

    titlesWithAuthor(tenantId: number)
    {
        return this._select(tenantId, { id: notes.id, title: notes.title, author: authors.name })
            .from(notes)
            .innerJoin(authors, eq(notes.authorId, authors.id))
            .orderBy(asc(notes.id));
    }

    remove(tenantId: number, id: number)
    {
        return this._deleteOne(tenantId, notes, { id });
    }

    directNotes()
    {
        return this.db.select().from(notes).orderBy(asc(notes.id));
    }

    directNotesOf(tenantId: number)
    {
        return this.db.select().from(notes).where(eq(notes.tenantId, tenantId));
    }

    directInsert(row: InferInsertModel<typeof notes>)
    {
        return this.db.insert(notes).values(row).returning();
    }

    /** `app.tenant_id` and the backend serving this call; '' or null when unset. */
    async session(): Promise<{ tenant: string | null; pid: number }>
    {
        const rows = await this.db.execute(sql`select current_setting('app.tenant_id', true) as tenant, pg_backend_pid() as pid`);

        return (rows as unknown as { tenant: string | null; pid: number }[])[0];
    }
}

export class AuthorRepository extends TenantRepository
{
    create(tenantId: number, name: string)
    {
        return this._create(tenantId, authors, { name } as InferInsertModel<typeof authors>);
    }

    remove(tenantId: number, id: number)
    {
        return this._deleteOne(tenantId, authors, { id });
    }
}

export class MemoRepository extends TenantRepository
{
    list(tenantId: number)
    {
        return this._findMany(tenantId, memos, { orderBy: asc(memos.id) });
    }
}

export class WorkspaceRepository extends BaseRepository
{
    remove(id: number)
    {
        return this.db.delete(workspaces).where(eq(workspaces.id, id)).returning();
    }
}
