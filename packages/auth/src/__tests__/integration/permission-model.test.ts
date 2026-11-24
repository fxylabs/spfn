/**
 * The permission model (audit bundle 5, w-4grpy).
 *
 * "What authority does this person hold now" has one answer (`resolveAuthority`),
 * and "who may give or take which role" one rule (`assertCanChangeRole`): a
 * caller gives or takes only roles ranked strictly below their own.
 *
 * | Row | Checks                                                                                            | Unnoticed without it                         |
 * |-----|---------------------------------------------------------------------------------------------------|----------------------------------------------|
 * | T1  | deactivating a role → its holders get 403 on a `requireRole` and a `requirePermissions` route,    | recurrence of au1-A2                         |
 * |     | `/session` shows no role and only per-user permissions; reactivating → restored                   |                                              |
 * | T2  | per-user grant, per-user revoke, expired grant, expired revoke, grant of an inactive permission:  | the screen and the server drifting apart     |
 * |     | the `/session` permission list equals the permission-gated routes that admit                     |                                              |
 * | T3  | role-change table: caller priority × target's current role × new role                             | the rule missing for a role with another name |
 * | T4  | an admin invites, is demoted (or suspended), the invitation is accepted → 410, no account          | old authority conferring a role              |
 * | T5  | an ops token whose issuer was demoted / suspended / had `ops:token:issue` revoked per-user / whose | au1-A9; a token outliving its issuer's right |
 * |     | role was deactivated → refused; a token with no issuer → refused; issuance without step-up → 403; |                                              |
 * |     | issuer suspended after the guard, before the insert → 403 and no token row                        |                                              |
 * | T6  | a permission removed from config is gone from its role after the next boot; an operator's stays   | config edits not reducing authority          |
 * | T7  | every 'admin' / 'superadmin' literal, property name, and built-in role identifier (`rbac/builtin` | role-name decisions spreading again          |
 * |     | exports naming roles) under `src/` (TypeScript scanner) is in the permission module / seed        |                                              |
 * |     | defaults, a `requireRole(...)` argument, or an exemption. NOT caught: a name built by             |                                              |
 * |     | concatenation or computed at run time ('superad' + 'min', a role name read from data)             |                                              |
 * | T8  | a mapping has one owner: a set keeps config's mappings config's (Opus P1); a config mapping       | config losing a mapping to the operator, or  |
 * |     | deleted at runtime is back after a reboot with the same config (Codex 3); set omitting / remove   | an unchanged config not restoring its own    |
 * |     | of a config mapping → 409, nothing changed; adding one config declares → unchanged; config takes  |                                              |
 * |     | over an operator mapping it comes to declare                                                      |                                              |
 * | T9  | caller demoted after the request's guard ran, before the change's lock → 403, target unchanged    | authority judged from a stale snapshot       |
 * |     | (Codex probe)                                                                                     |                                              |
 * | T10 | caller × action × object: create / re-rank at ≥ own priority, edit or delete an equal or higher   | role definitions and per-user grants outside |
 * |     | role, confer a permission not held, per-user grant / revoke on an equal → 403, nothing changed;   | the rule                                     |
 * |     | the allowed cells → 200                                                                           |                                              |
 * | T11 | a role re-ranked above the caller by a transaction holding its lock is not given on its old rank  | a role judged on a value its own change      |
 * |     | (PROBE-A) → 403, the target unchanged                                                             | replaces before the write commits            |
 * | T12 | deleting a role an account holds, or a pending invitation promises → 409 ROLE_IN_USE with counts, | deleting a role deleting accounts            |
 * |     | the holder's account unchanged (PROBE-B); a role nothing names → 204, deleted; a role whose only  |                                              |
 * |     | reference is a pending invitation past its expiry → 204, the invitation deleted with it (a05f4 J3)| an expired invitation blocking a deletion    |
 * | T13 | two boots adding a mapping at once (PROBE-C); an operator add landing between the boot's read and | a boot failing on a unique violation, or an  |
 * |     | its write (PROBE-D) → both succeed, one row, config's; a set racing a boot's takeover → 409       | operator deleting what config now owns       |
 * | T14 | a config-declared role: delete → 409, re-rank via the API → 409, isActive still the operator's;   | config's roles drifting from config at run   |
 * |     | a boot with unchanged config restores a priority changed directly in the table                    | time                                         |
 * | T15 | a permission held only through an expiring grant: attached to a role → 403; granted per user      | a temporary grant made permanent             |
 * |     | for longer, or for good → 403; until the caller's own expiry or earlier → 200                     |                                              |
 * | T16 | A re-ranks role X holding role Y while B re-ranks Y holding X; whichever starts is held after its  | an admin action failing with 500 under       |
 * |     | first role lock until the other waits on a lock → neither 500, each the answer the rank rule      | concurrent role edits                        |
 * |     | gives; a caller whose role changes between the read naming it and the lock, and again when the    |                                              |
 * |     | change is judged once more → 409 AUTHORITY_CONTENDED, nothing changed (the retry is bounded)      |                                              |
 * | T17 | a premise gone stale between holdAuthority's two reads is judged again on fresh reads: an inviter | an invitee refused with a retry message      |
 * |     | demoted then → 410 at acceptance, no account (RV1); a caller whose role is deactivated then → 403;| about another person's role                  |
 * |     | an inviter promoted then → 200, one invitation, its event once                                    |                                              |
 * | T18 | a boot of configuration A held mid-sync while B boots: B waits for A, the end state is B's (RV5); | an operator-owned role carrying config-owned |
 * |     | a boot that cannot take the sync lock within its wait → refused naming the holder, nothing written| mappings after a rolling deploy; an          |
 * |     | a boot that cannot take a declared role an operator holds → the same refusal naming the role lock | unreadable boot failure during a deploy      |
 * |     | and its holder, nothing written (a05f6 P3)                                                        |                                              |
 * | T19 | a boot with a one-connection write pool completes and syncs (a05f5 P1); a role the configuration  | a silent boot hang on small pools; a role    |
 * |     | declares, created by an operator in its own transaction after the sync read the roles → synced    | locked out of id order                       |
 * |     | again, the role taken over as config's (a05f6 P1b)                                                |                                              |
 *
 * Every row enters through the production path: the auth router mounted with
 * `authenticate` as a server middleware, app routes guarded by `requireRole` /
 * `requirePermissions`, an ops surface behind `opsTokenAuth`, and
 * `initializeAuth` for boot. Per-user grants and permission deactivation have
 * no route in the package, so those rows write them as the app would.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import ts from 'typescript';
import { closeDatabase, initDatabase, runInTransaction } from '@spfn/core/db';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { JSON_HEADERS, TEST_PASSWORD, createTestUser, resetMemoryRateLimitStore, signIn } from '../helpers/oauth2';
import { configureChannels } from '@/server/lib/channels-config';
import { mfaTotp, mfaVerifications, opsTokens, permissions, rolePermissions, roles, userInvitations, userPermissions, users } from '@/server/entities';
import { rolePermissionsRepository, rolesRepository, usersRepository } from '@/server/repositories';
import { generateKeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authenticate } from '@/server/middleware/authenticate';
import { requirePermissions } from '@/server/middleware/require-permission';
import { requireRole } from '@/server/middleware/require-role';
import { opsTokenAuth, requireOpsScope } from '@/server/middleware/ops-token-auth';
import { setAccountStatus } from '@/server/services/user.service';

const { mainAuthRouter } = await import('@/server/routes');
const { route, defineRouter, registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { createOpsRouter, opsRoute } = await import('@spfn/core/ops');
const { initializeAuth } = await import('@/server/services/rbac.service');
const {
    addPermissionToRole,
    createRole,
    deleteRole,
    getRoleByName,
    getRolePermissions,
    removePermissionFromRole,
    setRolePermissions,
    updateRole,
} = await import('@/server/services/role.service');
const { changeUserRole, grantUserPermission, revokeUserPermission } = await import('@/server/services/permission.service');
const { createInvitation } = await import('@/server/services/invitation.service');
const { invitationCreatedEvent } = await import('@/server/events');
const { RbacSyncBusyError } = await import('@spfn/auth/errors');

const dbAvailable = await isDatabaseAvailable();

/** The permissions the app gates routes with — one route each. */
const GATED = ['post:edit', 'report:read', 'report:export', 'audit:read', 'billing:read'];

