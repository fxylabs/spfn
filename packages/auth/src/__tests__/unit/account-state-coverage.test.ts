/**
 * Every write on per-account credential state is classified — read off the
 * repository classes at runtime, so a write method added later fails here
 * whether or not an integration test runs it.
 *
 * `AccountStateRepository` checks each write a test does run; this file covers
 * the ones none does, and the tables themselves: every table of `entities` is
 * either one of `CREDENTIAL_TABLES` or named below with why it is not.
 *
 * Two static checks, on two representations:
 *
 * - every method of an `AccountStateRepository`, as the compiled method source
 *   (`Function.prototype.toString`), that writes a credential table — a
 *   drizzle `insert`/`update`/`delete`, a core helper (`_create`, `_upsert`,
 *   `_updateOne`, `_deleteMany`, …) or a raw `execute` — has an `accountWrites`
 *   entry;
 * - every file under `src/server` that is not an `AccountStateRepository`
 *   (services, routes, other repositories, module-level helpers), as source
 *   text, names no credential table as the target of such a write or of a
 *   `sql` template that inserts into, updates or deletes from it.
 *
 * What neither sees, and only the runtime check (`AccountStateRepository`'s
 * guard, under test) can: a write built with `db.with(...)` or `$with`; one in
 * a `#private` method or an arrow-function class field of a base repository
 * (neither is on the prototype these checks walk); a module-level helper
 * inside a base repository's own file that is handed `this.db`; a table
 * imported under another name; and a write whose target is a variable rather
 * than the table's identifier.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { BaseRepository } from '@spfn/core/db';
import { getTableName, isTable } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import * as entities from '@/server/entities';
import * as repositories from '@/server/repositories';
import { accountStatusRepository } from '@/server/repositories/account-status.repository';
import {
    AccountStateRepository,
    CREDENTIAL_TABLES,
    ownMethods,
} from '@/server/repositories/account-state.repository';

/** The tables that hold no per-account credential state, and why. */
const NOT_CREDENTIAL_STATE: Record<string, string> = {
    auth_metadata: 'package bookkeeping (seed versions), no account',
    roles: 'shared catalogue; what a role may do is authorization, not a credential',
    permissions: 'shared catalogue',
    role_permissions: 'shared catalogue',
    user_permissions: 'authorization grants: no way in, and no admission writes them',
    user_profiles: 'display fields',
    user_settings: 'an app\'s declared key/value preferences; admission reads only the locale, for display. (session_binding, which sign-in reads, is a users column and written under the lock with it)',
    user_invitations: 'an invitation names an address, not an account: it creates the account it is accepted into',
    signup_link_tokens: 'a signup link names an address, not an account: completing it creates the account',
    verification_codes: 'codes for a target address or phone, not for an account',
    account_deletion_requests: 'the request row is written under the account lock by account-deletion.service with the status it moves; the row itself admits nothing',
    ops_tokens: 'operator tokens: no account',
    oauth2_clients: 'third-party client registrations: no account',
};

/**
 * Statements that write, with the table they name — drizzle's three and the
 * core `BaseRepository` helpers — as source spells them (`table`) and as the
 * compiled method does (`(0, module.table)`, `__vi_import_0__.table`).
 */
