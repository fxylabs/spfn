/**
 * @spfn/auth - Setup Functions
 *
 * Initial setup and admin account creation
 */

import { env } from '@spfn/auth/config';
import { describeError } from '@spfn/core/logger';
import { getRoleByName } from '@spfn/auth/server';

import { hashNewPassword } from './services/password-rule.service';
import { isEmailAllowedForRole, ROLE_EMAIL_DOMAINS_VAR } from './lib/role-email-domains';
import { authLogger } from './logger';
import { usersRepository } from './repositories';

/**
 * Admin account configuration
 */
interface AdminAccountConfig
{
    /**
     * 1-based position in the list as the operator wrote it — the index in
     * `SPFN_AUTH_ADMIN_ACCOUNTS` or `SPFN_AUTH_ADMIN_EMAILS`, `1` for the
     * single form. Lines and errors name an account by it, never by address.
     */
    position: number;
    email: string;
    password: string;
    role?: string; // Role name (e.g., 'user', 'admin', 'superadmin')
    phone?: string;
    passwordChangeRequired?: boolean;
}

/** What became of one configured account */
type SeedOutcome = 'created' | 'skipped' | 'failed';

/**
 * Parse admin accounts from environment variables
 *
 * Supports three formats (in priority order):
 *
 * 1. JSON format (ADMIN_ACCOUNTS):
 *    ```
 *    ADMIN_ACCOUNTS='[{"email":"admin@example.com","password":"pass","role":"superadmin"}]'
 *    ```
 *
 * 2. Comma-separated format (ADMIN_EMAILS + ADMIN_PASSWORDS + ADMIN_ROLES):
 *    ```
 *    ADMIN_EMAILS=admin@example.com,user@example.com
 *    ADMIN_PASSWORDS=admin-pass,user-pass
 *    ADMIN_ROLES=superadmin,user
 *    ```
 *
 * 3. Single account format (legacy, ADMIN_EMAIL + ADMIN_PASSWORD):
 *    ```
 *    ADMIN_EMAIL=admin@example.com
 *    ADMIN_PASSWORD=admin-password
 *    ```
 *
 * An entry with a missing email or password is skipped, as is a JSON entry
 * whose email, password, phone or role is not the string type each needs;
 * the warning names the position and the field, never the value. The
 * accounts kept carry their own position.
 *
 * @returns Array of admin account configurations
 */
function parseAdminAccounts(): AdminAccountConfig[]
{
    // Method 1: JSON format (highest priority)
    if (env.SPFN_AUTH_ADMIN_ACCOUNTS)
    {
        return parseJsonAccounts(env.SPFN_AUTH_ADMIN_ACCOUNTS);
    }

    // Method 2: Comma-separated format
    if (env.SPFN_AUTH_ADMIN_EMAILS)
    {
        return parseCommaSeparatedAccounts(env.SPFN_AUTH_ADMIN_EMAILS);
    }

    // Method 3: Single account (legacy format)
    const adminEmail = env.SPFN_AUTH_ADMIN_EMAIL;
    const adminPassword = env.SPFN_AUTH_ADMIN_PASSWORD;

    if (adminEmail && adminPassword)
    {
        return [{
            position: 1,
            email: adminEmail,
            password: adminPassword,
            role: 'superadmin',
            passwordChangeRequired: true,
        }];
    }

    return [];
}

/**
 * The field of a `SPFN_AUTH_ADMIN_ACCOUNTS` entry that is not the type
 * `createSeededAccount` and the password rule need, or `null` when the entry
 * is usable. `email` and `password` must be non-empty strings; `phone` and
 * `role`, when present, must be strings — a number, object or array in any
 * of those would otherwise reach code written for a string (`.trim()`,
 * `createHash().update()`, string interpolation).
 */
function invalidAccountField(item: unknown): string | null
{
    if (typeof item !== 'object' || item === null || Array.isArray(item))
    {
        return 'entry';
    }

    const entry = item as Record<string, unknown>;

    if (typeof entry.email !== 'string' || entry.email.trim() === '')
    {
        return 'email';
    }

    if (typeof entry.password !== 'string' || entry.password === '')
    {
        return 'password';
    }

    for (const field of ['phone', 'role'] as const)
    {
        if (entry[field] !== undefined && entry[field] !== null && typeof entry[field] !== 'string')
        {
            return field;
        }
    }

    return null;
}

