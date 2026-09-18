/**
 * OAuth 2.1 Clients Repository
 *
 * Data access for dynamically registered public clients. Extends BaseRepository
 * for transaction context and read/write splitting like every other auth
 * repository.
 */

import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { BaseRepository, runInTransaction } from '@spfn/core/db';
import { oauth2Clients, type NewOAuth2Client, type OAuth2Client } from '../entities/oauth2-clients';
import { oauth2Grants } from '../entities/oauth2-grants';

export class OAuth2ClientsRepository extends BaseRepository
{
    async create(data: NewOAuth2Client): Promise<OAuth2Client>
    {
        const result = await this.db
            .insert(oauth2Clients)
            .values(data)
            .returning();

        return result[0]!;
    }

    /**
     * Lookup by the public `client_id` — the authorize and token paths.
     *
     * Reads the primary, not the replica, for the reason the ops-token lookup
     * does: a client registered a moment ago is immediately used, and a replica
     * read would answer "unknown client" for the length of the replication lag,
     * at the one moment a CLI is being connected.
     */
    async findByClientId(clientId: string): Promise<OAuth2Client | null>
    {
        const result = await this.db
            .select()
            .from(oauth2Clients)
            .where(eq(oauth2Clients.clientId, clientId))
            .limit(1);

        return result[0] ?? null;
    }

    /** Fire-and-forget from the token-issuing path. */
    async updateLastUsedById(id: number): Promise<void>
    {
        await this.db
            .update(oauth2Clients)
            .set({ lastUsedAt: new Date() })
            .where(eq(oauth2Clients.id, id));
    }

    /**
     * Register a client unless this address is already at its standing cap.
     *
     * The count and the insert are one transaction whose first statement takes
     * an advisory lock on the address, and all three parts are load-bearing.
     * Counting on the replica lets replication lag hand out slots that are
     * already taken. Counting and inserting in two statements lets a second
     * registration read the same total between them. And a transaction alone
     * does not close that: under READ COMMITTED each concurrent transaction
     * counts the rows the others have not committed yet, so twenty requests
     * arriving together all see zero. The lock is the only part that makes the
     * cap a number rather than an average, and it is per address, so it costs
     * nobody else anything.
     *
     * @param data - The row to write when there is room for it
     * @param limit - The address, its cap, and how far back the cap looks
     * @returns the registered client, or null when the address is at its cap
     */
    async createWithinStandingCap(
        data: NewOAuth2Client,
        limit: { ip: string; max: number; windowMs: number },
    ): Promise<OAuth2Client | null>
    {
        return await runInTransaction(async () =>
        {
            await this.db.execute(sql`select pg_advisory_xact_lock(hashtext(${limit.ip}))`);

            const standing = await this.countRecentUngrantedByIp(limit.ip, limit.windowMs);

            return standing < limit.max ? await this.create(data) : null;
        });
    }

    /**
     * How many clients this IP registered within the window that nobody has
     * approved yet.
     *
     * The window is what makes this a standing-population cap rather than a
     * permanent quota. Rows are only freed by the purge job, which sweeps once
     * a day against a 24-hour threshold — so without a window a row registered
     * a minute after one sweep holds its slot for nearly two days, and twenty
     * developers behind one NAT lock their whole office out of registering.
     * A grant against the client takes it out of the count at any age: a client
     * somebody approved is not junk.
     *
     * Reads the primary, inside the caller's transaction, for the reason
     * `findByClientId` does — a row written a moment ago is exactly the row this
     * count exists to see.
     */
    private async countRecentUngrantedByIp(ip: string, windowMs: number): Promise<number>
    {
        const result = await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(oauth2Clients)
            .where(
                and(
                    eq(oauth2Clients.createdIp, ip),
                    gt(oauth2Clients.createdAt, new Date(Date.now() - windowMs)),
                    sql`not exists (select 1 from ${oauth2Grants} where ${oauth2Grants.client} = ${oauth2Clients.id})`,
                ),
            );

        return result[0]?.count ?? 0;
    }

    /**
     * Delete clients older than `before` that no user ever approved.
     *
     * A registration is an unauthenticated write, so the table fills with rows
     * from installs that were abandoned at the consent screen. A row with a
     * grant against it is never touched, whatever its age — that is somebody's
     * connected CLI.
     *
     * @returns how many rows this sweep removed
     */
    async deleteStaleUngranted(before: Date): Promise<number>
    {
        const deleted = await this.db
            .delete(oauth2Clients)
            .where(
                and(
                    lt(oauth2Clients.createdAt, before),
                    sql`not exists (select 1 from ${oauth2Grants} where ${oauth2Grants.client} = ${oauth2Clients.id})`,
                ),
            )
            .returning({ id: oauth2Clients.id });

        return deleted.length;
    }
}

export const oauth2ClientsRepository = new OAuth2ClientsRepository();
