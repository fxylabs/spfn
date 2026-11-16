/**
 * The repository base for every table that holds an account's credential
 * state, and the test-time check that each of its writes runs under that
 * account's lock (`UsersRepository.lockAccount`).
 *
 * The writers are derived, not listed: under test (`SPFN_AUTH_ASSERT_ACCOUNT_LOCK`)
 * this base's `db` stops every `insert`, `update`, `delete` and `execute` a
 * method issues on one of `CREDENTIAL_TABLES` and asks the method's entry in
 * its class's `accountWrites`:
 *
 * - `account`: which account(s) the write belongs to, read off the call's
 *   arguments — the transaction must hold each one's lock;
 * - `exempt`: why this write needs no lock — said in words, for a reviewer;
 * - no entry: the write is refused as unclassified.
 *
 * A write method added later is therefore checked the first time a test runs
 * it, and `account-state-coverage.test.ts` reads every class's methods to name
 * the unclassified ones whether a test runs them or not.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { BaseRepository, type RepositoryDatabase } from '@spfn/core/db';
import { getTableName, isTable, type EmptyRelations } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { deviceAuthorizations } from '../entities/device-authorizations';
import { oauth2AuthorizationCodes } from '../entities/oauth2-authorization-codes';
import { oauth2Grants } from '../entities/oauth2-grants';
import { oauth2Tokens } from '../entities/oauth2-tokens';
import { opsTokens } from '../entities/ops-tokens';
import { webauthnChallenges } from '../entities/webauthn-challenges';
import { deviceLinks } from '../entities/device-links';
import { keyRevokeAllTokens } from '../entities/key-revoke-all-tokens';
import { mfaAttemptBudgets } from '../entities/mfa-attempt-budgets';
import { mfaChallenges } from '../entities/mfa-challenges';
import { mfaRecoveryCodes } from '../entities/mfa-recovery-codes';
import { mfaTotp } from '../entities/mfa-totp';
import { mfaVerifications } from '../entities/mfa-verifications';
import { passkeys } from '../entities/passkeys';
import { passwordResetTokens } from '../entities/password-reset-tokens';
import { userPublicKeys } from '../entities/user-public-keys';
import { userSocialAccounts } from '../entities/user-social-accounts';
import { users } from '../entities/users';
import { assertAccountLocked, accountLockChecked } from './account-lock';

type Database = RepositoryDatabase<PostgresJsDatabase<EmptyRelations>>;

/**
 * The tables that hold per-account credential state, each with why. The
 * tables of `entities` left out are in `account-state-coverage.test.ts`, each
 * with why not.
 */
export const CREDENTIAL_TABLES: ReadonlyMap<PgTable, string> = new Map<PgTable, string>([
    [users, 'status, key generation and password hash: what every admission reads'],
    [userPublicKeys, 'the device keys — the session credential itself'],
    [mfaChallenges, 'a pending key\'s gate: its mark activates the key'],
    [mfaAttemptBudgets, 'the second-factor failure budget: past its limit no proof is accepted'],
    [mfaVerifications, 'step-up records: a recent one admits the sensitive operations'],
    [mfaTotp, 'a second factor'],
    [mfaRecoveryCodes, 'a second factor, single-use'],
    [passkeys, 'a sign-in credential and a second factor'],
    [deviceAuthorizations, 'a device code: its approval registers a key on the account'],
    [deviceLinks, 'a device link: its confirmation registers a key on the account'],
    [userSocialAccounts, 'a provider identity: a way to sign in to the account'],
    [passwordResetTokens, 'a reset link: completing it replaces the password and revokes every key'],
    [keyRevokeAllTokens, 'a revoke-all link: spending it revokes every key'],
    [webauthnChallenges, 'a WebAuthn nonce: spending it is what lets an assertion sign in, renew, enrol or step up'],
    [oauth2Grants, 'a consent: a standing way in to the account for a client'],
    [oauth2AuthorizationCodes, 'a grant\'s single-use code, minted for a signed-in person under their consent'],
    [oauth2Tokens, 'a client\'s access and refresh tokens under a grant'],
    [opsTokens, 'an operator credential issued under its issuer\'s account, honoured while the issuer could issue it'],
]);

