/**
 * @spfn/auth - Setup Integration Tests
 *
 * Tests for ensureAdminExists() function
 *
 * | #  | goes unnoticed without the row                                                                 |
 * | -- | ---------------------------------------------------------------------------------------------- |
 * | S1 | a boot line naming a seeded account by its configured address — or one whose logged error, or |
 * |    | the parse error of a malformed `SPFN_AUTH_ADMIN_ACCOUNTS`, carries the address or password —   |
 * |    | and an outcome line that stops saying which account (`position`) and which row (`userId`)       |
 * | S2 | the position taken from the list left after a skipped entry: the outcome line and the domain   |
 * |    | policy's refusal then point the operator at the wrong account                                  |
 */

import { inspect } from 'node:util';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { spyOnAuthLog, type AuthLog } from '../helpers/auth-log';
import { ensureAdminExists } from '@/server/setup';
import { initializeAuth } from '@/server/services/rbac.service';
import { getRoleByName } from '@/server/services/role.service';
import { configurePasswordRule, resetPasswordRuleForTests } from '@/server/lib/password-rule';
import { ROLE_EMAIL_DOMAINS_VAR } from '@/server/lib/role-email-domains';
import { usersRepository } from '@/server/repositories';
import { users } from '@/server/entities';
import { verifyPassword } from '@/server/helpers/password';
import { authLogger } from '@/server/logger';
import { eq } from 'drizzle-orm';

const ADMIN_VARS = [
    'SPFN_AUTH_ADMIN_ACCOUNTS',
    'SPFN_AUTH_ADMIN_EMAILS',
    'SPFN_AUTH_ADMIN_PASSWORDS',
    'SPFN_AUTH_ADMIN_ROLES',
    'SPFN_AUTH_ADMIN_EMAIL',
    'SPFN_AUTH_ADMIN_PASSWORD',
] as const;

/** One seeding run: the environment, what happens first, and the lines its accounts must get. */
interface SeedCase
{
    env: Partial<Record<typeof ADMIN_VARS[number], string>>;
    prepare?: () => Promise<void>;
    /** Every configured address, phone and password, or the parts of a malformed value */
    secrets: string[];
    lines: () => Promise<unknown[][]>;
}

const SEED_EMAIL = 'root@seed489.test';
const SEED_PHONE = '+821055550489';
const SEED_PASSWORD = 'Seed-pass-489';

/** The id of the row stored for an address, in whatever case it was stored */
async function idOf(email: string): Promise<number>
{
    const row = await usersRepository.findByEmailInAnyStoredForm(email);

    return row!.id;
}

/** A row for `email` stored as given, before seeding runs */
async function storedAccount(email: string): Promise<void>
{
    const role = await getRoleByName('user');
    await getTestDb().insert(users).values({ email, roleId: role!.id });
}