/**
 * The accounts of `SPFN_AUTH_ADMIN_ACCOUNTS`
 *
 * A value that is not JSON is reported without the parser's error: V8 quotes
 * the value it failed on in that message — a short one whole, a long one
 * around the failing token — so it would carry an address or a password.
 */
function parseJsonAccounts(value: string): AdminAccountConfig[]
{
    let parsed: unknown;

    try
    {
        parsed = JSON.parse(value);
    }
    catch
    {
        authLogger.setup.error('❌ SPFN_AUTH_ADMIN_ACCOUNTS is not valid JSON');

        return [];
    }

    if (!Array.isArray(parsed))
    {
        authLogger.setup.error('❌ SPFN_AUTH_ADMIN_ACCOUNTS must be an array');

        return [];
    }

    return parsed.flatMap((item, index) =>
    {
        const invalidField = invalidAccountField(item);

        if (invalidField)
        {
            authLogger.setup.warn(`⚠️  Skipping account ${index + 1}: invalid ${invalidField}`);

            return [];
        }

        const entry = item as { email: string; password: string; role?: string; phone?: string; passwordChangeRequired?: boolean };

        return [{
            position: index + 1,
            email: entry.email,
            password: entry.password,
            role: entry.role || 'user',
            phone: entry.phone,
            passwordChangeRequired: entry.passwordChangeRequired !== false, // Default: true
        }];
    });
}

/**
 * The accounts of `SPFN_AUTH_ADMIN_EMAILS`, `SPFN_AUTH_ADMIN_PASSWORDS` and
 * `SPFN_AUTH_ADMIN_ROLES`, matched by position
 */
function parseCommaSeparatedAccounts(adminEmails: string): AdminAccountConfig[]
{
    const emails = adminEmails.split(',').map(s => s.trim());
    const passwords = (env.SPFN_AUTH_ADMIN_PASSWORDS || '').split(',').map(s => s.trim());
    const roles = (env.SPFN_AUTH_ADMIN_ROLES || '').split(',').map(s => s.trim());

    // Validate lengths match
    if (passwords.length !== emails.length)
    {
        authLogger.setup.error('❌ SPFN_AUTH_ADMIN_EMAILS and SPFN_AUTH_ADMIN_PASSWORDS length mismatch');

        return [];
    }

    return emails.flatMap((email, index) =>
    {
        const password = passwords[index];

        if (!email || !password)
        {
            authLogger.setup.warn(`⚠️  Skipping account ${index + 1}: missing email or password`);

            return [];
        }

        return [{
            position: index + 1,
            email,
            password,
            role: roles[index] || 'user',
            passwordChangeRequired: true,
        }];
    });
}

/**
 * Refuse boot when a configured admin account's role is one the email-domain
 * policy would not let it hold.
 *
 * A throw rather than a `failed` count: the account would be created holding a
 * role every check then refuses, or — for a superadmin — not created while the
 * operator believes it was. Seeded accounts are auto-verified, so only the
 * domain can fail. The accounts are named by their position in the list as
 * the operator wrote it, never by address.
 */
function assertSeedAccountsWithinPolicy(accounts: AdminAccountConfig[]): void
{
    const refused = accounts.flatMap((account) =>
    {
        const roleName = account.role || 'user';

        return isEmailAllowedForRole({ email: account.email, emailVerifiedAt: new Date() }, roleName)
            ? []
            : [`#${account.position} (role '${roleName}')`];
    });

    if (refused.length > 0)
    {
        throw new Error(
            `${ROLE_EMAIL_DOMAINS_VAR} does not allow the email of configured admin account(s) ${refused.join(', ')} `
            + 'to hold that role. Seed the account under an allowed domain, change its role, or list the domain.',
        );
    }
}

