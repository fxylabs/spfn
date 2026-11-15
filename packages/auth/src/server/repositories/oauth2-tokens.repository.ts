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
 * Credential state (`CREDENTIAL_TABLES`), written by the token endpoint
 * alone; why those writes take no account lock is `TOKEN_ENDPOINT_WRITE`.
 *
 * Nothing is deleted. A rotated refresh keeps its row so that presenting it
 * again is distinguishable from presenting a token that never existed, which is
 * the entire reuse detection.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { oauth2Tokens, type NewOAuth2Token, type OAuth2Token } from '../entities/oauth2-tokens';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

/**
 * Why the token endpoint's writes — a code spent, a token pair minted, a
 * refresh rotated — take no account lock, said once for each of them. The
 * grant is admitted (`admitPrincipal`) before anything is minted, too.
 */
export const TOKEN_ENDPOINT_WRITE = 'the token endpoint: client-authenticated, with no session to re-admit, and nothing it writes outlives its grant — every code and token is judged against a live grant on each use (isLiveGrant), so a row written after a revocation committed authorizes nothing';

export class OAuth2TokensRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<OAuth2TokensRepository> = {
        create: { exempt: TOKEN_ENDPOINT_WRITE },
        rotate: { exempt: TOKEN_ENDPOINT_WRITE },
        revokeByTokenHash: { exempt: 'RFC 7009 revocation, client-authenticated: it only removes a way in, and a revoked token is never live again' },
        updateLastUsedById: { exempt: 'last-used bookkeeping from the verification path: read by no admission' },
    };

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