/** How one write method answers the account lock. */
export type AccountWrite<TArgs extends unknown[] = any[]> =
    | { account: (...args: TArgs) => number | readonly number[] }
    | { exempt: string };

type MethodKeys<T> = { [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never }[keyof T];

/**
 * A class's write methods, each with its answer. Public methods are typed off
 * their parameters; a private one is named by string, and a name that is no
 * method at all fails `account-state-coverage.test.ts`.
 */
export type AccountWrites<T> = {
    [K in MethodKeys<T>]?: T[K] extends (...args: infer A) => any ? AccountWrite<A> : never;
} & Record<string, AccountWrite>;

interface WriteFrame
{
    repository: AccountStateRepository;
    method: string;
    args: unknown[];
}

const frames = new AsyncLocalStorage<WriteFrame>();

const WRITE_STATEMENTS = new Set<PropertyKey>(['insert', 'update', 'delete', 'execute']);

export abstract class AccountStateRepository extends BaseRepository
{
    /** Overridden by every subclass: its write methods, classified. */
    static readonly accountWrites: Record<string, AccountWrite> = {};

    constructor()
    {
        super();

        if (accountLockChecked())
        {
            this.traceMethods();
        }
    }

    protected override get db(): Database
    {
        return accountLockChecked() ? this.guard(super.db as Database) : super.db as Database;
    }

    protected override get readDb(): Database
    {
        return accountLockChecked() ? this.guard(super.readDb as Database) : super.readDb as Database;
    }

    /** The write classification of one of this class's methods, if it has one. */
    accountWriteOf(method: string): AccountWrite | undefined
    {
        return (this.constructor as typeof AccountStateRepository).accountWrites[method];
    }

    /**
     * Run each own method in a frame naming it and its arguments, so a write
     * the method issues can be checked against its classification.
     */
    private traceMethods(): void
    {
        for (const [name, method] of ownMethods(Object.getPrototypeOf(this)))
        {
            Object.defineProperty(this, name, {
                value: (...args: unknown[]) => frames.run({ repository: this, method: name, args }, () => method.apply(this, args)),
                writable: true,
                configurable: true,
            });
        }
    }

    private guard(database: Database): Database
    {
        return new Proxy(database, {
            get: (target, property) =>
            {
                const value = Reflect.get(target, property, target);

                return WRITE_STATEMENTS.has(property) && typeof value === 'function'
                    ? (statement: unknown, ...rest: unknown[]) =>
                    {
                        this.checkWrite(statement);

                        return value.call(target, statement, ...rest);
                    }
                    : value;
            },
        });
    }

    /**
     * A raw `execute` names no table, so it is checked as a credential write:
     * the method that issues it must be classified either way.
     */
    private checkWrite(statement: unknown): void
    {
        if (isTable(statement) && !CREDENTIAL_TABLES.has(statement as PgTable))
        {
            return;
        }

        const frame = frames.getStore();
        const writer = `${this.constructor.name}.${frame?.repository === this ? frame.method : '<untraced>'}`;
        const write = frame?.repository === this ? this.accountWriteOf(frame.method) : undefined;
        const target = isTable(statement) ? getTableName(statement) : 'raw SQL';

        if (!write)
        {
            throw new Error(`${writer} writes ${target} — per-account credential state — and is not classified in accountWrites`);
        }

        if ('account' in write)
        {
            [write.account(...frame!.args)].flat().forEach(userId => assertAccountLocked(userId, writer));
        }
    }
}

/** Every method a repository class and its ancestors below this base declare. */
export function ownMethods(prototype: object): Map<string, (...args: unknown[]) => unknown>
{
    const methods = new Map<string, (...args: unknown[]) => unknown>();

    for (let proto = prototype; proto && proto !== AccountStateRepository.prototype && proto !== BaseRepository.prototype; proto = Object.getPrototypeOf(proto))
    {
        for (const name of Object.getOwnPropertyNames(proto))
        {
            const value = Object.getOwnPropertyDescriptor(proto, name)?.value;

            if (name !== 'constructor' && typeof value === 'function' && !methods.has(name))
            {
                methods.set(name, value);
            }
        }
    }

    return methods;
}