/** Held by no role: what nobody may confer. */
const UNHELD = 'vault:open';

/**
 * App-defined roles around the built-in ones: superadmin 100, admin 80, user
 * 10. The superadmin holds the gated permissions, so it may attach them.
 */
const CONFIG = {
    roles: [
        { name: 'lead', displayName: 'Lead', priority: 90 },
        { name: 'editor', displayName: 'Editor', priority: 50 },
        { name: 'retired', displayName: 'Retired', priority: 20 },
    ],
    permissions: [...GATED, UNHELD].map(name => ({ name, displayName: name })),
    rolePermissions: { editor: ['post:edit', 'report:read'], superadmin: [...GATED] },
};

const OPS_SCOPE = 'reports:read';

function gatedPath(permission: string): string
{
    return `/t/perm/${permission.replace(':', '-')}`;
}

const appRouter = defineRouter({
    editorOnly: route.get('/t/role/editor')
        .use([requireRole('editor')])
        .handler(async () => ({ ok: true })),
    ...Object.fromEntries(GATED.map(permission => [
        permission.replace(':', '_'),
        route.get(gatedPath(permission))
            .use([requirePermissions(permission)])
            .handler(async () => ({ ok: true })),
    ])),
});

const opsRouter = createOpsRouter({
    ping: opsRoute.get('/ping')
        .use([requireOpsScope(OPS_SCOPE)])
        .handler(async () => ({ ok: true })),
}, { auth: opsTokenAuth });

const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Where a built-in role may be named: the permission module, and the seed
 * defaults — the built-in role definitions, the configuration sync that seeds
 * them, and admin seeding.
 */
const ROLE_NAMES_ALLOWED = ['server/services/permission.service.ts', 'server/rbac/builtin.ts', 'server/services/rbac.service.ts', 'server/setup.ts'];

/** `file: literal` occurrences that name no role at all, each with why. */
const ROLE_NAME_EXEMPTIONS: Record<string, string> = {
    'server/entities/ownership.ts: \'admin\'': 'the owner of a role or mapping (an operator, OPERATOR_OWNED), a stored column value',
    'server/types.ts: \'admin\'': 'who requested an account deletion (ACCOUNT_DELETION_REQUESTED_BY), not a role',
    'server/events/index.ts: \'admin\'': 'the same requester value, in the deletion event\'s schema',
};

const ROLE_NAMES = new Set(['admin', 'superadmin']);

/**
 * The built-in role identifiers: what `rbac/builtin.ts` exports under a name
 * that speaks of roles (`BUILTIN_ROLES`, `BUILTIN_ROLE_PERMISSIONS`,
 * `BuiltinRoleName`, …), read from its declarations so a new export is covered
 * without being listed here.
 */
const ROLE_NAME_CONSTANTS = new Set(exportedNames(join(SOURCE_ROOT, 'server/rbac/builtin.ts'))
    .filter(name => /role/i.test(name)));

/** The names a source file exports through `export const` / `export type` / `export interface` declarations. */
function exportedNames(path: string): string[]
{
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);

    return source.statements
        .filter(statement => ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
        .flatMap((statement) =>
        {
            if (ts.isVariableStatement(statement))
            {
                return statement.declarationList.declarations.map(declaration => declaration.name.getText(source));
            }

            return ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) ? [statement.name.text] : [];
        });
}

/** Every source file under `src/`, tests left out. */
function sourceFiles(directory: string): string[]
{
    return readdirSync(directory).flatMap((entry) =>
    {
        const path = join(directory, entry);

        if (statSync(path).isDirectory())
        {
            return entry === '__tests__' ? [] : sourceFiles(path);
        }

        return /\.tsx?$/.test(path) && !/\.(test|d)\.tsx?$/.test(path) ? [path] : [];
    });
}

/**
 * Each place a source text names a built-in role — a string literal `'admin'`
 * / `'superadmin'` (quoted or template, in any expression, over any number of
 * lines), a property name equal to one (`{ superadmin: … }[role]`,
 * `limits.admin`), or a reference to the built-in role identifiers — that is
 * not an argument of a `requireRole(...)` declaration, as `<name>@<line>`.
 * A name assembled by concatenation or computed at run time is not seen.
 */
