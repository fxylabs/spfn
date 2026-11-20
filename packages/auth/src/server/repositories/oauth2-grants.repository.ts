/**
 * OAuth 2.1 Grants Repository
 *
 * Data access for the consent records every code and token hangs off.
 *
 * A grant is a standing way in to the account for a client, so it is
 * credential state (`CREDENTIAL_TABLES`): a consent, a disconnect and the
 * bulk revocation write it under the account lock.
 *
 * Revocation is the operation that matters here. It is recorded on the grant
 * and nowhere else, and it is terminal: nothing in this file sets `revoked_at`
 * back to null, so a code or token whose grant was revoked is refused for good,
 * however it was minted and whenever it arrives — including one an exchange or
 * a refresh in flight wrote after the revocation landed.
 *
 * "Is this grant live" is answered here and nowhere else: not revoked, and
 * `expires_at` later than now. `liveGrant` asks it in SQL and `isLiveGrant` of
 * a row already loaded, of the same stored column against the application's
 * clock, so the list a user sees, the consent that amends a grant, the
 * disconnect, the code exchange, the refresh and the verification of every
 * access token agree on which grants exist — at the boundary too.
 */

import { and, desc, eq, gt, isNull, not, sql, type SQL } from 'drizzle-orm';
import { oauth2Grants, type NewOAuth2Grant, type OAuth2Grant } from '../entities/oauth2-grants';
import { oauth2Clients, type OAuth2Client } from '../entities/oauth2-clients';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

/** A grant with the client it belongs to — what every list and lookup needs. */
export interface OAuth2GrantWithClient
{
    grant: OAuth2Grant;
    client: OAuth2Client;
}

/** A grant authorizes anything only while it is live — the rule in SQL. */
function liveGrant(now: Date): SQL
{
    return and(isNull(oauth2Grants.revokedAt), gt(oauth2Grants.expiresAt, now))!;
}

/**
 * The same rule as `liveGrant`, for a row already loaded: not revoked, and
 * `expires_at` later than now. A grant that is not live authorizes nothing,
 * however recently its tokens were rotated.
 */
export function isLiveGrant(grant: OAuth2Grant, now: Date = new Date()): boolean
{
    return grant.revokedAt === null && grant.expiresAt.getTime() > now.getTime();
}

export class OAuth2GrantsRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<OAuth2GrantsRepository> = {
        upsert: { account: data => data.user },
        revokeLapsed: { account: key => key.user },
        revokeByIdForUser: { account: (_id, userId) => userId },
        revokeById: { exempt: 'the replay detections at the token endpoint (client-authenticated, no session): a revocation only removes a way in, and it is terminal' },
        revokeAllActiveByUserId: { account: userId => userId },
    };

    /**
     * Record a consent, or amend the scopes of the live one already there.
     *
     * An upsert against the live grant only: the unique index on (client, user,
     * resource) covers rows that are not revoked, so a user who approves again
     * while connected amends the consent they gave — wider or narrower, and every
     * token already out follows it — and a user reconnecting after a disconnect
     * gets a new row. The revoked row stays revoked, and with it every code and
     * token that hung off it. Amending changes the scopes only: `expiresAt` is
     * the one the row was inserted with, so re-consenting does not extend it.
     */
    async upsert(data: NewOAuth2Grant): Promise<OAuth2Grant>
    {
        const result = await this.db
            .insert(oauth2Grants)
            .values(data)
            .onConflictDoUpdate({
                target: [oauth2Grants.client, oauth2Grants.user, oauth2Grants.resource],
                targetWhere: sql`${oauth2Grants.revokedAt} is null`,
                set: { scopes: data.scopes },
            })
            .returning();

        return result[0]!;
    }

    /**
     * Revoke the unrevoked grant for (client, user, resource) that is no longer
     * live — one past its `expiresAt`. Called before a fresh consent is recorded:
     * the unique index `upsert` amends against covers every unrevoked row, lapsed
     * or not, so without this the consent would amend a grant that has already
     * ended instead of starting a new grant and a new lifetime.
     */
    async revokeLapsed(
        key: Pick<NewOAuth2Grant, 'client' | 'user' | 'resource'>,
    ): Promise<void>
    {
        await this.db
            .update(oauth2Grants)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(oauth2Grants.client, key.client),
                    eq(oauth2Grants.user, key.user),
                    eq(oauth2Grants.resource, key.resource),
                    isNull(oauth2Grants.revokedAt),
                    not(liveGrant(new Date())),
                ),
            );
    }

    /**
     * A grant and its client in one read — the shape the token and verification
     * paths need, since both have to check the client the caller claims and the
     * grant's revocation at once.
     *
     * Read primary: revocation is documented as taking effect immediately.
     */
    async findWithClientById(id: number): Promise<OAuth2GrantWithClient | null>
    {
        const result = await this.db
            .select({ grant: oauth2Grants, client: oauth2Clients })
            .from(oauth2Grants)
            .innerJoin(oauth2Clients, eq(oauth2Grants.client, oauth2Clients.id))
            .where(eq(oauth2Grants.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * What the user's "connected apps" screen lists: their live grants. A grant
     * past its `expiresAt` is not connected, so it is not shown. Read replica.
     */
    async listLiveByUserId(userId: number): Promise<OAuth2GrantWithClient[]>
    {
        return await this.readDb
            .select({ grant: oauth2Grants, client: oauth2Clients })
            .from(oauth2Grants)
            .innerJoin(oauth2Clients, eq(oauth2Grants.client, oauth2Clients.id))
            .where(and(eq(oauth2Grants.user, userId), liveGrant(new Date())))
            .orderBy(desc(oauth2Grants.createdAt));
    }

    /**
     * Revoke one live grant belonging to one user.
     *
     * The user id is part of the condition rather than checked beforehand: the
     * id in the URL comes from a caller, and a grant that is not theirs must not
     * be revocable by guessing a number. A miss is indistinguishable from an id
     * that does not exist, which is the answer the route gives. Live by the
     * same rule as the list: a grant the list does not show cannot be
     * disconnected either.
     *
     * @returns the revoked row, or null if there was no live grant of that id
     *          for that user
     */
    async revokeByIdForUser(id: number, userId: number): Promise<OAuth2Grant | null>
    {
        const result = await this.db
            .update(oauth2Grants)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(oauth2Grants.id, id),
                    eq(oauth2Grants.user, userId),
                    liveGrant(new Date()),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /** Revoke one grant by id, whoever it belongs to — the replay detections. */
    async revokeById(id: number): Promise<OAuth2Grant | null>
    {
        const result = await this.db
            .update(oauth2Grants)
            .set({ revokedAt: new Date() })
            .where(and(eq(oauth2Grants.id, id), isNull(oauth2Grants.revokedAt)))
            .returning();

        return result[0] ?? null;
    }

    /**
     * Revoke every live grant a user has — the authorization-server half of a
     * global revocation, beside `denyAllActiveByUserId`.
     *
     * @returns the grant ids this call revoked
     */
    async revokeAllActiveByUserId(userId: number): Promise<number[]>
    {
        const revoked = await this.db
            .update(oauth2Grants)
            .set({ revokedAt: new Date() })
            .where(and(eq(oauth2Grants.user, userId), isNull(oauth2Grants.revokedAt)))
            .returning({ id: oauth2Grants.id });

        return revoked.map(row => row.id);
    }
}

export const oauth2GrantsRepository = new OAuth2GrantsRepository();
