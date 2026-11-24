// src/server/repositories/sign-in-history.repository.ts
import { BaseRepository } from '@spfn/core/db';
import { inArray, max, sql } from 'drizzle-orm';
import type { SignInOutcome } from '@spfn/auth/server';
import { signInAttempts, signInHistory } from '../entities/sign-in-history';

export class SignInHistoryRepository extends BaseRepository
{
    async record(outcome: SignInOutcome): Promise<void>
    {
        await this.db.insert(signInHistory).values({
            userId: outcome.user?.id ?? null,
            channel: outcome.channel,
            stage: outcome.stage,
            result: outcome.result,
            reason: outcome.result === 'failed' ? outcome.reason : null,
            ip: outcome.ip ?? null,
            webProxy: outcome.webProxy,
        });
    }
}

export class SignInAttemptsRepository extends BaseRepository
{
    /** The most attempts on any of `identifiers` since its last success or lift — read under the account lock. */
    async count(identifiers: string[]): Promise<number>
    {
        const [row] = await this.db.select({ attempts: max(signInAttempts.attempts) }).from(signInAttempts)
            .where(inArray(signInAttempts.identifier, identifiers));

        return row?.attempts ?? 0;
    }

    /**
     * One more attempt on each identifier, in the `before-proof` call's transaction; it commits
     * whatever `admit` answers. One statement: the increments and the counts they answer are one
     * write, with no read before it.
     */
    async add(identifiers: string[]): Promise<number>
    {
        const rows = await this.db.insert(signInAttempts).values(identifiers.map(identifier => ({ identifier, attempts: 1 })))
            .onConflictDoUpdate({ target: signInAttempts.identifier, set: { attempts: sql`${signInAttempts.attempts} + 1` } })
            .returning({ attempts: signInAttempts.attempts });

        return Math.max(...rows.map(row => row.attempts));
    }

    /** A sign-in that succeeded, or an administrator's lift: one statement, under the account lock. */
    async clear(identifiers: string[]): Promise<void>
    {
        await this.db.delete(signInAttempts).where(inArray(signInAttempts.identifier, identifiers));
    }
}

export const signInHistoryRepository = new SignInHistoryRepository();
export const signInAttemptsRepository = new SignInAttemptsRepository();