const WRITE_PATTERN = /\.(?:insert|update|delete|_create|_createMany|_upsert|_updateOne|_updateMany|_deleteOne|_deleteMany)\(\s*(?:\(0,\s*)?(?:[\w$]+\.)?([\w$]+)/g;
const EXECUTE_PATTERN = /\.execute\(/;

/** A `sql` template that writes, with its target: an interpolated table, or a table name spelled out. */
const SQL_WRITE_PATTERN = /\b(?:insert\s+into|update|delete\s+from)\s+(?:\$\{\s*(?:\(0,\s*)?(?:[\w$]+\.)?([\w$]+)\s*\)?\s*\}|(?:"?\w+"?\.)?"?(\w+)"?)/gi;
const SQL_TEMPLATE_PATTERN = /\bsql(?:\.raw\()?\s*`([^`]*)`/g;

const tableByIdentifier = new Map(
    Object.entries(entities).filter(([, value]) => isTable(value)).map(([name, table]) => [name, table as PgTable]),
);
const credentialTableNames = new Set([...CREDENTIAL_TABLES.keys()].map(table => getTableName(table)));

/** The credential table an identifier or a spelled-out table name denotes, if any. */
function credentialTableNamed(name: string | undefined): string | undefined
{
    const table = name === undefined ? undefined : tableByIdentifier.get(name);
    if (table)
    {
        return CREDENTIAL_TABLES.has(table) ? getTableName(table) : undefined;
    }

    return name !== undefined && credentialTableNames.has(name) ? name : undefined;
}

/** The credential tables a piece of source writes: by statement, by core helper, or by `sql` template. */
function credentialWritesIn(source: string): string[]
{
    const statements = [...source.matchAll(WRITE_PATTERN)].map(match => credentialTableNamed(match[1]));
    const templates = [...source.matchAll(SQL_TEMPLATE_PATTERN)]
        .flatMap(template => [...template[1]!.matchAll(SQL_WRITE_PATTERN)])
        .map(match => credentialTableNamed(match[1] ?? match[2]));

    return [...statements, ...templates].filter((name): name is string => name !== undefined);
}

const SERVER_ROOT = resolve(import.meta.dirname, '../../server');

/** Every source file under `src/server`, tests left out. */
function serverSources(directory: string = SERVER_ROOT): string[]
{
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const path = join(directory, entry.name);
        if (entry.isDirectory())
        {
            return entry.name === '__tests__' ? [] : serverSources(path);
        }

        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });
}

/** A base repository method's credential writes; any raw `execute` counts, since it names no table drizzle can see. */
function credentialTablesWritten(method: (...args: unknown[]) => unknown): string[]
{
    const source = method.toString();
    const named = credentialWritesIn(source);

    return EXECUTE_PATTERN.test(source) ? [...named, 'raw SQL'] : named;
}

const allRepositories: BaseRepository[] = [
    ...Object.values(repositories as Record<string, unknown>).filter((value): value is BaseRepository => value instanceof BaseRepository),
    accountStatusRepository,
];

describe('account-state coverage', () =>
{
    it('classifies every table of the entities as credential state or not, with a reason', () =>
    {
        const unclassified = [...tableByIdentifier.values()]
            .map(table => getTableName(table))
            .filter(name => ![...CREDENTIAL_TABLES.keys()].some(table => getTableName(table) === name) && !NOT_CREDENTIAL_STATE[name]);

        expect(unclassified).toEqual([]);
        expect(Object.values(NOT_CREDENTIAL_STATE).every(reason => reason.length > 10)).toBe(true);
    });

    it('finds no credential write in any file under src/server outside the base repositories', () =>
    {
        const outside = serverSources()
            .map(path => ({ path, source: readFileSync(path, 'utf8') }))
            .filter(({ source }) => !/\bextends\s+AccountStateRepository\b/.test(source))
            .flatMap(({ path, source }) => credentialWritesIn(source).map(table => `${relative(SERVER_ROOT, path)} (${table})`));

        expect(outside).toEqual([]);
    });

    it('sees a write in each shape the static checks claim to cover', () =>
    {
        const shapes = [
            'await this.db.update(passkeys).set({ counter })',
            'await this._updateOne(userPublicKeys, { id }, { isActive: false })',
            'await this._deleteOne(mfaTotp, { userId })',
            'await db.execute(sql`update ${users} set key_epoch = key_epoch + 1`)',
            'await tx.execute(sql`DELETE FROM "spfn_auth"."user_public_keys" WHERE user_id = ${id}`)',
            'await this.db.insert((0, __vi_import_0__.oauth2Grants)).values(row)',
        ];

        expect(shapes.map(shape => credentialWritesIn(shape))).toEqual([
            ['passkeys'], ['user_public_keys'], ['mfa_totp'], ['users'], ['user_public_keys'], ['oauth2_grants'],
        ]);
        expect(credentialWritesIn('await this.db.update(roles).set({ name })')).toEqual([]);
    });

    it('classifies every write method of every AccountStateRepository, and nothing that is not one', () =>
    {
        const unclassified: string[] = [];
        const stale: string[] = [];

        for (const repository of allRepositories.filter(r => r instanceof AccountStateRepository) as AccountStateRepository[])
        {
            const methods = ownMethods(Object.getPrototypeOf(repository));
            const declared = (repository.constructor as typeof AccountStateRepository).accountWrites;

            for (const [name, method] of methods)
            {
                if (credentialTablesWritten(method).length > 0 && !repository.accountWriteOf(name))
                {
                    unclassified.push(`${repository.constructor.name}.${name} (${credentialTablesWritten(method).join(', ')})`);
                }
            }

            stale.push(...Object.keys(declared).filter(name => !methods.has(name)).map(name => `${repository.constructor.name}.${name}`));
        }

        expect(unclassified).toEqual([]);
        expect(stale).toEqual([]);
    });

    it('gives every exemption a reason', () =>
    {
        const bare = (allRepositories.filter(r => r instanceof AccountStateRepository) as AccountStateRepository[])
            .flatMap(repository => Object.entries((repository.constructor as typeof AccountStateRepository).accountWrites)
                .filter(([, write]) => 'exempt' in write && write.exempt.trim().length < 20)
                .map(([name]) => `${repository.constructor.name}.${name}`));

        expect(bare).toEqual([]);
    });
});
