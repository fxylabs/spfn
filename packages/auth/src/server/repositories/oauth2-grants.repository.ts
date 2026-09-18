/**
 * OAuth 2.1 Grants Repository
 *
 * Data access for the consent records every code and token hangs off.
 *
 * Revocation is the operation that matters here, and it is always one statement
 * per table rather than a read-then-write: a grant being revoked at the same
 * moment as a refresh rotation must not let the rotation's successor survive,
 * and `where revoked_at is null` in the UPDATE is what makes the two orderings
 * produce the same end state.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';
import { oauth2Grants, type NewOAuth2Grant, type OAuth2Grant } from '../entities/oauth2-grants';
import { oauth2Clients, type OAuth2Client } from '../entities/oauth2-clients';
import { oauth2Tokens } from '../entities/oauth2-tokens';

/** A grant with the client it belongs to — what every list and lookup needs. */
export interface OAuth2GrantWithClient
{
    grant: OAuth2Grant;
    client: OAuth2Client;
}

export class OAuth2GrantsRepository extends BaseRepository
{
    /**
     * Record a consent, or refresh the scopes of the one already there.
     *
     * Re-consenting is an upsert and not an insert: the unique index on
     * (client, user, resource) says one consent per triple, and a user who
     * approves a wider scope set is amending the consent they already gave, not
     * giving a second one. Revoking the entry they can see must revoke
     * everything the client holds, which a second row would break.
     *
     * `revokedAt: null` in the update is deliberate — approving again after
     * revoking is how a user reconnects a CLI they cut off.
     */
    async upsert(data: NewOAuth2Grant): Promise<OAuth2Grant>
    {
        const result = await this.db
            .insert(oauth2Grants)
            .values(data)
            .onConflictDoUpdate({
                target: [oauth2Grants.client, oauth2Grants.user, oauth2Grants.resource],
                set: { scopes: data.scopes, revokedAt: null, updatedAt: new Date() },
            })
            .returning();

        return result[0]!;
    }

    /** The live consent for this triple, if the user ever gave one. */
    async findActive(clientRowId: number, userId: number, resource: string): Promise<OAuth2Grant | null>
    {
        const result = await this.db
            .select()
            .from(oauth2Grants)
            .where(
                and(
                    eq(oauth2Grants.client, clientRowId),
                    eq(oauth2Grants.user, userId),
                    eq(oauth2Grants.resource, resource),
                    isNull(oauth2Grants.revokedAt),
                ),
            )
            .limit(1);

        return result[0] ?? null;
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

    /** What the user's "connected apps" screen lists. Read replica. */
    async listActiveByUserId(userId: number): Promise<OAuth2GrantWithClient[]>
    {
        return await this.readDb
            .select({ grant: oauth2Grants, client: oauth2Clients })
            .from(oauth2Grants)
            .innerJoin(oauth2Clients, eq(oauth2Grants.client, oauth2Clients.id))
            .where(and(eq(oauth2Grants.user, userId), isNull(oauth2Grants.revokedAt)))
            .orderBy(desc(oauth2Grants.createdAt));
    }

    /**
     * Revoke one live grant belonging to one user.
     *
     * The user id is part of the condition rather than checked beforehand: the
     * id in the URL comes from a caller, and a grant that is not theirs must not
     * be revocable by guessing a number. A miss is indistinguishable from an id
     * that does not exist, which is the answer the route gives.
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
                    isNull(oauth2Grants.revokedAt),
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

    /**
     * Revoke every live token under the given grants.
     *
     * Verification already refuses a token whose grant is revoked, so this is
     * belt and braces — but the belt is what a `SELECT` against this table shows
     * an operator, and a live-looking row under a dead grant reads as a hole.
     *
     * @returns how many tokens this call revoked
     */
    async revokeTokensOfGrants(grantIds: number[]): Promise<number>
    {
        if (grantIds.length === 0)
        {
            return 0;
        }

        const revoked = await this.db
            .update(oauth2Tokens)
            .set({ revokedAt: sql`now()` })
            .where(and(inArray(oauth2Tokens.grant, grantIds), isNull(oauth2Tokens.revokedAt)))
            .returning({ id: oauth2Tokens.id });

        return revoked.length;
    }
}

export const oauth2GrantsRepository = new OAuth2GrantsRepository();
