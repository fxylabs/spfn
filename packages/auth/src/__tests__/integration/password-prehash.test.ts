/**
 * Every character of a password counts (au9-N5).
 *
 * bcrypt reads 72 bytes and ignores the rest, and the schema counted
 * characters: a password of 24 Korean characters and anything after them was
 * decided by those 24 characters alone. New hashes are bcrypt over a SHA-256
 * pre-hash; a legacy hash still signs in, and the sign-in replaces it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import * as bcrypt from '@node-rs/bcrypt';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users, verificationCodes } from '@/server/entities';
import { generateKeyPair } from '@/server/lib/crypto';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

/**
 * Holds the next `hashPassword` call until released — the legacy upgrade hashes
 * only after the password is verified, so this pauses a sign-in between the two.
 */
const hashGate = vi.hoisted(() => ({ held: null as null | { entered: () => void; release: Promise<void> } }));

vi.mock('@/server/helpers/password', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@/server/helpers/password')>();

    return {
        ...actual,
        hashPassword: async (password: string) =>
        {
            const held = hashGate.held;
            hashGate.held = null;
            if (held)
            {
                held.entered();
                await held.release;
            }

            return actual.hashPassword(password);
        },
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { changePasswordService } = await import('@/server/services/auth.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 24 Hangul syllables, three UTF-8 bytes each: exactly bcrypt's 72. */
const SHARED_72_BYTES = '가나다라마바사아자차카타파하거너더러머버서어저처';
const SIGNED_UP_PASSWORD = `${SHARED_72_BYTES}Aa1!signed-up`;
const SAME_FIRST_72_BYTES = `${SHARED_72_BYTES}Zz9#different`;

describe.skipIf(!dbAvailable)('T2: passwords longer than 72 bytes', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';

        app = new Hono();
        registerRoutes(app, mainAuthRouter);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
    });

    async function post(path: string, body: unknown): Promise<Response>
    {
        return await app.request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    }

    async function signUp(email: string, password: string): Promise<Response>
    {
        await post('/_auth/codes', { target: email, targetType: 'email', purpose: 'registration' });

        const [codeRow] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);
        const verified = await post('/_auth/codes/verify', {
            target: email, targetType: 'email', code: codeRow.code, purpose: 'registration',
        });
        const { verificationToken } = await verified.json() as { verificationToken: string };
        const key = generateKeyPair('ES256');

        return post('/_auth/register', {
            email, password, verificationToken,
            publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm,
        });
    }

    async function signIn(email: string, password: string): Promise<number>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email, password,
            publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm,
        });

        return response.status;
    }

    async function storedHash(email: string): Promise<string>
    {
        const [row] = await getTestDb().select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, email));

        return row.passwordHash!;
    }

    it('refuses a password that shares only its first 72 bytes with the one signed up with', async () =>
    {
        expect((await signUp('long@example.com', SIGNED_UP_PASSWORD)).status).toBe(200);

        expect(await signIn('long@example.com', SAME_FIRST_72_BYTES)).toBe(401);
        expect(await signIn('long@example.com', SIGNED_UP_PASSWORD)).toBe(200);
    });

    it('signs a legacy-hash account in, stores the new format, and signs it in again', async () =>
    {
        const userRole = await getRoleByName('user');
        await getTestDb().insert(users).values({
            email: 'legacy@example.com',
            passwordHash: await bcrypt.hash('Legacy-Password-1!', 4),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });

        expect(await signIn('legacy@example.com', 'Legacy-Password-1!')).toBe(200);
        expect(await storedHash('legacy@example.com')).toMatch(/^\$spfn-sha256\$\$2[aby]\$/);
        expect(await signIn('legacy@example.com', 'Legacy-Password-1!')).toBe(200);
    });

    it('keeps a password changed while a legacy-hash sign-in is between verifying and upgrading', async () =>
    {
        const userRole = await getRoleByName('user');
        const [user] = await getTestDb().insert(users).values({
            email: 'race@example.com',
            passwordHash: await bcrypt.hash('Old-Password-0!', 4),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        }).returning();

        let release!: () => void;
        const released = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        const entered = new Promise<void>((resolve) =>
        {
            hashGate.held = { entered: resolve, release: released };
        });

        const pausedSignIn = signIn('race@example.com', 'Old-Password-0!');
        await entered;
        await changePasswordService({
            userId: user.id, credential: { kind: 'deviceKey', keyId: 'unused-unenrolled' }, currentPassword: 'Old-Password-0!', newPassword: 'New-Password-1!',
        });
        release();

        expect(await pausedSignIn).toBe(200);
        expect(await signIn('race@example.com', 'New-Password-1!')).toBe(200);
        expect(await signIn('race@example.com', 'Old-Password-0!')).toBe(401);
    });

    /** Holds the next `hashPassword` call: resolves once it is held, with the release. */
    function holdNextHash(): Promise<() => void>
    {
        let release!: () => void;
        const released = new Promise<void>((resolve) =>
        {
            release = resolve;
        });

        return new Promise((resolve) =>
        {
            hashGate.held = { entered: () => resolve(release), release: released };
        });
    }

    async function seedLegacy(email: string, password: string): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [user] = await getTestDb().insert(users).values({
            email,
            passwordHash: await bcrypt.hash(password, 4),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        }).returning();

        return user.id;
    }

    it('B1: changes the password when a legacy-hash sign-in re-encoded it while the change was hashing', async () =>
    {
        const userId = await seedLegacy('stale@example.com', 'Old-Password-0!');

        // The change has verified the legacy hash and is hashing the new password;
        // a sign-in with the same password replaces the legacy hash meanwhile.
        const held = holdNextHash();
        const change = changePasswordService({
            userId, credential: { kind: 'deviceKey', keyId: 'unused-unenrolled' }, currentPassword: 'Old-Password-0!', newPassword: 'New-Password-1!',
        });
        const release = await held;
        expect(await signIn('stale@example.com', 'Old-Password-0!')).toBe(200);
        expect(await storedHash('stale@example.com')).toMatch(/^\$spfn-sha256\$/);
        release();

        await expect(change).resolves.toBeUndefined();
        expect(await signIn('stale@example.com', 'New-Password-1!')).toBe(200);
        expect(await signIn('stale@example.com', 'Old-Password-0!')).toBe(401);
    });

    it('B1: still refuses a change whose current password a concurrent change replaced', async () =>
    {
        const userId = await seedLegacy('moved@example.com', 'Old-Password-0!');

        const held = holdNextHash();
        const change = changePasswordService({
            userId, credential: { kind: 'deviceKey', keyId: 'unused-unenrolled' }, currentPassword: 'Old-Password-0!', newPassword: 'Mine-Password-1!',
        });
        const release = await held;
        await changePasswordService({
            userId, credential: { kind: 'deviceKey', keyId: 'unused-unenrolled' }, currentPassword: 'Old-Password-0!', newPassword: 'Theirs-Password-2!',
        });
        release();

        await expect(change).rejects.toMatchObject({ message: 'Current password is incorrect' });
        expect(await signIn('moved@example.com', 'Theirs-Password-2!')).toBe(200);
        expect(await signIn('moved@example.com', 'Mine-Password-1!')).toBe(401);
    });

    it('R1: a legacy hash of a longer password is not rewritten by a sign-in with exactly its first 72 bytes', async () =>
    {
        await seedLegacy('long-legacy@example.com', SIGNED_UP_PASSWORD);
        const legacyHash = await storedHash('long-legacy@example.com');

        // Accepted, as before the pre-hash: at 72 bytes bcrypt's NUL terminator
        // is cut off, so the legacy hash proves only these bytes, not the length.
        expect(await signIn('long-legacy@example.com', SHARED_72_BYTES)).toBe(200);
        expect(await storedHash('long-legacy@example.com')).toBe(legacyHash);
        expect(await signIn('long-legacy@example.com', SIGNED_UP_PASSWORD)).toBe(200);
    });
});
