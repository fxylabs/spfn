/**
 * OAuth 2.1 Authorization Codes Repository
 *
 * Two operations and one of them is the whole point. `consume` is a conditional
 * UPDATE that names unspent and not-expired and writes `used_at` in the same
 * statement that reads the row, so of two token requests racing on one code
 * exactly one comes back with a row. Read-then-write would hand both of them
 * tokens.
 *
 * The TTL travels in that statement as `now()` evaluated by the database, for
 * the reason the device-code transitions carry theirs: the row is judged by the
 * same clock that stores it, so an app server whose clock drifted cannot extend
 * a code's life.
 *
 * `findByCodeHash` exists only to explain a miss. A code that is simply unknown
 * and one that was already spent get the same answer at the endpoint —
 * `invalid_grant` either way — but the spent one also revokes the grant, and
 * that decision needs the row.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';
import {
    oauth2AuthorizationCodes,
    type NewOAuth2AuthorizationCode,
    type OAuth2AuthorizationCode,
} from '../entities/oauth2-authorization-codes';

export class OAuth2AuthorizationCodesRepository extends BaseRepository
{
    async create(data: NewOAuth2AuthorizationCode): Promise<OAuth2AuthorizationCode>
    {
        const result = await this.db
            .insert(oauth2AuthorizationCodes)
            .values(data)
            .returning();

        return result[0]!;
    }

    /**
     * Spend a code, addressed by the hash the caller actually presented.
     *
     * @returns the row this call spent, or null when it was unknown, already
     *          spent, or past its 60 seconds
     */
    async consume(codeHash: string): Promise<OAuth2AuthorizationCode | null>
    {
        const result = await this.db
            .update(oauth2AuthorizationCodes)
            .set({ usedAt: sql`now()` })
            .where(
                and(
                    eq(oauth2AuthorizationCodes.codeHash, codeHash),
                    isNull(oauth2AuthorizationCodes.usedAt),
                    gt(oauth2AuthorizationCodes.expiresAt, sql`now()`),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * The row behind a miss, in any state. Deliberately unfiltered — which
     * refusal is owed is the service's decision, and a row filtered out here
     * would be indistinguishable from a code that never existed.
     */
    async findByCodeHash(codeHash: string): Promise<OAuth2AuthorizationCode | null>
    {
        const result = await this.db
            .select()
            .from(oauth2AuthorizationCodes)
            .where(eq(oauth2AuthorizationCodes.codeHash, codeHash))
            .limit(1);

        return result[0] ?? null;
    }
}

export const oauth2AuthorizationCodesRepository = new OAuth2AuthorizationCodesRepository();
