/**
 * Ops Tokens Repository
 *
 * Data access for the ops-token credential store. An ops token is a credential
 * issued under its issuer's account, so this is an `AccountStateRepository`:
 * issuance writes under the issuer's account lock.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { opsTokens, type NewOpsToken, type OpsToken } from '../entities/ops-tokens';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

/** A token as issuance writes it: always under an issuer. */
export type NewIssuedOpsToken = NewOpsToken & { issuedBy: number };

export class OpsTokensRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<OpsTokensRepository> = {
        create: { account: data => data.issuedBy },
        revokeById: { exempt: 'an operator\'s revocation only removes a way in, and it is terminal: no state of the issuer\'s account makes the token work again' },
        updateLastUsedById: { exempt: 'bookkeeping after a verification: lastUsedAt is shown to operators and decides nothing' },
    };

    /**
     * Lookup by the secret's hash — the verification path.
     *
     * Reads the primary, not the replica, unlike every other SELECT here.
     * Revocation writes to the primary, so a replica read would keep
     * authenticating a revoked token for the length of the replication lag —
     * and revocation is documented as taking effect immediately.
     */
    async findByTokenHash(tokenHash: string): Promise<OpsToken | null>
    {
        const result = await this.db
            .select()
            .from(opsTokens)
            .where(eq(opsTokens.tokenHash, tokenHash))
            .limit(1);

        return result[0] ?? null;
    }

    async create(data: NewIssuedOpsToken): Promise<OpsToken>
    {
        const result = await this.db
            .insert(opsTokens)
            .values(data)
            .returning();

        return result[0]!;
    }

    async list(): Promise<OpsToken[]>
    {
        return await this.readDb
            .select()
            .from(opsTokens)
            .orderBy(desc(opsTokens.createdAt));
    }

    /**
     * Revoke an active token. Returns null when the id does not exist or the
     * token is already revoked — the first revocation's timestamp is never
     * overwritten.
     */
    async revokeById(id: number): Promise<OpsToken | null>
    {
        const result = await this.db
            .update(opsTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(opsTokens.id, id), isNull(opsTokens.revokedAt)))
            .returning();

        return result[0] ?? null;
    }

    /** Fire-and-forget from the verification path. */
    async updateLastUsedById(id: number): Promise<void>
    {
        await this.db
            .update(opsTokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(opsTokens.id, id));
    }
}

export const opsTokensRepository = new OpsTokensRepository();
