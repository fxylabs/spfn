/**
 * One connection for a tenant export or import
 *
 * Every statement of a run goes through one connection — one snapshot for an
 * export, one transaction for an import. A failure is printed by
 * `describeFailure` (`utils/database-failure`).
 */

import postgres from 'postgres';

export type TenantSql = postgres.Sql;
export type TenantTransaction = postgres.TransactionSql;

export function openConnection(url: string): TenantSql
{
    return postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 10 });
}
