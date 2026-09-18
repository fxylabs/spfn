/**
 * OAuth 2.1 Clients Repository
 *
 * Data access for dynamically registered public clients. Extends BaseRepository
 * for transaction context and read/write splitting like every other auth
 * repository.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';
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
     * How many clients this IP registered that nobody has approved yet.
     *
     * The cap this feeds is on the standing population, not on a rate: a client
     * row costs nothing to make and lives until a job sweeps it, so a limiter
     * with a window would let one IP accumulate rows forever at a slow enough
     * pace. A grant against the client takes it out of the count — a client
     * somebody approved is not junk.
     *
     * Read replica: the cap is a housekeeping bound, and the rate limiter in
     * front of the route is what stops a burst.
     */
    async countUngrantedByIp(ip: string): Promise<number>
    {
        const result = await this.readDb
            .select({ count: sql<number>`count(*)::int` })
            .from(oauth2Clients)
            .where(
                and(
                    eq(oauth2Clients.createdIp, ip),
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
