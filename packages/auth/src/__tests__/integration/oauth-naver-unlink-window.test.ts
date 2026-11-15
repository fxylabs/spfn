/**
 * @spfn/auth - A Naver unlink notification is accepted only while it is fresh (au5-A4)
 *
 * T4: a validly signed notification whose timestamp is outside the five-minute
 * window is refused, the link stays and no `auth.oauth.unlinked` fires; a fresh
 * one removes the link and announces it. Through the real route and the real
 * Naver verifier, signed the way Naver signs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { userSocialAccounts, users } from '@/server/entities';
import { registerOAuthProvider } from '@/server/lib/oauth';
import { naverProvider } from '@/server/lib/oauth/naver-provider';
import { oauthUnlinkedEvent } from '@/server/events';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const CLIENT_ID = 'naver-window-client';
const CLIENT_SECRET = 'naver-window-secret';
const NAVER_ID = 'NAVER_WINDOW_UNIQUE_ID';

/** Naver's key: the first 16 bytes of md5(client secret), for both AES and HMAC. */
function naverKey(): Buffer
{
    return createHash('md5').update(CLIENT_SECRET).digest().subarray(0, 16);
}

/** The form Naver posts: the encrypted unique id, the timestamp, and the signature over both. */
function notification(timestampSeconds: number): URLSearchParams
{
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-128-cbc', naverKey(), iv);
    const encryptUniqueId = Buffer.concat([iv, cipher.update(NAVER_ID, 'utf8'), cipher.final()]).toString('base64url');
    const timestamp = String(timestampSeconds);
    const signature = createHmac('sha256', naverKey())
        .update(`clientId=${CLIENT_ID}&encryptUniqueId=${encryptUniqueId}&timestamp=${timestamp}`)
        .digest('base64url');

    return new URLSearchParams({ clientId: CLIENT_ID, encryptUniqueId, timestamp, signature });
}

describe.skipIf(!dbAvailable)('Naver unlink-notify window (T4, au5-A4)', () =>
{
    let app: Hono;
    const unlinked: unknown[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();
        oauthUnlinkedEvent.subscribe((payload) =>
        {
            unlinked.push(payload);
        });
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
        registerOAuthProvider(naverProvider);
        vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_ID', CLIENT_ID);
        vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_SECRET', CLIENT_SECRET);
        await linkNaver();
        unlinked.length = 0;
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    async function linkNaver(): Promise<void>
    {
        const userRole = await getRoleByName('user');
        const [user] = await getTestDb().insert(users).values({ email: 'naver@window.test', roleId: userRole!.id })
            .returning({ id: users.id });
        await getTestDb().insert(userSocialAccounts).values({ userId: user!.id, provider: 'naver', providerUserId: NAVER_ID });
    }

    function notify(form: URLSearchParams): Promise<Response>
    {
        return Promise.resolve(app.request('/_auth/oauth/naver/unlink-notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        }));
    }

    async function naverLinks(): Promise<number>
    {
        return (await getTestDb().select().from(userSocialAccounts)).length;
    }

    it('a stale notification (ten minutes old) is refused: the link stays and nothing is announced', async () =>
    {
        const response = await notify(notification(Math.floor(Date.now() / 1000) - 10 * 60));

        expect(response.status).toBe(400);
        expect(await naverLinks()).toBe(1);
        expect(unlinked).toEqual([]);
    });

    it('a fresh notification is accepted: the link goes and the unlink is announced', async () =>
    {
        const response = await notify(notification(Math.floor(Date.now() / 1000)));

        expect(response.status).toBe(204);
        expect(await naverLinks()).toBe(0);
        expect(unlinked).toEqual([expect.objectContaining({ provider: 'naver', providerUserId: NAVER_ID })]);
    });
});
