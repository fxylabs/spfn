/**
 * Whether a key a row names is still live, as one SQL condition.
 *
 * Shared by the two records another device's key approved — a device link
 * (its issuer) and a device-code authorization (its approver) — so that both
 * are spent only while that key can still sign: active, unexpired, and of its
 * account's current key generation. The rule `keyLiveness` states, here as the
 * one statement that also takes the lock.
 */

import { and, eq, exists, gt, isNull, or, sql, type EmptyRelations, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { RepositoryDatabase } from '@spfn/core/db';

import { userPublicKeys, users } from '../entities';

type Database = RepositoryDatabase<PostgresJsDatabase<EmptyRelations>>;

/**
 * @param db - the repository's `this.db`: the decision is read on the primary
 * @param keyId - the column naming the approving key
 * @param userId - the column naming the account the key must belong to
 * @param lock - take a share lock on the key row, so a transition waits for a
 *   revocation in flight instead of judging the version before it
 */
export function liveKeyExists(db: Database, keyId: PgColumn, userId: PgColumn, lock: boolean): SQL<boolean>
{
    const key = db
        .select({ one: sql`1` })
        .from(userPublicKeys)
        .innerJoin(users, and(eq(users.id, userPublicKeys.userId), eq(users.keyEpoch, userPublicKeys.keyEpoch)))
        .where(
            and(
                eq(userPublicKeys.keyId, keyId),
                eq(userPublicKeys.userId, userId),
                eq(userPublicKeys.isActive, true),
                or(isNull(userPublicKeys.expiresAt), gt(userPublicKeys.expiresAt, sql`now()`)),
            ),
        );

    return sql<boolean>`${exists(lock ? key.for('share', { of: userPublicKeys }) : key)}`;
}
