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
 * - every method of every `AccountStateRepository` class — found by walking
 *   the files under `src/server` for one, not by what `repositories/index.ts`
 *   re-exports — as the compiled method source (`Function.prototype.toString`),
 *   that writes a credential table — a drizzle `insert`/`update`/`delete`, a
 *   core helper (`_create`, `_upsert`, `_updateOne`, `_deleteMany`, …) or a raw
 *   `execute` — has an `accountWrites` entry; such a class must be exported
 *   from its module, or it could not be checked;
 * - the code of every file under `src/server` outside the bodies of those
 *   classes (services, routes, other repositories, module-level helpers —
 *   those of a repository's own file included), with its comments removed,
 *   names no credential table as the target of such a write (`update (t)`
 *   with a space too) or of a `sql` template (`sql\`…\``, `sql<T>\`…\``) or
 *   `sql.raw(…)` string, quoted any way, that inserts into, updates or deletes
 *   from it.
 *
 * What neither sees, and only the runtime check (`AccountStateRepository`'s
 * guard, under test) can: a write built with `db.with(...)` or `$with`; one in
 * a `#private` method or an arrow-function class field of a base repository
 * (neither is on the prototype these checks walk); a class extending another
 * repository class rather than `AccountStateRepository` by name; a table
 * imported under another name; a write whose target is a variable rather than
 * the table's identifier; a `sql` string built by concatenation or held in a
 * variable; and a class body these checks cut short because a line inside it
 * starts with `}`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { BaseRepository } from '@spfn/core/db';
import { getTableName, isTable } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import ts from 'typescript';

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
    account_exists_notices: 'keyed by an address, not an account: when a signup to an address that has an account last sent its notice',
    account_deletion_requests: 'the request row is written under the account lock by account-deletion.service with the status it moves; the row itself admits nothing',
    ops_tokens: 'operator tokens: no account',
    oauth2_clients: 'third-party client registrations: no account',
};

/**
 * Statements that write, with the table they name — drizzle's three and the
 * core `BaseRepository` helpers — as source spells them (`table`) and as the
 * compiled method does (`(0, module.table)`, `__vi_import_0__.table`).
 */
