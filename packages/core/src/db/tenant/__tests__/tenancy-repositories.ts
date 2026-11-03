/**
 * Repositories over the tenancy fixtures, as an app would write them
 *
 * The `direct*` methods are hand-written queries on `this.db`: TenantRepository
 * does not scope them, so they show what the row-level security policy does on
 * its own.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { BaseRepository } from '../../repository';
import { runInTransaction } from '../../transaction';
import { TenantRepository } from '../tenant-repository';
import { authors, members, memos, notes, workspaces } from './tenancy-fixtures';

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

    /** `app.tenant_id`, `app.user_id` and the backend serving this call; '' or null when unset. */
    async session(): Promise<{ tenant: string | null; user: string | null; pid: number }>
    {
        const rows = await this.db.execute(sql`select current_setting('app.tenant_id', true) as tenant, current_setting('app.user_id', true) as user, pg_backend_pid() as pid`);

        return (rows as unknown as { tenant: string | null; user: string | null; pid: number }[])[0];
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

/** The membership table: by tenant through the inherited methods, by person through `_selectOfUser`. */
export class MemberRepository extends TenantRepository
{
    async isMember(workspaceId: number, userId: number): Promise<boolean>
    {
        return await this._findOne(workspaceId, members, { userId, status: 'active' }) !== null;
    }

    membershipsOf(userId: number)
    {
        return this._selectOfUser(userId, { id: members.id, tenantId: members.tenantId })
            .from(members)
            .orderBy(asc(members.id));
    }

    workspacesOf(userId: number)
    {
        return this._selectOfUser(userId, { id: workspaces.id, name: workspaces.name })
            .from(members)
            .innerJoin(workspaces, eq(members.tenantId, workspaces.id))
            .orderBy(asc(workspaces.id));
    }

    /** The bare builders, for the rows that check what they accept. */
    ofUser(userId: number)
    {
        return this._selectOfUser(userId);
    }

    ofTenant(tenantId: number)
    {
        return this._select(tenantId, { id: members.id }).from(members).orderBy(asc(members.id));
    }

    activeOf(userId: number)
    {
        return this._selectOfUser(userId, { id: members.id })
            .from(members)
            .where(and(eq(members.status, 'active'), eq(members.role, 'member')))
            .orderBy(asc(members.id));
    }

    directMembers()
    {
        return this.db.select({ id: members.id }).from(members).orderBy(asc(members.id));
    }
}

/** The tenant list: a plain repository. Its update and delete policies need the tenant bound. */
export class WorkspaceRepository extends BaseRepository
{
    remove(id: number)
    {
        return runInTransaction(() => this.db.delete(workspaces).where(eq(workspaces.id, id)).returning(), { tenant: id });
    }

    /** Rename on whatever transaction is open — a guarded route binds it to the tenant. */
    rename(id: number, name: string)
    {
        return this.db.update(workspaces).set({ name }).where(eq(workspaces.id, id)).returning({ id: workspaces.id });
    }
}