function roleNamesIn(fileName: string, text: string): string[]
{
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node): void =>
    {
        const name = roleNameOf(node);

        if (name !== null && !isRequireRoleArgument(node))
        {
            found.push(`${name}@${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    return found;
}

/** `'admin'` for the literal, `.admin` for a property name, `BUILTIN_ROLES` for an identifier, null for anything else. */
function roleNameOf(node: ts.Node): string | null
{
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ROLE_NAMES.has(node.text))
    {
        return `'${node.text}'`;
    }

    if (ts.isIdentifier(node) && ROLE_NAMES.has(node.text) && isPropertyName(node))
    {
        return `.${node.text}`;
    }

    return ts.isIdentifier(node) && ROLE_NAME_CONSTANTS.has(node.text) ? node.text : null;
}

/** An identifier in the name position of a property: an object key, a member access, a declared member. */
function isPropertyName(node: ts.Identifier): boolean
{
    const parent = node.parent;

    if (ts.isShorthandPropertyAssignment(parent))
    {
        return true;
    }

    const named = ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent) || ts.isPropertySignature(parent)
        || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isBindingElement(parent);

    return named && (parent.name === node || (ts.isBindingElement(parent) && parent.propertyName === node));
}

function isRequireRoleArgument(node: ts.Node): boolean
{
    const parent = node.parent;

    return ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'requireRole'
        && parent.arguments.includes(node as ts.Expression);
}

function gate(): { open: () => void; opened: Promise<void> }
{
    let open!: () => void;
    const opened = new Promise<void>((resolve) =>
    {
        open = resolve;
    });

    return { open, opened };
}

/** Until some backend of this database waits on a lock, or `done()`. */
async function untilSomeoneWaitsOrDone(done: () => boolean = () => false): Promise<void>
{
    for (let i = 0; i < 200 && !done(); i++)
    {
        const rows = await getTestDb().execute(sql`
            SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND a.datname = current_database()`);
        if (Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0)
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (!done())
    {
        throw new Error('no lock wait observed');
    }
}

describe.skipIf(!dbAvailable)('The permission model (bundle 5)', () =>
{
    let app: Hono;
    let ip = 0;
    const ids: Record<string, number> = {};

    beforeAll(async () =>
    {
        await setupTestDb();
        // invitations is off unless the app states it (#475).
        configureChannels({ invitations: true });
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 7).toString('base64')}`;

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        registerRoutes(app, appRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        registerRoutes(app, opsRouter);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        vi.stubEnv('SPFN_API_URL', 'http://api.permission-model.test');
        await initializeAuth(CONFIG);

        // 'retired' exists and is inactive: giving it is a 409
        await getTestDb().update(roles).set({ isActive: false }).where(eq(roles.name, 'retired'));

        const accounts: Array<[string, string]> = [
            ['superadmin', 'superadmin'],
            ['superadmin2', 'superadmin'],
            ['admin', 'admin'],
            ['admin2', 'admin'],
            ['lead', 'lead'],
            ['editor', 'editor'],
            ['user', 'user'],
        ];

        for (const [name, role] of accounts)
        {
            ids[name] = await createTestUser(`${name}@test.com`, await roleId(role));
        }
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    async function roleId(name: string): Promise<number>
    {
        return (await getRoleByName(name))!.id;
    }

    async function permissionId(name: string): Promise<number>
    {
        const [row] = await getTestDb().select().from(permissions).where(eq(permissions.name, name));

        return Number(row!.id);
    }

    async function storedRoleOf(account: string): Promise<number>
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.id, ids[account]!));

        return Number(row!.roleId);
    }

    async function signInAs(account: string): Promise<string>
    {
        ip += 1;

        return signIn(app, `${account}@test.com`, `198.51.100.${ip % 250}`);
    }

    async function call(method: string, path: string, authorization?: string, body?: unknown): Promise<Response>
    {
        return app.request(path, {
            method,
            headers: { ...JSON_HEADERS, ...(authorization ? { Authorization: authorization } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    async function sessionOf(authorization: string): Promise<{ role: { name: string } | null; permissions: string[] }>
    {
        const response = await call('GET', '/_auth/session', authorization);
        expect(response.status).toBe(200);
        const session = await response.json();

        return { role: session.role, permissions: session.permissions.map((p: { name: string }) => p.name).sort() };
    }

    async function override(account: string, permission: string, values: { granted: boolean; expiresAt?: Date }): Promise<void>
    {
        await getTestDb().insert(userPermissions).values({
            userId: ids[account]!,
            permissionId: await permissionId(permission),
            ...values,
        });
    }

    async function admittedPermissions(authorization: string): Promise<string[]>
    {
        const admitted: string[] = [];

        for (const permission of GATED)
        {
            const status = (await call('GET', gatedPath(permission), authorization)).status;
            expect([200, 403]).toContain(status);

            if (status === 200)
            {
                admitted.push(permission);
            }
        }

        return admitted.sort();
    }

    async function setRoleActive(superadmin: string, role: string, isActive: boolean): Promise<void>
    {
        expect((await call('PATCH', `/_auth/admin/roles/${await roleId(role)}`, superadmin, { isActive })).status).toBe(200);
    }

    async function changeRole(caller: string, target: string, newRoleId: number): Promise<Response>
    {
        return call('PATCH', `/_auth/admin/users/${ids[target]}/role`, caller, { roleId: newRoleId });
    }

    /**
     * The next account lock taken first commits `values` to `userId`'s row
     * from outside the request — the request's guard has run, its write has
     * not — and then takes the lock.
     */
    function commitBeforeLock(userId: number, values: Partial<typeof users.$inferInsert>): void
    {
        const original = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementationOnce(async (id) =>
        {
            await getTestDb().update(users).set(values).where(eq(users.id, userId));

            return original(id);
        });
    }

    /** A role's mappings as `permission:source`, sorted. */
    async function mappingsOf(role: string): Promise<string[]>
    {
        const rows = await getTestDb()
            .select({ name: permissions.name, source: rolePermissions.source })
            .from(rolePermissions)
            .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
            .where(eq(rolePermissions.roleId, await roleId(role)));

        return rows.map(row => `${row.name}:${row.source}`).sort();
    }

    /** The answer a service call gives, as the status its route would. */
    async function statusOf(call: Promise<unknown>): Promise<number>
    {
        return call.then(() => 200, (error: { statusCode?: number }) => error.statusCode ?? 500);
    }

    /** Roles, mappings and per-user overrides: what a refused change must leave as it was. */
    async function authorityState(): Promise<unknown[]>
    {
        const db = getTestDb();

        return [
            await db.select().from(roles).orderBy(roles.id),
            await db.select().from(rolePermissions).orderBy(rolePermissions.id),
            await db.select().from(userPermissions).orderBy(userPermissions.id),
        ];
    }

    it('T1: a deactivated role confers nothing — role route, permission route, /session — and reactivating restores it', async () =>
    {
        await override('editor', 'report:export', { granted: true });
        const editor = await signInAs('editor');
        const superadmin = await signInAs('superadmin');

        expect((await call('GET', '/t/role/editor', editor)).status).toBe(200);
        expect((await call('GET', gatedPath('post:edit'), editor)).status).toBe(200);

        await setRoleActive(superadmin, 'editor', false);

        expect((await call('GET', '/t/role/editor', editor)).status).toBe(403);
        expect((await call('GET', gatedPath('post:edit'), editor)).status).toBe(403);
        expect(await sessionOf(editor)).toEqual({ role: null, permissions: ['report:export'] });

        await setRoleActive(superadmin, 'editor', true);

        expect((await call('GET', '/t/role/editor', editor)).status).toBe(200);
        expect((await call('GET', gatedPath('post:edit'), editor)).status).toBe(200);
        const restored = await sessionOf(editor);
        expect(restored.role?.name).toBe('editor');
        expect(restored.permissions).toEqual(['post:edit', 'report:export', 'report:read']);
    });

    it('T2: /session lists exactly the permissions whose routes admit — grant, revoke, expired grant, expired revoke, inactive permission', async () =>
    {
        await override('editor', 'report:export', { granted: true });
        await override('editor', 'report:read', { granted: false });
        await override('editor', 'post:edit', { granted: false, expiresAt: new Date(Date.now() - 60_000) });
        await override('editor', 'audit:read', { granted: true, expiresAt: new Date(Date.now() - 60_000) });
        await override('editor', 'billing:read', { granted: true });
        await getTestDb().update(permissions).set({ isActive: false }).where(eq(permissions.name, 'billing:read'));
        const editor = await signInAs('editor');

        const listed = (await sessionOf(editor)).permissions.filter(name => GATED.includes(name));
        const admitted = await admittedPermissions(editor);

        expect(listed).toEqual(admitted);
        expect(admitted).toEqual(['post:edit', 'report:export']);
    });

    describe('T3: a role is given or taken only by a caller who outranks it and the role it replaces', () =>
    {
        const ROWS: Array<[string, string, string, string, number]> = [
            ['admin gives a role below their own', 'admin', 'user', 'editor', 200],
            ['admin takes an app-defined role below their own', 'admin', 'editor', 'user', 200],
            ['admin gives their own (equal) role', 'admin', 'user', 'admin', 403],
            ['admin gives an app-defined role above their own', 'admin', 'user', 'lead', 403],
            ['admin gives superadmin', 'admin', 'user', 'superadmin', 403],
            ['admin demotes an equal', 'admin', 'admin2', 'user', 403],
            ['admin changes the holder of an app-defined role above their own', 'admin', 'lead', 'user', 403],
            ['admin gives an unknown role', 'admin', 'user', '<unknown>', 404],
            ['admin gives an inactive role', 'admin', 'user', 'retired', 409],
            ['superadmin creates an admin', 'superadmin', 'user', 'admin', 200],
            ['superadmin demotes an admin', 'superadmin', 'admin2', 'user', 200],
            ['superadmin gives an app-defined role above admin', 'superadmin', 'user', 'lead', 200],
            ['superadmin demotes an equal', 'superadmin', 'superadmin2', 'user', 403],
        ];

        it.each(ROWS)('%s (%s changes %s to %s) → %i', async (_label, caller, target, newRole, status) =>
        {
            const before = await storedRoleOf(target);
            const newRoleId = newRole === '<unknown>' ? 999_999 : await roleId(newRole);

            const response = await changeRole(await signInAs(caller), target, newRoleId);

            expect(response.status).toBe(status);
            expect(await storedRoleOf(target)).toBe(status === 200 ? newRoleId : before);
        });
    });

    describe('T4: an invitation is refused once its inviter could no longer give its role', () =>
    {
        async function invite(inviter: string, email: string): Promise<string>
        {
            const response = await call('POST', '/_auth/invitations', await signInAs(inviter), { email, roleId: await roleId('editor') });
            expect(response.status).toBe(200);

            return (await response.json()).token;
        }

        async function accept(token: string): Promise<Response>
        {
            const key = generateKeyPair('ES256');

            return call('POST', '/_auth/invitations/accept', undefined, {
                token,
                password: TEST_PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });
        }

        async function expectRefusedWithoutAccount(token: string, email: string): Promise<void>
        {
            expect((await accept(token)).status).toBe(410);
            expect(await getTestDb().select().from(users).where(eq(users.email, email))).toEqual([]);
            const [invitation] = await getTestDb().select().from(userInvitations).where(eq(userInvitations.email, email));
            expect(invitation!.status).toBe('pending');
        }

        it('demoted inviter → 410, no account', async () =>
        {
            const token = await invite('admin', 'invitee@test.com');

            expect((await changeRole(await signInAs('superadmin'), 'admin', await roleId('user'))).status).toBe(200);

            await expectRefusedWithoutAccount(token, 'invitee@test.com');
        });

        it('suspended inviter → 410, no account', async () =>
        {
            const token = await invite('admin2', 'invitee2@test.com');

            expect(await setAccountStatus(ids.admin2!, 'suspended', { from: 'active', reason: 'T4' })).toBe('changed');

            await expectRefusedWithoutAccount(token, 'invitee2@test.com');
        });

        it('inviter unchanged → accepted', async () =>
        {
            expect((await accept(await invite('admin', 'invitee3@test.com'))).status).toBe(200);
        });
    });

    describe('T5: an ops token works only while its issuer could issue it', () =>
    {
        async function issue(authorization: string): Promise<Response>
        {
            return call('POST', '/_auth/ops-tokens', authorization, { name: 'T5', scopes: [OPS_SCOPE] });
        }

        async function issuedToken(issuer: string): Promise<string>
        {
            const response = await issue(await signInAs(issuer));
            expect(response.status).toBe(200);
            const token = `Bearer ${(await response.json()).token}`;
            expect((await call('GET', '/_ops/ping', token)).status).toBe(200);

            return token;
        }

        it('issuer demoted → refused', async () =>
        {
            const token = await issuedToken('admin');

            expect((await changeRole(await signInAs('superadmin'), 'admin', await roleId('user'))).status).toBe(200);

            expect((await call('GET', '/_ops/ping', token)).status).toBe(401);
        });

        it('issuer suspended → refused', async () =>
        {
            const token = await issuedToken('admin2');

            expect(await setAccountStatus(ids.admin2!, 'suspended', { from: 'active', reason: 'T5' })).toBe('changed');

            expect((await call('GET', '/_ops/ping', token)).status).toBe(401);
        });

        it('issuer\'s ops:token:issue revoked per-user → refused', async () =>
        {
            const token = await issuedToken('admin');

            await override('admin', 'ops:token:issue', { granted: false });

            expect((await call('GET', '/_ops/ping', token)).status).toBe(401);
        });

        it('issuer\'s role deactivated → refused', async () =>
        {
            const token = await issuedToken('admin');

            await setRoleActive(await signInAs('superadmin'), 'admin', false);

            expect((await call('GET', '/_ops/ping', token)).status).toBe(401);
        });

        it('a token with no issuer (issued before issuers were recorded) → refused', async () =>
        {
            const token = await issuedToken('admin');

            await getTestDb().update(opsTokens).set({ issuedBy: null });

            expect((await call('GET', '/_ops/ping', token)).status).toBe(401);
        });

        it('issuer suspended after the guard ran, before the insert → 403, no token row', async () =>
        {
            const admin = await signInAs('admin');
            commitBeforeLock(ids.admin!, { status: 'suspended' });

            expect((await issue(admin)).status).toBe(403);
            expect(await getTestDb().select().from(opsTokens)).toEqual([]);
        });

        it('issuance by an account with a second factor and no step-up → 403 STEP_UP_REQUIRED', async () =>
        {
            const admin = await signInAs('admin');
            const code = (secret: string) => hotp(decodeBase32(secret), totpStep(Date.now()));
            const { secret } = await (await call('POST', '/_auth/mfa/totp/enroll', admin, {})).json();
            expect((await call('POST', '/_auth/mfa/totp/confirm', admin, { code: code(secret) })).status).toBe(200);
            // The step-up window this device earned by confirming has passed
            await getTestDb().delete(mfaVerifications);

            const refused = await issue(admin);
            expect(refused.status).toBe(403);
            expect((await refused.json()).code).toBe('STEP_UP_REQUIRED');

            await getTestDb().update(mfaTotp).set({ lastUsedStep: null });
            expect((await call('POST', '/_auth/mfa/step-up', admin, { code: code(secret) })).status).toBe(204);
            expect((await issue(admin)).status).toBe(200);
        });
    });

    it('T6: a permission removed from config is gone from its role after the next boot; an operator-added one stays', async () =>
    {
        const editor = await roleId('editor');
        await addPermissionToRole(ids.superadmin!, editor, await permissionId('audit:read'));

        await initializeAuth({ ...CONFIG, rolePermissions: { editor: ['post:edit'] } });

        expect((await getRolePermissions(editor)).sort()).toEqual(['audit:read', 'post:edit']);
    });

    describe('T8: a mapping has one owner, and the configuration\'s stay the configuration\'s', () =>
    {
        it('P1: a set keeps the configuration\'s mappings its own, so removing one from config removes it', async () =>
        {
            const editor = await roleId('editor');
            const kept = [await permissionId('post:edit'), await permissionId('report:read'), await permissionId('audit:read')];

            await setRolePermissions(ids.superadmin!, editor, kept);
            expect(await mappingsOf('editor')).toEqual(['audit:read:admin', 'post:edit:config', 'report:read:config']);

            await initializeAuth({ ...CONFIG, rolePermissions: { ...CONFIG.rolePermissions, editor: ['report:read'] } });

            expect(await mappingsOf('editor')).toEqual(['audit:read:admin', 'report:read:config']);
        });

        it('Codex 3: a config mapping removed at runtime is back after a reboot with the same config', async () =>
        {
            await getTestDb().delete(rolePermissions).where(and(
                eq(rolePermissions.roleId, await roleId('editor')),
                eq(rolePermissions.permissionId, await permissionId('post:edit')),
            ));

            await initializeAuth(CONFIG);

            expect(await mappingsOf('editor')).toEqual(['post:edit:config', 'report:read:config']);
        });

        it('a set that leaves out a config mapping → 409, nothing changed', async () =>
        {
            const before = await authorityState();
            const set = setRolePermissions(ids.superadmin!, await roleId('editor'), [await permissionId('report:read'), await permissionId('audit:read')]);

            await expect(set).rejects.toMatchObject({ statusCode: 409, code: 'CONFIG_OWNED_MAPPING' });
            expect(await authorityState()).toEqual(before);
        });

        it('removing a config mapping → 409, nothing changed', async () =>
        {
            const before = await authorityState();
            const remove = removePermissionFromRole(ids.superadmin!, await roleId('editor'), await permissionId('post:edit'));

            await expect(remove).rejects.toMatchObject({ statusCode: 409, code: 'CONFIG_OWNED_MAPPING' });
            expect(await authorityState()).toEqual(before);
        });

        it('adding a mapping config declares → unchanged and the configuration\'s; it leaves when config drops it', async () =>
        {
            const mapping = await addPermissionToRole(ids.superadmin!, await roleId('editor'), await permissionId('post:edit'));

            expect(mapping.source).toBe('config');
            expect(await mappingsOf('editor')).toEqual(['post:edit:config', 'report:read:config']);

            await initializeAuth({ ...CONFIG, rolePermissions: { ...CONFIG.rolePermissions, editor: ['report:read'] } });

            expect(await mappingsOf('editor')).toEqual(['report:read:config']);
        });

        it('an operator mapping the configuration comes to declare becomes the configuration\'s', async () =>
        {
            await addPermissionToRole(ids.superadmin!, await roleId('editor'), await permissionId('audit:read'));
            const declaring = { ...CONFIG, rolePermissions: { ...CONFIG.rolePermissions, editor: ['post:edit', 'report:read', 'audit:read'] } };

            await initializeAuth(declaring);
            expect(await mappingsOf('editor')).toEqual(['audit:read:config', 'post:edit:config', 'report:read:config']);

            await initializeAuth(CONFIG);
            expect(await mappingsOf('editor')).toEqual(['post:edit:config', 'report:read:config']);
        });
    });

    it('T9: a caller demoted after the request\'s guard ran is refused, and the target is unchanged', async () =>
    {
        const admin = await signInAs('admin');
        const before = await storedRoleOf('user');
        commitBeforeLock(ids.admin!, { roleId: await roleId('user') });

        expect((await changeRole(admin, 'user', await roleId('editor'))).status).toBe(403);
        expect(await storedRoleOf('user')).toBe(before);
    });

    describe('T10: a caller changes only what ranks strictly below them, and confers only what they hold', () =>
    {
        type Action = (caller: number, authorization: () => Promise<string>) => Promise<number>;

        const createAt = (priority: number, permissionNames: string[] = []): Action => async (_caller, authorization) =>
            (await call('POST', '/_auth/admin/roles', await authorization(), {
                name: `t10-${priority}`,
                displayName: 'T10',
                priority,
                permissionIds: await Promise.all(permissionNames.map(permissionId)),
            })).status;
        const patchRole = (role: string, body: Record<string, unknown>): Action => async (_caller, authorization) =>
            (await call('PATCH', `/_auth/admin/roles/${await roleId(role)}`, await authorization(), body)).status;
        const deleteRoleRoute = (role: string): Action => async (_caller, authorization) =>
            (await call('DELETE', `/_auth/admin/roles/${await roleId(role)}`, await authorization())).status;
        const createRoleAs = (priority: number): Action => async caller =>
            statusOf(createRole(caller, { name: `t10s-${priority}`, displayName: 'T10', priority }));
        const updateRoleAs = (role: string, data: { displayName?: string; isActive?: boolean }): Action => async caller =>
            statusOf(updateRole(caller, await roleId(role), data));
        const attach = (role: string, permission: string): Action => async caller =>
            statusOf(addPermissionToRole(caller, await roleId(role), await permissionId(permission)));
        const setOn = (role: string, permissionNames: string[]): Action => async caller =>
            statusOf(setRolePermissions(caller, await roleId(role), await Promise.all(permissionNames.map(permissionId))));
        const grant = (target: string, permission: string): Action => async caller =>
            statusOf(grantUserPermission(caller, ids[target]!, await permissionId(permission)));
        const revoke = (target: string, permission: string): Action => async caller =>
            statusOf(revokeUserPermission(caller, ids[target]!, await permissionId(permission)));

        // An operator's role below admin: its definition is the operator's to change
        beforeEach(async () =>
        {
            await createRole(ids.superadmin!, { name: 'crew', displayName: 'Crew', priority: 60 });
        });

        const ROWS: Array<[string, string, Action, number]> = [
            ['creates a role at their own priority', 'superadmin', createAt(100), 403],
            ['creates a role above their own priority (Codex probe: 101)', 'superadmin', createAt(101), 403],
            ['creates a role below their own priority', 'superadmin', createAt(99), 200],
            ['creates a role with a permission they do not hold', 'superadmin', createAt(30, [UNHELD]), 403],
            ['creates a role with permissions they hold', 'superadmin', createAt(30, ['report:read']), 200],
            ['re-ranks a lower role to their own priority', 'superadmin', patchRole('lead', { priority: 100 }), 403],
            ['re-ranks a lower role to below their own', 'superadmin', patchRole('crew', { priority: 95 }), 200],
            ['edits their own (equal) role', 'superadmin', patchRole('superadmin', { displayName: 'Root' }), 403],
            ['deletes their own (equal) role, superadmin', 'superadmin', deleteRoleRoute('superadmin'), 403],
            ['creates a role at their own priority', 'admin', createRoleAs(80), 403],
            ['creates a role below their own priority', 'admin', createRoleAs(79), 200],
            ['edits a higher role', 'admin', updateRoleAs('lead', { displayName: 'Boss' }), 403],
            ['deactivates their own (equal) role', 'admin', updateRoleAs('admin', { isActive: false }), 403],
            ['edits a lower role', 'admin', updateRoleAs('crew', { displayName: 'Writer' }), 200],
            ['attaches a permission they do not hold', 'admin', attach('editor', 'audit:read'), 403],
            ['attaches a permission they hold', 'admin', attach('editor', 'user:read'), 200],
            ['sets the permissions of a higher role', 'admin', setOn('lead', []), 403],
            ['grants a permission they do not hold', 'admin', grant('user', 'audit:read'), 403],
            ['grants a permission they hold to a lower person', 'admin', grant('user', 'user:read'), 200],
            ['grants a permission they hold to an equal', 'admin', grant('admin2', 'user:read'), 403],
            ['revokes a permission from an equal', 'admin', revoke('admin2', 'user:read'), 403],
            ['revokes a permission from a lower person', 'admin', revoke('editor', 'user:read'), 200],
            ['grants a permission they hold to an equal', 'superadmin', grant('superadmin2', 'report:read'), 403],
        ];

        it.each(ROWS)('%s (%s) → %i', async (_label, caller, action, status) =>
        {
            const before = await authorityState();

            expect(await action(ids[caller]!, () => signInAs(caller))).toBe(status);

            if (status !== 200)
            {
                expect(await authorityState()).toEqual(before);
            }
        });
    });

    it('T11: a role re-ranked above the caller by a transaction holding its lock is not given on its old rank (PROBE-A)', async () =>
    {
        const editor = await roleId('editor');
        const reRanked = gate();
        const commit = gate();
        const reRank = runInTransaction(async () =>
        {
            await rolesRepository.lockInIdOrder({ update: [editor] });
            await rolesRepository.updateById(editor, { priority: 95 });
            reRanked.open();
            await commit.opened;
        }, { context: 'test:re-rank-held' });
        await reRanked.opened;

        const pending = statusOf(changeUserRole(ids.admin!, ids.user!, editor));
        await untilSomeoneWaitsOrDone().finally(commit.open);
        await reRank;
        const status = await pending;

        // admin is 80; editor is 95 when the change would commit
        expect({ status, role: await storedRoleOf('user') }).toEqual({ status: 403, role: await roleId('user') });
    });

    describe('T12: deleting a role never deletes an account', () =>
    {
        async function operatorRole(): Promise<number>
        {
            return (await createRole(ids.superadmin!, { name: 'crew', displayName: 'Crew', priority: 60 })).id;
        }

        async function deleteRoleAs(account: string, id: number): Promise<Response>
        {
            return call('DELETE', `/_auth/admin/roles/${id}`, await signInAs(account));
        }

        it('PROBE-B: a role an account holds → 409 ROLE_IN_USE with the count, the holder unchanged', async () =>
        {
            const crew = await operatorRole();
            await getTestDb().update(users).set({ roleId: crew }).where(eq(users.id, ids.user!));

            const response = await deleteRoleAs('superadmin', crew);
            const body = await response.json();

            expect({ status: response.status, code: body.code, details: body.details }).toEqual({
                status: 409,
                code: 'ROLE_IN_USE',
                details: { roleId: crew, accounts: 1, pendingInvitations: 0, emailDomainPolicy: false },
            });
            expect(await storedRoleOf('user')).toBe(crew);
        });

        it('a role a pending invitation promises → 409 ROLE_IN_USE, the invitation kept', async () =>
        {
            const crew = await operatorRole();
            expect((await call('POST', '/_auth/invitations', await signInAs('superadmin'), { email: 'new@test.com', roleId: crew })).status).toBe(200);

            const response = await deleteRoleAs('superadmin', crew);

            expect(response.status).toBe(409);
            expect((await response.json()).details).toMatchObject({ accounts: 0, pendingInvitations: 1 });
            expect(await getTestDb().select().from(userInvitations)).toHaveLength(1);
        });

        it('a role nothing names → 204 and gone, its settled invitations and mappings with it', async () =>
        {
            const crew = await operatorRole();
            await addPermissionToRole(ids.superadmin!, crew, await permissionId('report:read'));
            expect((await call('POST', '/_auth/invitations', await signInAs('superadmin'), { email: 'new@test.com', roleId: crew })).status).toBe(200);
            await getTestDb().update(userInvitations).set({ status: 'cancelled' });

            expect((await deleteRoleAs('superadmin', crew)).status).toBe(204);
            expect(await getRoleByName('crew')).toBeNull();
            expect(await getTestDb().select().from(userInvitations)).toEqual([]);
            expect(await getTestDb().select().from(rolePermissions).where(eq(rolePermissions.roleId, crew))).toEqual([]);
        });

        it('a role whose only reference is a pending invitation past its expiry → 204, the invitation deleted with it', async () =>
        {
            const crew = await operatorRole();
            expect((await call('POST', '/_auth/invitations', await signInAs('superadmin'), { email: 'new@test.com', roleId: crew })).status).toBe(200);
            // Expired by time, not yet marked by the sweep: acceptance would refuse it
            await getTestDb().update(userInvitations).set({ expiresAt: new Date(Date.now() - 60_000) });

            expect((await deleteRoleAs('superadmin', crew)).status).toBe(204);
            expect(await getRoleByName('crew')).toBeNull();
            expect(await getTestDb().select().from(userInvitations)).toEqual([]);
        });
    });

    describe('T13: the boot sync states its result in the write', () =>
    {
        const DECLARING = { ...CONFIG, rolePermissions: { ...CONFIG.rolePermissions, editor: ['post:edit', 'report:read', 'audit:read'] } };

        async function bootOutcome(boot: Promise<void>): Promise<string>
        {
            return boot.then(() => 'ok', (error: Error) => `${error.constructor.name}: ${error.message}`);
        }

        it('PROBE-C: two instances booting a configuration that adds a mapping both come up, one row, config\'s', async () =>
        {
            expect(await Promise.all([bootOutcome(initializeAuth(DECLARING)), bootOutcome(initializeAuth(DECLARING))])).toEqual(['ok', 'ok']);
            expect(await mappingsOf('editor')).toEqual(['audit:read:config', 'post:edit:config', 'report:read:config']);
        });

        it('PROBE-D: an operator add landing between the boot\'s read and its write → boot comes up, the mapping is config\'s', async () =>
        {
            const original = rolesRepository.lockInIdOrder.bind(rolesRepository);
            let added = false;
            vi.spyOn(rolesRepository, 'lockInIdOrder').mockImplementation(async (locks) =>
            {
                // The boot's one role lock, after it read the roles and before it writes (no operator passes no `update`)
                if (!added && locks.update === undefined)
                {
                    added = true;
                    // The operator's own root transaction, on its own connection: committed before the boot locks
                    await runInTransaction(
                        async () => addPermissionToRole(ids.superadmin!, await roleId('editor'), await permissionId('audit:read')),
                        { requiresNew: true },
                    );
                }

                return original(locks);
            });

            expect(await bootOutcome(initializeAuth(DECLARING))).toBe('ok');
            expect(await mappingsOf('editor')).toEqual(['audit:read:config', 'post:edit:config', 'report:read:config']);
        });

        it('a boot and an operator add of the same mapping at once → both succeed, one row, config\'s', async () =>
        {
            const add = statusOf(addPermissionToRole(ids.superadmin!, await roleId('editor'), await permissionId('audit:read')));

            expect(await Promise.all([bootOutcome(initializeAuth(DECLARING)), add])).toEqual(['ok', 200]);
            expect(await mappingsOf('editor')).toEqual(['audit:read:config', 'post:edit:config', 'report:read:config']);
        });

        it('a set dropping an operator mapping a boot made config\'s after the set read it → 409, the mapping stays config\'s', async () =>
        {
            const editor = await roleId('editor');
            const audit = await permissionId('audit:read');
            await addPermissionToRole(ids.superadmin!, editor, audit);
            const original = rolePermissionsRepository.deleteOperatorOwned.bind(rolePermissionsRepository);
            vi.spyOn(rolePermissionsRepository, 'deleteOperatorOwned').mockImplementationOnce(async (role, permissionIds) =>
            {
                await getTestDb().update(rolePermissions).set({ source: 'config' }).where(eq(rolePermissions.permissionId, audit));

                return original(role, permissionIds);
            });

            const set = setRolePermissions(ids.superadmin!, editor, [await permissionId('post:edit'), await permissionId('report:read')]);

            await expect(set).rejects.toMatchObject({ statusCode: 409, code: 'CONFIG_OWNED_MAPPING' });
            expect(await mappingsOf('editor')).toEqual(['audit:read:config', 'post:edit:config', 'report:read:config']);
        });
    });

    describe('T14: what the configuration declares for a role is the configuration\'s', () =>
    {
        it('deleting a config-declared role → 409 CONFIG_OWNED_ROLE, the role kept', async () =>
        {
            const response = await call('DELETE', `/_auth/admin/roles/${await roleId('retired')}`, await signInAs('superadmin'));

            expect(response.status).toBe(409);
            expect((await response.json()).code).toBe('CONFIG_OWNED_ROLE');
            expect(await getRoleByName('retired')).not.toBeNull();
        });

        it('re-ranking a config-declared role through the API → 409 CONFIG_OWNED_ROLE, nothing changed; deactivating it → 200', async () =>
        {
            const superadmin = await signInAs('superadmin');
            const before = await authorityState();
            const response = await call('PATCH', `/_auth/admin/roles/${await roleId('editor')}`, superadmin, { priority: 60 });

            expect(response.status).toBe(409);
            expect((await response.json()).details).toMatchObject({ fields: ['priority'] });
            expect(await authorityState()).toEqual(before);
            await setRoleActive(superadmin, 'editor', false);
        });

        it('a boot with unchanged configuration restores a priority changed directly in the table, and keeps isActive', async () =>
        {
            await getTestDb().update(roles).set({ priority: 75 }).where(eq(roles.name, 'editor'));

            await initializeAuth(CONFIG);

            expect((await getRoleByName('editor'))!.priority).toBe(50);
            expect((await getRoleByName('retired'))!.isActive).toBe(false);
        });

        it('a role the configuration stops declaring becomes the operator\'s', async () =>
        {
            await initializeAuth({ ...CONFIG, roles: CONFIG.roles.filter(role => role.name !== 'retired') });

            expect((await getRoleByName('retired'))!.source).toBe('admin');
            expect(await statusOf(deleteRole(ids.superadmin!, await roleId('retired')))).toBe(200);
        });
    });

    describe('T15: what is conferred does not outlast what the caller holds', () =>
    {
        const DAY = 24 * 60 * 60 * 1000;
        let callerExpiry: Date;

        beforeEach(async () =>
        {
            callerExpiry = new Date(Date.now() + DAY);
            await override('admin', 'audit:read', { granted: true, expiresAt: callerExpiry });
        });

        async function grantUntil(expiresAt: Date | null): Promise<number>
        {
            return statusOf(grantUserPermission(ids.admin!, ids.user!, await permissionId('audit:read'), { expiresAt }));
        }

        it('attaching it to a lower role → 403, nothing changed', async () =>
        {
            const before = await authorityState();

            expect(await statusOf(addPermissionToRole(ids.admin!, await roleId('editor'), await permissionId('audit:read')))).toBe(403);
            expect(await authorityState()).toEqual(before);
        });

        it('a per-user grant for longer, or for good → 403; until the caller\'s own expiry or earlier → 200', async () =>
        {
            expect(await grantUntil(new Date(callerExpiry.getTime() + 60_000))).toBe(403);
            expect(await grantUntil(null)).toBe(403);
            expect(await grantUntil(callerExpiry)).toBe(200);
            expect(await grantUntil(new Date(callerExpiry.getTime() - DAY / 2))).toBe(200);
        });
    });

    describe('T16: two operations that lock roles take them in id order, and queue instead of deadlocking', () =>
    {
        type Lock = (id: number, strength: 'update' | 'share') => Promise<unknown>;

        let low: number;
        let high: number;

        // low is created first, so its id is the lower; each caller holds the other's role
        beforeEach(async () =>
        {
            low = (await createRole(ids.superadmin!, { name: 'low', displayName: 'Low', priority: 60 })).id;
            high = (await createRole(ids.superadmin!, { name: 'high', displayName: 'High', priority: 70 })).id;
            ids.holdsHigh = await createTestUser('holds-high@test.com', high);
            ids.holdsLow = await createTestUser('holds-low@test.com', low);
        });

        /** A: re-ranks low, holding high — 70 outranks 60 and 65: 200. */
        const reRankLow = () => statusOf(updateRole(ids.holdsHigh!, low, { priority: 65 }));
        /** B: re-ranks high, holding low — 60 or 65 does not outrank 70: 403. */
        const reRankHigh = () => statusOf(updateRole(ids.holdsLow!, high, { priority: 55 }));

        /**
         * Runs `first` until it holds its first role lock, starts `second`, and
         * lets `first` go on once `second` waits on a lock or is done. Taken in
         * any other order than id order — the changed role first, then the
         * caller's — this is the interleaving that deadlocks.
         */
        async function interleaved(first: () => Promise<number>, second: () => Promise<number>): Promise<number[]>
        {
            const holds = gate();
            const goOn = gate();
            const repository = rolesRepository as unknown as { lockOne: Lock };
            const lockOne = repository.lockOne.bind(rolesRepository);
            vi.spyOn(repository, 'lockOne').mockImplementationOnce(async (id, strength) =>
            {
                const role = await lockOne(id, strength);
                holds.open();
                await goOn.opened;

                return role;
            });

            const firstStatus = first();
            await holds.opened;
            let secondDone = false;
            const secondStatus = second().finally(() =>
            {
                secondDone = true;
            });
            await untilSomeoneWaitsOrDone(() => secondDone).finally(goOn.open);

            return Promise.all([firstStatus, secondStatus]);
        }

        it.each([
            ['A first', true],
            ['B first', false],
        ])('%s → A 200, B 403, neither 500; low re-ranked, high unchanged', async (_label, aFirst) =>
        {
            const statuses = aFirst ? await interleaved(reRankLow, reRankHigh) : (await interleaved(reRankHigh, reRankLow)).reverse();

            expect(statuses).toEqual([200, 403]);
            expect([(await getRoleByName('low'))!.priority, (await getRoleByName('high'))!.priority]).toEqual([65, 70]);
        }, 20_000);

        it('a caller whose role changes between the read naming it and the lock, and again on the retry → 409 AUTHORITY_CONTENDED, nothing changed', async () =>
        {
            const before = await authorityState();
            const findAuthority = usersRepository.findAuthorityOnPrimary.bind(usersRepository);
            const thenRole = (role: string) => async (id: number) =>
            {
                const read = await findAuthority(id);
                await getTestDb().update(users).set({ roleId: await roleId(role) }).where(eq(users.id, ids.holdsHigh!));

                return read;
            };
            // Each attempt's first read is made stale before its lock: the retry is the only one
            vi.spyOn(usersRepository, 'findAuthorityOnPrimary')
                .mockImplementationOnce(thenRole('superadmin'))
                .mockImplementationOnce(findAuthority)
                .mockImplementationOnce(thenRole('high'));

            await expect(updateRole(ids.holdsHigh!, low, { priority: 65 })).rejects.toMatchObject({ statusCode: 409, code: 'AUTHORITY_CONTENDED' });
            expect(await authorityState()).toEqual(before);
        });
    });

    describe('T17: a premise gone stale between holdAuthority\'s two reads is judged again, on fresh reads', () =>
    {
        /** The next authority read answers as of now, then commits `change` before the lock it leads to. */
        function staleAfterFirstRead(change: () => Promise<unknown>): void
        {
            const findAuthority = usersRepository.findAuthorityOnPrimary.bind(usersRepository);
            vi.spyOn(usersRepository, 'findAuthorityOnPrimary').mockImplementationOnce(async (id) =>
            {
                const read = await findAuthority(id);
                await change();

                return read;
            });
        }

        async function acceptToken(token: string): Promise<Response>
        {
            const key = generateKeyPair('ES256');

            return call('POST', '/_auth/invitations/accept', undefined, {
                token,
                password: TEST_PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });
        }

        it('RV1: an inviter demoted between the reads at acceptance → 410, no account, the invitation pending', async () =>
        {
            const response = await call('POST', '/_auth/invitations', await signInAs('admin'), { email: 'rv1@test.com', roleId: await roleId('editor') });
            expect(response.status).toBe(200);
            const { token } = await response.json();
            const userRole = await roleId('user');
            staleAfterFirstRead(() => getTestDb().update(users).set({ roleId: userRole }).where(eq(users.id, ids.admin!)));

            expect((await acceptToken(token)).status).toBe(410);
            expect(await getTestDb().select().from(users).where(eq(users.email, 'rv1@test.com'))).toEqual([]);
            const [invitation] = await getTestDb().select().from(userInvitations).where(eq(userInvitations.email, 'rv1@test.com'));
            expect(invitation!.status).toBe('pending');
        });

        it('a caller whose role is deactivated between the reads → 403, the target unchanged', async () =>
        {
            staleAfterFirstRead(() => getTestDb().update(roles).set({ isActive: false }).where(eq(roles.name, 'admin')));

            expect(await statusOf(changeUserRole(ids.admin!, ids.user!, await roleId('editor')))).toBe(403);
            expect(await storedRoleOf('user')).toBe(await roleId('user'));
        });

        it('an inviter promoted between the reads → 200, one invitation, its event emitted once', async () =>
        {
            const created: unknown[] = [];
            const unsubscribe = invitationCreatedEvent.subscribe(payload => void created.push(payload));
            const superadminRole = await roleId('superadmin');
            staleAfterFirstRead(() => getTestDb().update(users).set({ roleId: superadminRole }).where(eq(users.id, ids.admin!)));

            const issued = await createInvitation({ email: 'promoted@test.com', roleId: await roleId('editor'), invitedBy: ids.admin! })
                .finally(unsubscribe);

            expect(await getTestDb().select().from(userInvitations)).toHaveLength(1);
            expect(created).toEqual([expect.objectContaining({ invitationId: String(issued.invitation.id), token: issued.token })]);
        });
    });

    describe('T18: two boots with different configurations end in one of them', () =>
    {
        const SQUAD = {
            ...CONFIG,
            roles: [...CONFIG.roles, { name: 'squad', displayName: 'Squad', priority: 30 }],
            rolePermissions: { ...CONFIG.rolePermissions, squad: ['post:edit'] },
        };

        it('RV5: a boot of A held mid-sync while B boots → B waits for A, and the state is B\'s', async () =>
        {
            // the deployment that declared squad has booted once before
            await initializeAuth(SQUAD);
            const paused = gate();
            const resume = gate();
            const findAll = rolesRepository.findAllOnPrimary.bind(rolesRepository);
            vi.spyOn(rolesRepository, 'findAllOnPrimary').mockImplementationOnce(async () =>
            {
                paused.open();
                await resume.opened;

                return findAll();
            });

            const bootA = initializeAuth(SQUAD);
            await paused.opened;
            let bootBDone = false;
            const bootB = initializeAuth(CONFIG).finally(() =>
            {
                bootBDone = true;
            });
            await untilSomeoneWaitsOrDone(() => bootBDone).finally(resume.open);
            await Promise.all([bootA, bootB]);

            expect({ source: (await getRoleByName('squad'))!.source, mappings: await mappingsOf('squad') }).toEqual({ source: 'admin', mappings: [] });
        });

        it('a boot that cannot take the sync lock within its wait → refused naming the holder, nothing written', async () =>
        {
            const lockConfigSync = rolesRepository.lockConfigSync.bind(rolesRepository);
            vi.spyOn(rolesRepository, 'lockConfigSync').mockImplementation(() => lockConfigSync(200));

            const refusal = await getTestDb().transaction(async (tx) =>
            {
                // The sync's key, held here as another instance's sync would hold it
                await tx.execute(sql`select pg_advisory_xact_lock(${0x5350464e}, 1)`);
                const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
                const error = await initializeAuth(SQUAD).then(() => null, (refused: unknown) => refused);

                return { error, pid: Number(backend!.pid) };
            });

            expect(refusal.error).toBeInstanceOf(RbacSyncBusyError);
            expect((refusal.error as Error).message).toContain(`backend pid ${refusal.pid}`);
            expect(await getRoleByName('squad')).toBeNull();
        });

        it('P3: a boot that cannot take a declared role an operator holds within its wait → refused naming the role lock and its holder, nothing written', async () =>
        {
            const lockConfigSync = rolesRepository.lockConfigSync.bind(rolesRepository);
            vi.spyOn(rolesRepository, 'lockConfigSync').mockImplementation(() => lockConfigSync(200));

            const refusal = await getTestDb().transaction(async (tx) =>
            {
                // An operator's running change resting on admin, which every configuration declares
                await tx.execute(sql`select id from spfn_auth.roles where name = 'admin' for share`);
                const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
                const error = await initializeAuth(SQUAD).then(() => null, (refused: unknown) => refused);

                return { error, pid: Number(backend!.pid) };
            });

            expect(refusal.error).toBeInstanceOf(RbacSyncBusyError);
            expect((refusal.error as InstanceType<typeof RbacSyncBusyError>).details).toMatchObject({ lock: 'role', holders: [expect.objectContaining({ pid: refusal.pid })] });
            expect((refusal.error as Error).message).toMatch(/waited \d+ ms for a role row held by a running change \(role rows held by backend pid \d+/);
            expect((refusal.error as Error).message).toContain(`backend pid ${refusal.pid}`);
            expect((refusal.error as Error).message).not.toContain('another instance');
            expect(await getRoleByName('squad')).toBeNull();
        });
    });

    describe('T19: the configuration sync needs no connection beyond the one it runs on', () =>
    {
        const SQUAD = { ...CONFIG, roles: [...CONFIG.roles, { name: 'squad', displayName: 'Squad', priority: 30 }] };

        /** The app's database clients opened again: the write pool capped at `max` connections, or as configured. */
        async function reopenDatabase(max?: number): Promise<void>
        {
            await closeDatabase();
            await initDatabase(max === undefined ? undefined : { pool: { max } });
        }

        afterEach(() => reopenDatabase());

        it('a boot with a one-connection write pool completes, and syncs', async () =>
        {
            await reopenDatabase(1);
            let timer: NodeJS.Timeout | undefined;
            const hung = new Promise<string>((resolve) =>
            {
                timer = setTimeout(() => resolve('hung'), 5_000);
            });

            const outcome = await Promise.race([initializeAuth(SQUAD).then(() => 'booted'), hung]).finally(() => clearTimeout(timer));

            expect(outcome).toBe('booted');
            expect((await getRoleByName('squad'))!.source).toBe('config');
        }, 20_000);

        it('a role the configuration declares, created by an operator after the sync read the roles → the sync is made again, the role is the configuration\'s', async () =>
        {
            const findAll = rolesRepository.findAllOnPrimary.bind(rolesRepository);
            const reads = vi.spyOn(rolesRepository, 'findAllOnPrimary').mockImplementationOnce(async () =>
            {
                const read = await findAll();
                // The operator's own root transaction, on its own connection: committed before the sync goes on
                await runInTransaction(
                    () => createRole(ids.superadmin!, { name: 'squad', displayName: 'Operator squad', priority: 40 }),
                    { requiresNew: true },
                );

                return read;
            });

            await initializeAuth(SQUAD);

            expect(reads).toHaveBeenCalledTimes(2);
            expect(await getRoleByName('squad')).toMatchObject({ source: 'config', displayName: 'Squad', priority: 30 });
        });
    });
});

it('T7: a built-in role is named only in the permission module, the seed defaults, requireRole(...) or an exemption with its reason', () =>
{
    // The scan sees every shape a decision on a role name takes, and not a role named to a guard
    const shapes = [
        "if (targetRole === 'superadmin') {}",
        "new Set(['admin']).has(role)",
        'allowed.includes(role) || role ===\n    `admin`',
        'roles.some(r => r === BUILTIN_ROLES.ADMIN.name)',
        "const view = <Badge role={'superadmin'} />",
        'const limit = { superadmin: 100, other: 1 }[role];',
        'if (limits.admin > 1) {}',
        'const permissions = BUILTIN_ROLE_PERMISSIONS[role];',
        'function f(role: BuiltinRoleName) {}',
    ];
    expect(shapes.map((shape, index) => roleNamesIn(`shape-${index}.tsx`, shape).length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // Not caught, as the header says: a name assembled at run time
    expect(roleNamesIn('concat.ts', "if (role === 'super' + 'ad' + 'min') {}")).toEqual([]);
    expect(roleNamesIn('guard.ts', "route.get('/x').use([requireRole('admin', 'superadmin')])")).toEqual([]);

    const files = sourceFiles(SOURCE_ROOT).map(path => relative(SOURCE_ROOT, path).split(sep).join('/'));
    const occurrences = files
        .filter(file => !ROLE_NAMES_ALLOWED.includes(file))
        .flatMap(file => roleNamesIn(file, readFileSync(join(SOURCE_ROOT, file), 'utf8')).map(found => ({ file, found })));
    const exemptionOf = ({ file, found }: { file: string; found: string }) => `${file}: ${found.split('@')[0]}`;

    // The scan covers all of src/, the Next.js half and .tsx included
    expect(files.some(file => file.startsWith('nextjs/'))).toBe(true);
    expect(files.some(file => file.endsWith('.tsx'))).toBe(true);
    expect(occurrences.filter(occurrence => !ROLE_NAME_EXEMPTIONS[exemptionOf(occurrence)]).map(({ file, found }) => `${file}:${found}`)).toEqual([]);
    expect(Object.keys(ROLE_NAME_EXEMPTIONS).filter(key => !occurrences.some(occurrence => exemptionOf(occurrence) === key))).toEqual([]);
});