const WRITE_PATTERN = /\.(?:insert|update|delete|_create|_createMany|_upsert|_updateOne|_updateMany|_deleteOne|_deleteMany)\s*\(\s*(?:\(0,\s*)?(?:[\w$]+\.)?([\w$]+)/g;
const EXECUTE_PATTERN = /\.execute\s*\(/;

/** A `sql` template that writes, with its target: an interpolated table, or a table name spelled out. */
const SQL_WRITE_PATTERN = /\b(?:insert\s+into|update|delete\s+from)\s+(?:\$\{\s*(?:\(0,\s*)?(?:[\w$]+\.)?([\w$]+)\s*\)?\s*\}|(?:"?\w+"?\.)?"?(\w+)"?)/gi;

/** The text of a `sql` template — typed (`sql<T>`) or not — or of a `sql.raw(…)` string in any quotes. */
const SQL_TEXT_PATTERN = /\bsql(?:\s*<[^>`]*>)?\s*`([^`]*)`|\bsql\s*\.\s*raw\s*\(\s*(?:`([^`]*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

/** A class extending the base, as code declares it — with its body, which ends at the first line starting with `}`. */
const REPOSITORY_CLASS_PATTERN = /^(?:export\s+)?class\s+([\w$]+)\s+extends\s+AccountStateRepository\b[\s\S]*?^\}/gm;

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
    const templates = [...source.matchAll(SQL_TEXT_PATTERN)]
        .map(text => (text[1] ?? text[2] ?? text[3] ?? text[4])!.replace(/\\(.)/g, '$1'))
        .flatMap(text => [...text.matchAll(SQL_WRITE_PATTERN)])
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

/** The tokens after which a `/` divides: anything else before it starts a regular expression. */
const ENDS_AN_OPERAND = new Set([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CloseBracketToken,
    ts.SyntaxKind.CloseBraceToken,
    ts.SyntaxKind.ThisKeyword,
    ts.SyntaxKind.SuperKeyword,
]);

const COMMENTS = new Set([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia]);

/**
 * Source with its comments removed, so what is matched is code, not text about
 * it. Read by the TypeScript scanner, token by token, so a comment marker inside
 * a string, a template or a regular expression is that literal's text and not a
 * comment. Everything else is kept as written, whitespace included.
 */
function withoutComments(source: string): string
{
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
    const templates: number[] = [];
    let previous = ts.SyntaxKind.Unknown;
    let code = '';

    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    {
        token = rescanned(scanner, token, previous, templates);

        if (!COMMENTS.has(token))
        {
            code += scanner.getTokenText();
        }

        if (!COMMENTS.has(token) && token !== ts.SyntaxKind.WhitespaceTrivia && token !== ts.SyntaxKind.NewLineTrivia)
        {
            previous = token;
        }
    }

    return code;
}

/**
 * The token as its context reads it, which the scanner alone cannot know: a
 * `/` that starts a regular expression, and a `}` that closes a template's
 * `${…}` and continues the template. `templates` holds, for each template open
 * around this point, how many braces are open inside its current substitution.
 */
function rescanned(scanner: ts.Scanner, token: ts.SyntaxKind, previous: ts.SyntaxKind, templates: number[]): ts.SyntaxKind
{
    if ((token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) && !ENDS_AN_OPERAND.has(previous))
    {
        return scanner.reScanSlashToken();
    }

    if (token === ts.SyntaxKind.CloseBraceToken && templates.at(-1) === 0)
    {
        const continued = scanner.reScanTemplateToken(false);

        if (continued === ts.SyntaxKind.TemplateTail)
        {
            templates.pop();
        }

        return continued;
    }

    countBraces(token, templates);

    return token;
}

function countBraces(token: ts.SyntaxKind, templates: number[]): void
{
    if (token === ts.SyntaxKind.TemplateHead)
    {
        templates.push(0);
    }
    else if (templates.length > 0 && token === ts.SyntaxKind.OpenBraceToken)
    {
        templates[templates.length - 1]! += 1;
    }
    else if (templates.length > 0 && token === ts.SyntaxKind.CloseBraceToken)
    {
        templates[templates.length - 1]! -= 1;
    }
}

/** The code of a file outside the bodies of its `AccountStateRepository` classes. */
function codeOutsideRepositories(source: string): string
{
    return withoutComments(source).replace(REPOSITORY_CLASS_PATTERN, '');
}

/** Every `AccountStateRepository` class declared in a file under `src/server`, by file and name. */
function declaredRepositoryClasses(): { path: string; name: string }[]
{
    return serverSources().flatMap(path => [...withoutComments(readFileSync(path, 'utf8')).matchAll(REPOSITORY_CLASS_PATTERN)]
        .map(match => ({ path, name: match[1]! })));
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

type RepositoryClass = typeof AccountStateRepository;

/**
 * Every `AccountStateRepository` class on disk, as its module exports it — or
 * the name of one its module does not export.
 */
async function repositoryClassesOnDisk(): Promise<{ classes: RepositoryClass[]; unexported: string[] }>
{
    const found = await Promise.all(declaredRepositoryClasses().map(async ({ path, name }) =>
    {
        const exported = (await import(path) as Record<string, unknown>)[name];

        return { name: `${relative(SERVER_ROOT, path)} ${name}`, exported: exported as RepositoryClass | undefined };
    }));

    return {
        classes: found.flatMap(({ exported }) => exported?.prototype instanceof AccountStateRepository ? [exported] : []),
        unexported: found.filter(({ exported }) => !(exported?.prototype instanceof AccountStateRepository)).map(({ name }) => name),
    };
}

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
            .flatMap(path => credentialWritesIn(codeOutsideRepositories(readFileSync(path, 'utf8')))
                .map(table => `${relative(SERVER_ROOT, path)} (${table})`));

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

    it('sees the shapes bundle 3 left open: sql.raw strings, typed templates, a spaced call, a comment that names the base', () =>
    {
        const shapes = [
            'await db.execute(sql.raw(\'update spfn_auth.passkeys set counter = 0\'))',
            'await db.execute(sql.raw("DELETE FROM \\"spfn_auth\\".\\"mfa_totp\\""))',
            'await db.execute(sql<number>`update ${userPublicKeys} set is_active = false`)',
            'await db.update (passkeys).set({ counter })',
        ];

        expect(shapes.map(shape => credentialWritesIn(shape))).toEqual([
            ['passkeys'], ['mfa_totp'], ['user_public_keys'], ['passkeys'],
        ]);

        const mentionsTheBase = [
            '// unlike class Keys extends AccountStateRepository, this helper is not a repository',
            'export async function wipe(db: Db) { await db.update(passkeys).set({ counter: 0 }); }',
        ].join('\n');

        expect(credentialWritesIn(codeOutsideRepositories(mentionsTheBase))).toEqual(['passkeys']);

        const helperBesideARepository = [
            'export class Stray extends AccountStateRepository',
            '{',
            '    async touch() { await this.db.update(passkeys).set({ counter: 1 }); }',
            '}',
            'export async function wipe(db: Db) { await db.delete(mfaTotp); }',
        ].join('\n');

        expect(credentialWritesIn(codeOutsideRepositories(helperBesideARepository))).toEqual(['mfa_totp']);
    });

    it('removes comments only: a comment marker inside a string, a template or a regular expression hides no write', () =>
    {
        const insideStrings = [
            'const opens = "a/*";',
            'await db.update(passkeys).set({ counter: 0 });',
            'const closes = "*/";',
        ].join('\n');
        const insideATemplate = 'const note = `a ${"/*"} b`;\nawait db.delete(mfaTotp);\nconst end = `*/`;';
        const insideARegex = 'const pattern = /[/*]/;\nawait db.update(userPublicKeys).set({ isActive: false });\nconst end = "*/";';
        const realComment = '/* await db.update(passkeys).set({ counter: 0 }); */\n// await db.delete(mfaTotp);\nconst url = "https://x//y";';

        expect(credentialWritesIn(withoutComments(insideStrings))).toEqual(['passkeys']);
        expect(credentialWritesIn(withoutComments(insideATemplate))).toEqual(['mfa_totp']);
        expect(credentialWritesIn(withoutComments(insideARegex))).toEqual(['user_public_keys']);
        expect(withoutComments(realComment)).toBe('\n\nconst url = "https://x//y";');
    });

    it('finds every AccountStateRepository class on disk, whether or not repositories/index.ts re-exports it', async () =>
    {
        const { classes, unexported } = await repositoryClassesOnDisk();
        const reExported = new Set(allRepositories.map(repository => repository.constructor));

        expect(unexported).toEqual([]);
        expect(classes.length).toBe(declaredRepositoryClasses().length);
        expect(classes.filter(cls => !reExported.has(cls)).map(cls => cls.name)).toEqual([]);
    });

    it('classifies every write method of every AccountStateRepository on disk, and nothing that is not one', async () =>
    {
        const unclassified: string[] = [];
        const stale: string[] = [];

        for (const repositoryClass of (await repositoryClassesOnDisk()).classes)
        {
            const methods = ownMethods(repositoryClass.prototype);
            const declared = repositoryClass.accountWrites;

            for (const [name, method] of methods)
            {
                if (credentialTablesWritten(method).length > 0 && !declared[name])
                {
                    unclassified.push(`${repositoryClass.name}.${name} (${credentialTablesWritten(method).join(', ')})`);
                }
            }

            stale.push(...Object.keys(declared).filter(name => !methods.has(name)).map(name => `${repositoryClass.name}.${name}`));
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