/**
 * Ensure admin accounts exist from environment variables
 *
 * Supports multiple admin account creation via three formats:
 * 1. JSON format (SPFN_AUTH_ADMIN_ACCOUNTS)
 * 2. Comma-separated format (SPFN_AUTH_ADMIN_EMAILS + SPFN_AUTH_ADMIN_PASSWORDS + SPFN_AUTH_ADMIN_ROLES)
 * 3. Single account format (SPFN_AUTH_ADMIN_EMAIL + SPFN_AUTH_ADMIN_PASSWORD) - legacy
 *
 * Default behavior for created accounts:
 * - emailVerifiedAt: current timestamp (auto-verified)
 * - passwordChangeRequired: true — the account's session can do nothing but
 *   change the password until it is changed or reset (#362)
 * - status: 'active'
 *
 * Each password is held to the app's password rule (`password.validate`,
 * `channel: 'seed'`) before it is hashed; an account whose password it refuses
 * is not created and counts as failed.
 *
 * Each account writes one line on `@spfn/auth:setup` saying what became of it
 * — `Admin account created`, `Admin account already exists` or
 * `Admin account not created` — naming it by `position`, its 1-based place in
 * the list as written, and by `userId` once a row exists. The configured
 * address is never logged.
 *
 * @throws Error when `SPFN_AUTH_ROLE_EMAIL_DOMAINS` does not allow an account's
 *         email for its role — checked for every account before any is created
 *
 * @example
 * ```typescript
 * // In your server startup code:
 * import { ensureAdminExists } from '@spfn/auth/server';
 *
 * await ensureAdminExists();
 * ```
 */
export async function ensureAdminExists(): Promise<void>
{
    const accounts = parseAdminAccounts();

    // Skip if no accounts configured
    if (accounts.length === 0)
    {
        return;
    }

    assertSeedAccountsWithinPolicy(accounts);

    authLogger.setup.info(`Creating ${accounts.length} admin account(s)...`);

    const outcomes: SeedOutcome[] = [];

    for (const account of accounts)
    {
        outcomes.push(await seedAccount(account));
    }

    const count = (outcome: SeedOutcome) => outcomes.filter(each => each === outcome).length;
    const created = count('created');

    // Summary
    authLogger.setup.info(`📊 Summary: ${created} created, ${count('skipped')} skipped, ${count('failed')} failed`);

    if (created > 0)
    {
        authLogger.setup.info('⚠️  Please change passwords on first login!');
    }
}

/**
 * Create one configured account unless a row for its address exists
 *
 * Writes the account's one outcome line, naming it by `position` and, once a
 * row exists, by `userId` — never by the configured address.
 */
async function seedAccount(account: AdminAccountConfig): Promise<SeedOutcome>
{
    const { position } = account;

    try
    {
        // Whatever form the address was stored in, not only the canonical
        // one. This branch answers "no" by creating a privileged account, so
        // a lookup that misses an admin stored as `Admin@Example.com` would
        // make a second one holding the configured password.
        const existing = await usersRepository.findByEmailInAnyStoredForm(account.email);

        if (existing)
        {
            authLogger.setup.info('Admin account already exists', { position, userId: existing.id });

            return 'skipped';
        }

        const roleName = account.role || 'user';
        const role = await getRoleByName(roleName);

        if (!role)
        {
            authLogger.setup.error('Admin account not created: role not found. Run initializeAuth() first.', { position });

            return 'failed';
        }

        const user = await createSeededAccount(account, role.id);

        authLogger.setup.info('Admin account created', { position, userId: user.id, role: roleName });

        return 'created';
    }
    catch (error)
    {
        // Described here, not by the logger: a failed insert's error carries
        // the address it was given, and every sink of the call would see it
        authLogger.setup.error('Admin account not created', { position, error: describeError(error) });

        return 'failed';
    }
}

/**
 * Insert the row of a seeded account
 *
 * The app's password rule is asked of the seeded password too: until it is
 * changed it signs in, and whoever guesses it chooses the next one. It is
 * asked about the phone the row stores — an empty one stored as null is null
 * to it too.
 */
async function createSeededAccount(account: AdminAccountConfig, roleId: number)
{
    const phone = account.phone || null;

    return await usersRepository.create({
        email: account.email,
        phone,
        passwordHash: await hashNewPassword(account.password, { channel: 'seed', email: account.email, phone }),
        roleId,
        emailVerifiedAt: new Date(), // Auto-verify admin
        passwordChangeRequired: account.passwordChangeRequired !== false,
        status: 'active',
    });
}