const SEED_CASES: Record<string, SeedCase> = {
    'created, JSON form': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: SEED_EMAIL, phone: SEED_PHONE, password: SEED_PASSWORD, role: 'superadmin' }]) },
        secrets: [SEED_EMAIL, SEED_PHONE, SEED_PASSWORD],
        lines: async () => [['Admin account created', { position: 1, userId: await idOf(SEED_EMAIL), role: 'superadmin' }]],
    },
    'created, comma-separated form': {
        env: {
            SPFN_AUTH_ADMIN_EMAILS: 'one@seed489.test,two@seed489.test',
            SPFN_AUTH_ADMIN_PASSWORDS: 'Seed-pass-one,Seed-pass-two',
            SPFN_AUTH_ADMIN_ROLES: 'admin,user',
        },
        secrets: ['one@seed489.test', 'two@seed489.test', 'Seed-pass-one', 'Seed-pass-two'],
        lines: async () => [
            ['Admin account created', { position: 1, userId: await idOf('one@seed489.test'), role: 'admin' }],
            ['Admin account created', { position: 2, userId: await idOf('two@seed489.test'), role: 'user' }],
        ],
    },
    'created, single form': {
        env: { SPFN_AUTH_ADMIN_EMAIL: SEED_EMAIL, SPFN_AUTH_ADMIN_PASSWORD: SEED_PASSWORD },
        secrets: [SEED_EMAIL, SEED_PASSWORD],
        lines: async () => [['Admin account created', { position: 1, userId: await idOf(SEED_EMAIL), role: 'superadmin' }]],
    },
    'already exists': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: SEED_EMAIL, password: SEED_PASSWORD }]) },
        prepare: () => storedAccount(SEED_EMAIL),
        secrets: [SEED_EMAIL, SEED_PASSWORD],
        lines: async () => [['Admin account already exists', { position: 1, userId: await idOf(SEED_EMAIL) }]],
    },
    'already exists, stored in another case': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: SEED_EMAIL, password: SEED_PASSWORD }]) },
        prepare: () => storedAccount('Root@Seed489.test'),
        secrets: [SEED_EMAIL, SEED_PASSWORD],
        lines: async () => [['Admin account already exists', { position: 1, userId: await idOf(SEED_EMAIL) }]],
    },
    'role not found': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: SEED_EMAIL, password: SEED_PASSWORD, role: 'no-such-role' }]) },
        secrets: [SEED_EMAIL, SEED_PASSWORD],
        lines: async () => [['Admin account not created: role not found. Run initializeAuth() first.', { position: 1 }]],
    },
    'role not found, text that is actually a password or address (shifted columns, #2)': {
        env: {
            SPFN_AUTH_ADMIN_EMAILS: 'c1@rv517.test,c2@rv517.test,c3@rv517.test',
            SPFN_AUTH_ADMIN_PASSWORDS: `${SEED_PASSWORD}-1,${SEED_PASSWORD}-2,${SEED_PASSWORD}-3`,
            SPFN_AUTH_ADMIN_ROLES: 'Secret-c1,user,c3@rv517.test',
        },
        secrets: ['c1@rv517.test', 'c3@rv517.test', `${SEED_PASSWORD}-1`, `${SEED_PASSWORD}-2`, `${SEED_PASSWORD}-3`, 'Secret-c1'],
        // spyOnAuthLog groups calls by level (info, then warn, then error), not
        // by call time, so the created (info) line precedes the two error lines.
        lines: async () => [
            ['Admin account created', { position: 2, userId: await idOf('c2@rv517.test'), role: 'user' }],
            ['Admin account not created: role not found. Run initializeAuth() first.', { position: 1 }],
            ['Admin account not created: role not found. Run initializeAuth() first.', { position: 3 }],
        ],
    },
    'number password, JSON form': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: 'np@rv517.test', password: 48151623421 }]) },
        secrets: ['np@rv517.test', '48151623421'],
        lines: async () => [['⚠️  Skipping account 1: invalid password']],
    },
    'number email, JSON form': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: 918273645, password: 'Seed-pass-ne489' }]) },
        secrets: ['918273645', 'Seed-pass-ne489'],
        lines: async () => [['⚠️  Skipping account 1: invalid email']],
    },
    'object phone, JSON form (no account is created)': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: 'op@rv517.test', password: 'Seed-pass-op489', phone: { note: 'phone-object-marker-489' } }]) },
        secrets: ['op@rv517.test', 'Seed-pass-op489', 'phone-object-marker-489'],
        lines: async () => [['⚠️  Skipping account 1: invalid phone']],
    },
    'mixed list: valid, null, string, number, array, no-password, valid': {
        env: {
            SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([
                { email: 'mix1@rv517.test', password: 'Seed-pass-mix1' },
                null,
                'a-plain-string-489',
                918273645,
                [1, 2, 3],
                { email: 'mix-nopass@rv517.test' },
                { email: 'mix7@rv517.test', password: 'Seed-pass-mix7' },
            ]),
        },
        secrets: ['mix1@rv517.test', 'Seed-pass-mix1', 'a-plain-string-489', '918273645', 'mix-nopass@rv517.test', 'mix7@rv517.test', 'Seed-pass-mix7'],
        // spyOnAuthLog groups calls by level (info, then warn), not by call
        // time, so the two created (info) lines precede the warn lines.
        lines: async () => [
            ['Admin account created', { position: 1, userId: await idOf('mix1@rv517.test'), role: 'user' }],
            ['Admin account created', { position: 7, userId: await idOf('mix7@rv517.test'), role: 'user' }],
            ['⚠️  Skipping account 2: invalid entry'],
            ['⚠️  Skipping account 3: invalid entry'],
            ['⚠️  Skipping account 4: invalid entry'],
            ['⚠️  Skipping account 5: invalid entry'],
            ['⚠️  Skipping account 6: invalid password'],
        ],
    },
    'creation failed on a unique violation': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: SEED_EMAIL, phone: SEED_PHONE, password: SEED_PASSWORD }]) },
        prepare: async () =>
        {
            // The row appears between the lookup and the insert, as when two instances boot at once
            await storedAccount(SEED_EMAIL);
            vi.spyOn(usersRepository, 'findByEmailInAnyStoredForm').mockResolvedValueOnce(null as never);
            vi.spyOn(usersRepository, 'create');
        },
        secrets: [SEED_EMAIL, SEED_PHONE, SEED_PASSWORD],
        lines: async () =>
        {
            // Not vacuous: the error the insert threw does carry the address
            const [insert] = vi.mocked(usersRepository.create).mock.settledResults;
            expect(inspect(insert!.value)).toContain(`Key (email)=(${SEED_EMAIL})`);

            return [['Admin account not created', { position: 1, error: expect.objectContaining({ code: '23505' }) }]];
        },
    },
    'creation failed on the app\'s password rule': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([{ email: SEED_EMAIL, phone: SEED_PHONE, password: SEED_PASSWORD }]) },
        prepare: async () => configurePasswordRule({ validate: () => ['too easy to guess'] }),
        secrets: [SEED_EMAIL, SEED_PHONE, SEED_PASSWORD],
        lines: async () => [['Admin account not created', { position: 1, error: expect.objectContaining({ name: 'ValidationError', statusCode: 400 }) }]],
    },
    'malformed JSON, short enough for V8 to quote whole': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: 'a@b.c:pw12' },
        secrets: ['a@b.c', 'pw12'],
        lines: async () => [['❌ SPFN_AUTH_ADMIN_ACCOUNTS is not valid JSON']],
    },
    'malformed JSON, quoted by V8 around the failing token': {
        env: { SPFN_AUTH_ADMIN_ACCOUNTS: `[{"email":"${SEED_EMAIL}","password":${SEED_PASSWORD}}]` },
        secrets: ['root@seed', 'Seed-pass'],
        lines: async () => [['❌ SPFN_AUTH_ADMIN_ACCOUNTS is not valid JSON']],
    },
};

