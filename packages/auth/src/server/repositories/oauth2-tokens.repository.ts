/**
 * OAuth 2.1 Tokens Repository
 *
 * Access and refresh rows, and the rotation that turns one refresh into the
 * next.
 *
 * `rotate` is the code-consuming statement again, in the other table: mark the
 * presented refresh `replaced_at` only if it is live, and return it only when
 * THIS call was the one that marked it. Two clients refreshing the same token at
 * once therefore produce one rotation and one refusal, instead of two token
 * pairs off one refresh.
 *
 * Nothing is deleted. A rotated refresh keeps its row so that presenting it
 * again is distinguishable from presenting a token that never existed, which is
 * the entire reuse detection.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';
import { oauth2Tokens, type NewOAuth2Token, type OAuth2Token } from '../entities/oauth2-tokens';

export class OAuth2TokensRepository extends BaseRepository
{
    async create(data: NewOAuth2Token): Promise<OAuth2Token>
    {
        const result = await this.db
            .insert(oauth2Tokens)
            .values(data)
            .returning();

        return result[0]!;
    }

    /**
     * Lookup by the token's hash — the verification and refresh paths.
     *
     * Primary, not replica: revocation is a button the user presses and is
     * documented as taking effect immediately, so a replica read would keep
     * authenticating a revoked token for the length of the replication lag.
     * Unfiltered, so the service can tell revoked from expired from unknown.
     */
    async findByTokenHash(tokenHash: string): Promise<OAuth2Token | null>
    {
        const result = await this.db
            .select()
            .from(oauth2Tokens)
            .where(eq(oauth2Tokens.tokenHash, tokenHash))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Mark a live refresh token as replaced, addressed by its hash.
     *
     * @returns the row this call replaced, or null when it was unknown, already
     *          rotated, revoked, or expired
     */
    async rotate(tokenHash: string): Promise<OAuth2Token | null>
    {
        const result = await this.db
            .update(oauth2Tokens)
            .set({ replacedAt: sql`now()` })
            .where(
                and(
                    eq(oauth2Tokens.tokenHash, tokenHash),
                    eq(oauth2Tokens.kind, 'refresh'),
                    isNull(oauth2Tokens.replacedAt),
                    isNull(oauth2Tokens.revokedAt),
                    gt(oauth2Tokens.expiresAt, sql`now()`),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * Revoke a live token by hash — RFC 7009.
     *
     * @returns the revoked row, or null when there was nothing live to revoke.
     *          The endpoint answers 200 either way; the caller learns nothing
     *          about whether the value it presented ever existed.
     */
    async revokeByTokenHash(tokenHash: string): Promise<OAuth2Token | null>
    {
        const result = await this.db
            .update(oauth2Tokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(oauth2Tokens.tokenHash, tokenHash), isNull(oauth2Tokens.revokedAt)))
            .returning();

        return result[0] ?? null;
    }

    /** Fire-and-forget from the verification path, as ops tokens do. */
    async updateLastUsedById(id: number): Promise<void>
    {
        await this.db
            .update(oauth2Tokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(oauth2Tokens.id, id));
    }
}

export const oauth2TokensRepository = new OAuth2TokensRepository();