/** The calls that say what became of an account or of the list, without the run's count lines */
function outcomeLines(log: AuthLog): unknown[][]
{
    return log.calls().filter(([message]) => /^(Admin account|❌|⚠️ {2}Skipping)/.test(String(message)));
}

const CONSOLE_METHODS = ['log', 'error', 'warn', 'debug', 'info'] as const;

/**
 * Every line written to the console during `work`, on any method — so a line
 * a mutant adds through core's root logger (which `spyOnAuthLog` cannot see,
 * since it only walks `authLogger`'s children), or straight to `console`,
 * bypassing every logger, is caught too.
 */
async function loggedDuring(work: () => Promise<unknown>): Promise<string>
{
    const lines: string[] = [];
    const keep = (...args: unknown[]) =>
    {
        lines.push(args.map(String).join(' '));
    };
    const spies = CONSOLE_METHODS.map(method => vi.spyOn(console, method).mockImplementation(keep));

    await work().finally(() => spies.forEach(spy => spy.mockRestore()));

    return lines.join('\n');
}

// Check if database is available before running tests
const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)('Setup - ensureAdminExists()', () =>
{
    beforeAll(async () =>
    {
        await setupTestDb();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);

        // Initialize RBAC system (creates roles)
        await initializeAuth();

        // Clear environment variables before each test
        delete process.env.SPFN_AUTH_ADMIN_ACCOUNTS;
        delete process.env.SPFN_AUTH_ADMIN_EMAILS;
        delete process.env.SPFN_AUTH_ADMIN_PASSWORDS;
        delete process.env.SPFN_AUTH_ADMIN_ROLES;
        delete process.env.SPFN_AUTH_ADMIN_EMAIL;
        delete process.env.SPFN_AUTH_ADMIN_PASSWORD;
    });

    describe('Boot lines name an account by position and id, never by address (#489)', () =>
    {
        let log: AuthLog;

        beforeEach(() =>
        {
            log = spyOnAuthLog();
        });

        afterEach(() =>
        {
            log.restore();
            vi.restoreAllMocks();
            resetPasswordRuleForTests();
            delete process.env[ROLE_EMAIL_DOMAINS_VAR];
            ADMIN_VARS.forEach(name => delete process.env[name]);
        });

        it.each(Object.keys(SEED_CASES))('S1: %s', async (name) =>
        {
            const seedCase = SEED_CASES[name]!;
            await seedCase.prepare?.();
            Object.assign(process.env, seedCase.env);

            const consoleOutput = await loggedDuring(() => ensureAdminExists());

            expect(outcomeLines(log)).toEqual(await seedCase.lines());
            for (const secret of seedCase.secrets)
            {
                expect(log.text().toLowerCase()).not.toContain(secret.toLowerCase());
                expect(consoleOutput.toLowerCase()).not.toContain(secret.toLowerCase());
            }
        });

        it.each([
            ['JSON', {
                SPFN_AUTH_ADMIN_ACCOUNTS: JSON.stringify([
                    { email: 'first@seed489.test', password: SEED_PASSWORD },
                    { email: 'second@seed489.test' },
                    { email: 'third@seed489.test', password: SEED_PASSWORD, role: 'admin' },
                ]),
            }, '⚠️  Skipping account 2: invalid password'],
            ['comma-separated', {
                SPFN_AUTH_ADMIN_EMAILS: 'first@seed489.test,second@seed489.test,third@seed489.test',
                SPFN_AUTH_ADMIN_PASSWORDS: `${SEED_PASSWORD},,${SEED_PASSWORD}`,
                SPFN_AUTH_ADMIN_ROLES: 'user,user,admin',
            }, '⚠️  Skipping account 2: missing email or password'],
        ])('S2: %s form, after a skipped entry, the third account is still position 3', async (_form, values, skipLine) =>
        {
            Object.assign(process.env, values);
            process.env[ROLE_EMAIL_DOMAINS_VAR] = 'admin=example.com';

            await expect(ensureAdminExists()).rejects.toThrow("admin account(s) #3 (role 'admin') ");

            delete process.env[ROLE_EMAIL_DOMAINS_VAR];
            log.restore();
            log = spyOnAuthLog();
            await ensureAdminExists();

            expect(outcomeLines(log)).toEqual([
                ['Admin account created', { position: 1, userId: await idOf('first@seed489.test'), role: 'user' }],
                ['Admin account created', { position: 3, userId: await idOf('third@seed489.test'), role: 'admin' }],
                [skipLine],
            ]);
        });
    });

    describe('JSON Format (ADMIN_ACCOUNTS)', () =>
    {
        it('should create multiple admin accounts from JSON', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'super@example.com',
                    password: 'super-password',
                    role: 'superadmin',
                    phone: '+821012345678',
                },
                {
                    email: 'admin@example.com',
                    password: 'admin-password',
                    role: 'admin',
                },
                {
                    email: 'user@example.com',
                    password: 'user-password',
                    role: 'user',
                },
            ]);

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            // Get role IDs for comparison
            const superadminRole = await getRoleByName('superadmin');
            const adminRole = await getRoleByName('admin');
            const userRole = await getRoleByName('user');

            expect(allUsers).toHaveLength(3);

            // Check super admin
            const superAdmin = allUsers.find(u => u.email === 'super@example.com');
            expect(superAdmin).toBeDefined();
            expect(superAdmin?.roleId).toBe(superadminRole!.id);
            expect(superAdmin?.phone).toBe('+821012345678');
            expect(superAdmin?.emailVerifiedAt).toBeTruthy();
            expect(superAdmin?.passwordChangeRequired).toBe(true);
            expect(superAdmin?.status).toBe('active');

            // Verify password hash
            const isValidPassword = await verifyPassword('super-password', superAdmin!.passwordHash!);
            expect(isValidPassword).toBe(true);

            // Check admin
            const admin = allUsers.find(u => u.email === 'admin@example.com');
            expect(admin?.roleId).toBe(adminRole!.id);

            // Check user
            const regularUser = allUsers.find(u => u.email === 'user@example.com');
            expect(regularUser?.roleId).toBe(userRole!.id);
        });

        it('should use default role "user" if not specified', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'default@example.com',
                    password: 'password123',
                },
            ]);

            await ensureAdminExists();

            const db = getTestDb();
            const [user] = await db.select().from(users).where(eq(users.email, 'default@example.com'));
            const userRole = await getRoleByName('user');

            expect(user).toBeDefined();
            expect(user.roleId).toBe(userRole!.id);
        });

        it('should respect passwordChangeRequired flag', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'no-change@example.com',
                    password: 'password123',
                    passwordChangeRequired: false,
                },
                {
                    email: 'change@example.com',
                    password: 'password123',
                    passwordChangeRequired: true,
                },
            ]);

            await ensureAdminExists();

            const db = getTestDb();
            const [noChange] = await db.select().from(users).where(eq(users.email, 'no-change@example.com'));
            const [change] = await db.select().from(users).where(eq(users.email, 'change@example.com'));

            expect(noChange.passwordChangeRequired).toBe(false);
            expect(change.passwordChangeRequired).toBe(true);
        });

        it('should skip accounts with missing email or password', async () =>
        {
            const consoleWarnSpy = vi.spyOn(authLogger.setup, 'warn').mockImplementation(() => 
            {});

            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'valid@example.com',
                    password: 'password123',
                },
                {
                    email: 'no-password@example.com',
                    // Missing password
                },
                {
                    password: 'no-email-password',
                    // Missing email
                },
            ]);

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(1);
            expect(allUsers[0].email).toBe('valid@example.com');
            expect(consoleWarnSpy).toHaveBeenCalled();

            consoleWarnSpy.mockRestore();
        });

        it('should handle JSON parsing errors gracefully', async () =>
        {
            const consoleErrorSpy = vi.spyOn(authLogger.setup, 'error').mockImplementation(() => 
            {});

            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = 'invalid-json{[';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(0);
            expect(consoleErrorSpy).toHaveBeenCalled();

            consoleErrorSpy.mockRestore();
        });

        it('should handle non-array JSON gracefully', async () =>
        {
            const consoleErrorSpy = vi.spyOn(authLogger.setup, 'error').mockImplementation(() => 
            {});

            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify({
                email: 'single@example.com',
                password: 'password123',
            });

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(0);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('ADMIN_ACCOUNTS must be an array'),
            );

            consoleErrorSpy.mockRestore();
        });
    });

    describe('Comma-Separated Format (ADMIN_EMAILS)', () =>
    {
        it('should create multiple admin accounts from comma-separated values', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAILS = 'super@example.com,admin@example.com,user@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'super-pass,admin-pass,user-pass';
            process.env.SPFN_AUTH_ADMIN_ROLES = 'superadmin,admin,user';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            // Get role IDs
            const superadminRole = await getRoleByName('superadmin');
            const adminRole = await getRoleByName('admin');
            const userRole = await getRoleByName('user');

            expect(allUsers).toHaveLength(3);

            const superAdmin = allUsers.find(u => u.email === 'super@example.com');
            expect(superAdmin?.roleId).toBe(superadminRole!.id);

            const admin = allUsers.find(u => u.email === 'admin@example.com');
            expect(admin?.roleId).toBe(adminRole!.id);

            const regularUser = allUsers.find(u => u.email === 'user@example.com');
            expect(regularUser?.roleId).toBe(userRole!.id);
        });

        it('should trim whitespace from values', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAILS = ' admin@example.com , user@example.com ';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = ' admin-pass , user-pass ';
            process.env.SPFN_AUTH_ADMIN_ROLES = ' admin , user ';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(2);
            expect(allUsers[0].email).toBe('admin@example.com');
            expect(allUsers[1].email).toBe('user@example.com');
        });

        it('should use default role "user" if ADMIN_ROLES not provided', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAILS = 'admin@example.com,user@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'admin-pass,user-pass';
            // No ADMIN_ROLES

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);
            const userRole = await getRoleByName('user');

            expect(allUsers).toHaveLength(2);
            expect(allUsers[0].roleId).toBe(userRole!.id);
            expect(allUsers[1].roleId).toBe(userRole!.id);
        });

        it('should handle email/password length mismatch', async () =>
        {
            const consoleErrorSpy = vi.spyOn(authLogger.setup, 'error').mockImplementation(() => 
            {});

            process.env.SPFN_AUTH_ADMIN_EMAILS = 'admin@example.com,user@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'admin-pass'; // Only 1 password

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(0);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('length mismatch'),
            );

            consoleErrorSpy.mockRestore();
        });

        it('should skip accounts with empty email or password', async () =>
        {
            const consoleWarnSpy = vi.spyOn(authLogger.setup, 'warn').mockImplementation(() => 
            {});

            process.env.SPFN_AUTH_ADMIN_EMAILS = 'valid@example.com,,user@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'valid-pass,,user-pass';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(2);
            expect(consoleWarnSpy).toHaveBeenCalled();

            consoleWarnSpy.mockRestore();
        });

        it('should set passwordChangeRequired to true by default', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAILS = 'admin@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'admin-pass';

            await ensureAdminExists();

            const db = getTestDb();
            const [admin] = await db.select().from(users).where(eq(users.email, 'admin@example.com'));

            expect(admin.passwordChangeRequired).toBe(true);
        });
    });

    describe('Single Account Format (Legacy)', () =>
    {
        it('should create single superadmin account from ADMIN_EMAIL', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAIL = 'admin@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORD = 'AdminPass1!';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);
            const superadminRole = await getRoleByName('superadmin');

            expect(allUsers).toHaveLength(1);
            expect(allUsers[0].email).toBe('admin@example.com');
            expect(allUsers[0].roleId).toBe(superadminRole!.id);
            expect(allUsers[0].passwordChangeRequired).toBe(true);
            expect(allUsers[0].emailVerifiedAt).toBeTruthy();
        });

        it('should verify password is correctly hashed', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAIL = 'admin@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORD = 'MySecurePass1!';

            await ensureAdminExists();

            const db = getTestDb();
            const [admin] = await db.select().from(users).where(eq(users.email, 'admin@example.com'));

            const isValid = await verifyPassword('MySecurePass1!', admin.passwordHash!);
            expect(isValid).toBe(true);
        });
    });

    describe('Priority and Fallback', () =>
    {
        it('should prioritize JSON format over comma-separated', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'json@example.com',
                    password: 'json-pass',
                    role: 'superadmin',
                },
            ]);
            process.env.SPFN_AUTH_ADMIN_EMAILS = 'csv@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'csv-pass';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(1);
            expect(allUsers[0].email).toBe('json@example.com');
        });

        it('should prioritize comma-separated over single account', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAILS = 'csv@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'csv-pass';
            process.env.SPFN_AUTH_ADMIN_EMAIL = 'single@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORD = 'single-pass';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(1);
            expect(allUsers[0].email).toBe('csv@example.com');
        });
    });

    describe('Duplicate Handling', () =>
    {
        it('should skip existing accounts and not update them', async () =>
        {
            const db = getTestDb();

            // Create existing user manually
            process.env.SPFN_AUTH_ADMIN_EMAIL = 'existing@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORD = 'FirstPass1!';
            await ensureAdminExists();

            // Try to create again with different password
            process.env.SPFN_AUTH_ADMIN_PASSWORD = 'SecondPass1!';
            await ensureAdminExists();

            const allUsers = await db.select().from(users);
            expect(allUsers).toHaveLength(1);

            // Password should still be the first one
            const isValidFirst = await verifyPassword('FirstPass1!', allUsers[0].passwordHash!);
            const isValidSecond = await verifyPassword('SecondPass1!', allUsers[0].passwordHash!);

            expect(isValidFirst).toBe(true);
            expect(isValidSecond).toBe(false);
        });

        it('should log correct summary for mixed create/skip', async () =>
        {
            const consoleLogSpy = vi.spyOn(authLogger.setup, 'info').mockImplementation(() => 
            {});

            // Create first account
            process.env.SPFN_AUTH_ADMIN_EMAIL = 'existing@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORD = 'AdminPass1!';
            await ensureAdminExists();

            consoleLogSpy.mockClear();

            // Try to create multiple, one existing
            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'existing@example.com',
                    password: 'password',
                },
                {
                    email: 'new@example.com',
                    password: 'password',
                },
            ]);
            await ensureAdminExists();

            // Check summary log
            const summaryLog = consoleLogSpy.mock.calls.find(
                call => call[0]?.includes('Summary'),
            );
            expect(summaryLog).toBeDefined();
            expect(summaryLog![0]).toContain('1 created');
            expect(summaryLog![0]).toContain('1 skipped');

            consoleLogSpy.mockRestore();
        });
    });

    describe('Edge Cases', () =>
    {
        it('should do nothing if no environment variables are set', async () =>
        {
            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(0);
        });

        it('should do nothing if only ADMIN_EMAIL is set without password', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAIL = 'admin@example.com';
            // No ADMIN_PASSWORD

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            expect(allUsers).toHaveLength(0);
        });

        it('should handle database errors gracefully', async () =>
        {
            const consoleErrorSpy = vi.spyOn(authLogger.setup, 'error').mockImplementation(() => 
            {});

            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'invalid-email-format', // Invalid email might cause DB error
                    password: 'password123',
                    role: 'invalid-role', // Invalid role will cause check constraint error
                },
            ]);

            await ensureAdminExists();

            // Should not throw, should handle error
            expect(consoleErrorSpy).toHaveBeenCalled();

            consoleErrorSpy.mockRestore();
        });

        it('should auto-verify email for all created accounts', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                {
                    email: 'admin1@example.com',
                    password: 'password123',
                },
                {
                    email: 'admin2@example.com',
                    password: 'password123',
                },
            ]);

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            allUsers.forEach(user =>
            {
                expect(user.emailVerifiedAt).toBeTruthy();
                expect(user.emailVerifiedAt).toBeInstanceOf(Date);
            });
        });

        it('should set status to active for all created accounts', async () =>
        {
            process.env.SPFN_AUTH_ADMIN_EMAILS = 'admin1@example.com,admin2@example.com';
            process.env.SPFN_AUTH_ADMIN_PASSWORDS = 'pass1,pass2';

            await ensureAdminExists();

            const db = getTestDb();
            const allUsers = await db.select().from(users);

            allUsers.forEach(user =>
            {
                expect(user.status).toBe('active');
            });
        });
    });
});
