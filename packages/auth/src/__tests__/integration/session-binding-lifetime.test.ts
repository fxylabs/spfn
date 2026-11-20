/**
 * @spfn/auth - an expired bound key is a dead key (audit bundle 8 part 1, au3-A1/A4/A5/B8)
 *
 * | Row | Checks |
 * |-----|--------|
 * | T1  | a bound key past grace; the owner turns binding off → that key still 401, its row revoked |
 * | T2  | turning it off: keys not yet expired keep working as ordinary keys; one expired within grace → 401, |
 * |     | its row revoked; a parked (pending second factor) bound key: not expired → ordinary, expired → revoked |
 * | T3  | two web sessions; one turns binding on → the other's key is bound and short, and cannot be renewed |
 * |     | without a passkey; a non-web key of the same account is untouched |
 * | T4  | sign-out from an expired bound session within grace → key revoked, renewal afterwards refused |
 * |     | (the proxy half — cookies cleared — is T4 in `unit/session-binding-proxy.test.ts`) |
 * | T5  | the `auth.mfa.sweep` job revokes a bound key past grace and leaves one within grace |
 * | T6  | rotation, renewal, a sign-in's replacement proof and a sign-in re-registering the key, each applied |
 * |     | to a key past grace → still dead |
 * | P1  | a web key registered before the migration, never used since: the enable leaves it, and its rotation |
 * |     | through the proxy is bound |
 * | P1r | the same key rotated through the proxy with its own use not yet recorded (the flag write and the |
 * |     | bind spied away) → the new key a web key, bound at the rotation |
 * | P1b | the same key used through the proxy after the enable → that request served, the key bound then |
 * | P1e | the bind at that first proxied use fails once (lock timeout) → the next proxied use binds the key |
 * | P1c | a pre-migration key with a proxy signal (`last_seen_ip`) → the backfill makes it a web key, bound at |
 * |     | the enable itself |
 * | P1d | a pre-migration native key (client kind `ios`, never attested) → not bound at the enable, nor by its |
 * |     | own use |
 *
 * | P2  | a bound session approves a device-code sign-in it started: no passkey proof → 403 and no device key; |
 * |     | with the proof → approved, the device key an ordinary 90-day key; an unbound account → approved |
 * | P2U | the proof's assertion without user verification → 403, the device not approved; with it → approved |
 * | P2L | the same three for issuing a device link (with the proof: redeemed, confirmed, polled) |
 * | P2A | a bound session adds a passkey: no proof → 403 and none added; with the proof → added |
 * | P2W | a bound account with no password sets one: no proof → 403 and none set; with the proof → set |
 * | P3  | an owner who lost every passkey and has no password: the operator's reset turns binding off and |
 * |     | the live bound session becomes an ordinary key |
 * | P2O | a bound admin session mints an ops token: no proof → 403 and none minted; with the proof → minted; |
 * |     | an unbound admin → minted as before |
 *
 * The P1 rows start from rows shaped as the `via_web_proxy` migration finds
 * them — the column at its default, the signals as earlier code wrote them —
 * and run that migration's own backfill statement over them.
 * Real HTTP against the mounted auth router. Time moves by shifting a key's
 * stored expiry, never by waiting. `clientType` — what proxy-guard sets — is
 * set from a test header, so a web session and a native one are both reachable.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { deviceLinks, opsTokens, passkeys, userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { signKeyReplacementProof } from '@/server/lib/key-replacement-proof';
import { authenticate } from '@/server/middleware/authenticate';
import { BOUND_KEY_RENEW_GRACE_HOURS, BOUND_KEY_TTL_HOURS, KEY_TTL_DAYS } from '@/server/lib/key-policy';
import { EXPIRED_AT_UNBIND_REASON, PAST_GRACE_REASON, resetSessionBindingService } from '@/server/services/session-binding.service';
import { createMfaSweepJob } from '@/server/jobs/mfa-sweep';
import { keysRepository, usersRepository } from '@/server/repositories';
import { keysRepository as servedKeysRepository } from '@spfn/auth/server';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CLIENT_TYPE_HEADER = 'x-test-client-type';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PAST_GRACE_MS = (BOUND_KEY_RENEW_GRACE_HOURS + 1) * HOUR_MS;

/** The `via_web_proxy` migration's backfill statements, as they will run on upgrade. */
const BACKFILL = readFileSync(resolve(__dirname, '../../../migrations/20261116100109_premium_quasimodo/migration.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.split('\n').filter(line => !line.startsWith('--')).join('\n').trim())
    .filter(statement => statement.startsWith('UPDATE'));

interface Session
{
    authorization: string;
    keyId: string;
    privateKey: string;
}

describe.skipIf(!dbAvailable)('an expired bound key is a dead key (T1-T6)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;

        app = new Hono();
        app.use('*', async (c, next) =>
        {
            const declared = c.req.header(CLIENT_TYPE_HEADER);

            if (declared)
            {
                c.set('clientType', declared);
            }

            await next();
        });
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();
        vi.restoreAllMocks();

        await db.insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        });
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function post(path: string, body: unknown, session?: Session, proxied = true)
    {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        if (session)
        {
            headers.Authorization = session.authorization;
        }

        if (proxied)
        {
            headers[CLIENT_TYPE_HEADER] = 'web';
        }

        return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    function sessionOf(keyId: string, privateKey: string): Session
    {
        return {
            authorization: `Bearer ${generateClientToken({ keyId }, privateKey, 'ES256', { expiresIn: '5m' })}`,
            keyId,
            privateKey,
        };
    }

    /** Sign in with a new key — through the proxy, or as a native client when `proxied` is false. */
    async function signIn(proxied = true): Promise<Session>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: 'owner@test.com',
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        }, undefined, proxied);

        expect(response.status).toBe(200);

        return sessionOf(keyPair.keyId, keyPair.privateKey);
    }

    async function enrollPasskey(session: Session): Promise<FixtureAuthenticator>
    {
        const authenticator = await FixtureAuthenticator.create();
        const verify = await registerPasskey(session, authenticator);

        expect(verify.status).toBe(200);

        return authenticator;
    }

    async function registerPasskey(session: Session, authenticator: FixtureAuthenticator, passkeyResponse?: unknown)
    {
        const options = await post('/_auth/passkeys/register/options', {}, session);

        return await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
            passkeyResponse,
        }, session);
    }

    /** Sign in, enrol a passkey, turn binding on. */
    async function boundSession(): Promise<Session>
    {
        return (await boundOwner()).session;
    }

    /** A bound session, and the passkey it can prove with. */
    async function boundOwner(): Promise<{ session: Session; authenticator: FixtureAuthenticator }>
    {
        const session = await signIn();
        const authenticator = await enrollPasskey(session);

        expect((await enableBinding((path, body) => post(path, body, session), authenticator, { origin: ORIGIN, rpId: RP_ID })).status).toBe(200);

        return { session, authenticator };
    }

    /** A passkey assertion over `session/passkey-proof/options` for one procedure, made by this session. */
    async function passkeyProof(session: Session, authenticator: FixtureAuthenticator, procedure: string): Promise<unknown>
    {
        const options = await post('/_auth/session/passkey-proof/options', { procedure }, session);
        expect(options.status).toBe(200);

        return authenticator.assert({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 });
    }

    /** A device asking to be let in by device code, directly to the backend as a TV or a CLI does. */
    async function startDevice()
    {
        const device = generateKeyPair('ES256');
        const started = await (await post('/_auth/device/start', {
            publicKey: device.publicKey, keyId: device.keyId, fingerprint: device.fingerprint, algorithm: device.algorithm,
        }, undefined, false)).json() as { userCode: string; deviceCode: string };

        return { ...started, keyId: device.keyId };
    }

    /** Redeem a link code with a new device's key, confirm it from the issuer and poll — the device's key id. */
    async function completeLink(issuer: Session, issued: { linkId: string; userCode: string }): Promise<string>
    {
        const device = generateKeyPair('ES256');
        const redeemed = await post('/_auth/device/link/redeem', {
            userCode: issued.userCode,
            publicKey: device.publicKey, keyId: device.keyId, fingerprint: device.fingerprint, algorithm: device.algorithm,
        }, undefined, false);
        expect(redeemed.status).toBe(200);
        const { deviceCode, matchNumber } = await redeemed.json() as { deviceCode: string; matchNumber: number };

        expect((await post('/_auth/device/link/confirm', { linkId: issued.linkId, choice: matchNumber }, issuer)).status).toBe(200);
        expect((await post('/_auth/device/link/poll', { deviceCode }, undefined, false)).status).toBe(200);

        return device.keyId;
    }

    function expectOrdinaryKey(row: { binding: string; isActive: boolean; expiresAt: Date | null } | undefined)
    {
        expect(row?.binding).toBe('none');
        expect(row?.isActive).toBe(true);
        expect(Math.abs(row!.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);
    }

    /** The refusal names the procedure it asks the proof for (#400): a client learns which to prove. */
    async function expectPasskeyProofRequired(response: Response, procedure: string): Promise<void>
    {
        expect(response.status).toBe(403);
        const body = await response.json();
        expect({ code: body.error.code, details: body.details }).toEqual({ code: 'PasskeyProofRequiredError', details: { procedure } });
    }

    function changePassword(session: Session, body: Record<string, unknown>)
    {
        return app.request('/_auth/password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: session.authorization, [CLIENT_TYPE_HEADER]: 'web' },
            body: JSON.stringify(body),
        });
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function expireKey(keyId: string, agoMs: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ expiresAt: new Date(Date.now() - agoMs) })
            .where(eq(userPublicKeys.keyId, keyId));
    }

    /** Whether a session's key signs an ordinary authenticated request — through the proxy, or directly. */
    async function works(session: Session, proxied = true): Promise<boolean>
    {
        return (await post('/_auth/keys/list', {}, sessionOf(session.keyId, session.privateKey), proxied)).status === 200;
    }

    /**
     * Put a key into the shape the `via_web_proxy` migration finds it in — the
     * column at its default, unbound, and the two signals as earlier code left
     * them — then run that migration's backfill over the table.
     */
    async function migrateFromLegacy(keyId: string, signals: { lastSeenIp?: string; clientKind?: 'ios' } = {}): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ viaWebProxy: false, binding: 'none', lastSeenIp: signals.lastSeenIp ?? null, clientKind: signals.clientKind ?? null })
            .where(eq(userPublicKeys.keyId, keyId));

        for (const statement of BACKFILL)
        {
            await getTestDb().execute(sql.raw(statement));
        }
    }

    /** Turn binding on from a session of the account, with a passkey enrolled on it. */
    async function enableFrom(session: Session): Promise<void>
    {
        const authenticator = await enrollPasskey(session);

        expect((await enableBinding((path, body) => post(path, body, session), authenticator, { origin: ORIGIN, rpId: RP_ID })).status).toBe(200);
    }

    function expectBoundNow(row: { binding: string; expiresAt: Date | null })
    {
        expect(row.binding).toBe('passkey');
        expect(Math.abs(row.expiresAt!.getTime() - (Date.now() + BOUND_KEY_TTL_HOURS * HOUR_MS))).toBeLessThan(60_000);
    }

    const disableWithPassword = (session: Session) =>
        post('/_auth/session/binding', { mode: 'none', currentPassword: PASSWORD }, session);

    // ========================================================================
    // Rows
    // ========================================================================

    it('T1: a bound key past its grace, the owner turns binding off → that key still 401 and its row is revoked', async () =>
    {
        const owner = await boundSession();
        const copy = await signIn();
        await expireKey(copy.keyId, PAST_GRACE_MS);

        expect((await disableWithPassword(owner)).status).toBe(200);

        expect((await post('/_auth/keys/list', {}, sessionOf(copy.keyId, copy.privateKey))).status).toBe(401);
        const row = await keyRow(copy.keyId);
        expect(row.isActive).toBe(false);
        expect(row.revokedReason).toBe(EXPIRED_AT_UNBIND_REASON);
    });

    it('T2: turning binding off: keys not yet expired keep working as ordinary keys; one expired within grace → 401 and revoked', async () =>
    {
        const owner = await boundSession();
        const live = await signIn();
        const lapsed = await signIn();
        await expireKey(lapsed.keyId, BOUND_KEY_RENEW_GRACE_HOURS * HOUR_MS - HOUR_MS);
        // Two bound keys still waiting on a second factor: one not yet expired, one expired
        const parked = await signIn();
        const parkedLapsed = await signIn();
        await getTestDb().update(userPublicKeys)
            .set({ isActive: false, pendingMfaChallengeId: 424242 })
            .where(inArray(userPublicKeys.keyId, [parked.keyId, parkedLapsed.keyId]));
        await expireKey(parkedLapsed.keyId, 60_000);

        expect((await disableWithPassword(owner)).status).toBe(200);

        const stillParked = await keyRow(parked.keyId);
        expect(stillParked.binding).toBe('none');
        expect(stillParked.pendingMfaChallengeId).toBe(424242);
        expect(Math.abs(stillParked.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);
        const parkedRevoked = await keyRow(parkedLapsed.keyId);
        expect(parkedRevoked.isActive).toBe(false);
        expect(parkedRevoked.pendingMfaChallengeId).toBeNull();
        expect(parkedRevoked.revokedReason).toBe(EXPIRED_AT_UNBIND_REASON);
        expect(parkedRevoked.expiresAt!.getTime()).toBeLessThan(Date.now());

        for (const session of [owner, live])
        {
            const row = await keyRow(session.keyId);
            expect(row.binding).toBe('none');
            expect(Math.abs(row.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);
            expect(await works(session)).toBe(true);
        }

        expect((await post('/_auth/keys/list', {}, sessionOf(lapsed.keyId, lapsed.privateKey))).status).toBe(401);
        const revoked = await keyRow(lapsed.keyId);
        expect(revoked.isActive).toBe(false);
        expect(revoked.revokedReason).toBe(EXPIRED_AT_UNBIND_REASON);
    });

    it('T3: one of two web sessions turns binding on → the other is bound, short, and not renewable without a passkey; a native key is untouched', async () =>
    {
        const first = await signIn();
        const second = await signIn();
        const native = await signIn(false);
        const nativeBefore = await keyRow(native.keyId);
        const authenticator = await enrollPasskey(first);

        expect((await enableBinding((path, body) => post(path, body, first), authenticator, { origin: ORIGIN, rpId: RP_ID })).status).toBe(200);

        const bound = await keyRow(second.keyId);
        expect(bound.binding).toBe('passkey');
        expect(Math.abs(bound.expiresAt!.getTime() - (Date.now() + BOUND_KEY_TTL_HOURS * HOUR_MS))).toBeLessThan(60_000);

        // At its expiry: rotation does not reset it, and renewal wants the assertion.
        await expireKey(second.keyId, 60_000);
        const expired = sessionOf(second.keyId, second.privateKey);
        const fresh = generateKeyPair('ES256');
        const pair = { publicKey: fresh.publicKey, keyId: fresh.keyId, fingerprint: fresh.fingerprint, algorithm: fresh.algorithm };
        expect((await post('/_auth/keys/rotate', pair, expired)).status).toBe(401);
        expect((await post('/_auth/session/renew/options', {}, expired)).status).toBe(200);
        expect((await post('/_auth/session/renew/verify', { response: {}, ...pair }, expired)).status).toBeGreaterThanOrEqual(400);
        expect((await keyRow(second.keyId)).isActive).toBe(true);
        expect(await works(second)).toBe(false);

        const nativeAfter = await keyRow(native.keyId);
        expect(nativeAfter.binding).toBe('none');
        expect(nativeAfter.expiresAt!.getTime()).toBe(nativeBefore.expiresAt!.getTime());
        expect(await works(native, false)).toBe(true);
    });

    it('T4: sign-out from an expired bound session within grace → the key is revoked and renewal afterwards refused', async () =>
    {
        const session = await boundSession();
        await expireKey(session.keyId, 60_000);
        const expired = sessionOf(session.keyId, session.privateKey);

        expect((await post('/_auth/logout', {}, expired)).status).toBe(204);

        expect((await keyRow(session.keyId)).isActive).toBe(false);
        const renewal = await post('/_auth/session/renew/options', {}, sessionOf(session.keyId, session.privateKey));
        expect(renewal.status).toBe(401);
        expect((await renewal.json()).error.code).toBe('SessionRenewalRefusedError');
    });

    it('T5: the sweep job revokes a bound key past its grace and leaves one within it', async () =>
    {
        const within = await boundSession();
        const past = await signIn();
        await expireKey(within.keyId, HOUR_MS);
        await expireKey(past.keyId, PAST_GRACE_MS);

        await createMfaSweepJob().handler();

        const swept = await keyRow(past.keyId);
        expect(swept.isActive).toBe(false);
        expect(swept.revokedReason).toBe(PAST_GRACE_REASON);
        expect((await keyRow(within.keyId)).isActive).toBe(true);
    });

    it('T6: rotation, renewal, a replacement proof and a re-registering sign-in on a key past grace → it stays dead', async () =>
    {
        const session = await boundSession();
        await expireKey(session.keyId, PAST_GRACE_MS);
        const dead = () => sessionOf(session.keyId, session.privateKey);
        const stored = await keyRow(session.keyId);
        const fresh = generateKeyPair('ES256');
        const pair = { publicKey: fresh.publicKey, keyId: fresh.keyId, fingerprint: fresh.fingerprint, algorithm: fresh.algorithm };
        const credentials = { email: 'owner@test.com', password: PASSWORD };

        expect((await post('/_auth/keys/rotate', pair, dead())).status).toBe(401);
        expect((await post('/_auth/session/renew/options', {}, dead())).status).toBe(401);
        expect((await post('/_auth/login', {
            ...credentials,
            ...pair,
            replacementProof: signKeyReplacementProof({ oldKeyId: session.keyId, newKeyId: fresh.keyId }, session.privateKey, 'ES256'),
        })).status).toBe(200);
        expect((await post('/_auth/login', {
            ...credentials,
            publicKey: stored.publicKey,
            keyId: stored.keyId,
            fingerprint: stored.fingerprint,
            algorithm: stored.algorithm,
        })).status).toBe(200);

        const row = await keyRow(session.keyId);
        expect(row.expiresAt!.getTime()).toBe(stored.expiresAt!.getTime());
        expect(row.binding).toBe('passkey');
        expect(await works(session)).toBe(false);
    });

    it('P1: a web session registered before the migration and never used since: the enable leaves it, its rotation through the proxy is bound', async () =>
    {
        const first = await signIn();
        const legacy = await signIn();
        await migrateFromLegacy(legacy.keyId);
        expect((await keyRow(legacy.keyId)).viaWebProxy).toBe(false);

        await enableFrom(first);
        expect((await keyRow(legacy.keyId)).binding).toBe('none');

        const fresh = generateKeyPair('ES256');
        const pair = { publicKey: fresh.publicKey, keyId: fresh.keyId, fingerprint: fresh.fingerprint, algorithm: fresh.algorithm };
        expect((await post('/_auth/keys/rotate', pair, sessionOf(legacy.keyId, legacy.privateKey))).status).toBe(200);

        expectBoundNow(await keyRow(fresh.keyId));
    });

    it('P1r: a legacy web key rotated through the proxy before its own use is recorded → the new key is a web key, bound at the rotation', async () =>
    {
        const first = await signIn();
        const legacy = await signIn();
        await migrateFromLegacy(legacy.keyId);
        await enableFrom(first);

        // The rotate request's own use of the old key — the flag write and the
        // bind from its state — is kept from running, so only the rotation can
        // make the new key a web key.
        const flagWrite = vi.spyOn(servedKeysRepository, 'updateLastUsedById').mockResolvedValue(undefined);
        const bind = vi.spyOn(keysRepository, 'bindKeys').mockResolvedValue([]);
        const fresh = generateKeyPair('ES256');
        const pair = { publicKey: fresh.publicKey, keyId: fresh.keyId, fingerprint: fresh.fingerprint, algorithm: fresh.algorithm };

        expect((await post('/_auth/keys/rotate', pair, sessionOf(legacy.keyId, legacy.privateKey))).status).toBe(200);
        expect(flagWrite).toHaveBeenCalled();
        flagWrite.mockRestore();
        bind.mockRestore();

        expect((await keyRow(legacy.keyId)).viaWebProxy).toBe(false);
        const rotated = await keyRow(fresh.keyId);
        expect(rotated.viaWebProxy).toBe(true);
        expectBoundNow(rotated);
    });

    it('P1b: the same legacy key used through the proxy after the enable → that request is served and the key is bound then', async () =>
    {
        const first = await signIn();
        const legacy = await signIn();
        await migrateFromLegacy(legacy.keyId);
        await enableFrom(first);

        expect(await works(legacy)).toBe(true);

        await vi.waitFor(async () => expect((await keyRow(legacy.keyId)).binding).toBe('passkey'));
        expectBoundNow(await keyRow(legacy.keyId));
    });

    it('P1e: the bind at a legacy key\'s first proxied use fails once (lock timeout) → its next proxied use binds it', async () =>
    {
        const first = await signIn();
        const legacy = await signIn();
        await migrateFromLegacy(legacy.keyId);
        await enableFrom(first);

        const lock = vi.spyOn(usersRepository, 'lockAccount').mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));
        expect(await works(legacy)).toBe(true);
        await vi.waitFor(() => expect(lock).toHaveBeenCalled());
        await vi.waitFor(async () => expect((await keyRow(legacy.keyId)).viaWebProxy).toBe(true));
        lock.mockRestore();
        expect((await keyRow(legacy.keyId)).binding).toBe('none');

        expect(await works(legacy)).toBe(true);

        await vi.waitFor(async () => expect((await keyRow(legacy.keyId)).binding).toBe('passkey'));
        expectBoundNow(await keyRow(legacy.keyId));
    });

    it('P1c: a legacy key with a proxy signal (last_seen_ip) is a web key after the backfill and bound at the enable itself', async () =>
    {
        const first = await signIn();
        const legacy = await signIn();
        await migrateFromLegacy(legacy.keyId, { lastSeenIp: '203.0.113.7' });
        expect((await keyRow(legacy.keyId)).viaWebProxy).toBe(true);

        await enableFrom(first);

        expectBoundNow(await keyRow(legacy.keyId));
    });

    it('P1d: a legacy native key (client kind ios, never attested) is bound neither at the enable nor by its own use', async () =>
    {
        const first = await signIn();
        const native = await signIn(false);
        await migrateFromLegacy(native.keyId, { clientKind: 'ios' });
        await enableFrom(first);

        expect((await keyRow(native.keyId)).binding).toBe('none');
        expect(await works(native, false)).toBe(true);

        await vi.waitFor(async () => expect((await keyRow(native.keyId)).lastUsedAt).not.toBeNull());
        const row = await keyRow(native.keyId);
        expect(row.viaWebProxy).toBe(false);
        expect(row.binding).toBe('none');
    });

    it('P2: a bound session approving a device-code sign-in it started, without a passkey proof → 403 and no device key', async () =>
    {
        const owner = await boundSession();
        const device = await startDevice();

        await expectPasskeyProofRequired(await post('/_auth/device/approve', { userCode: device.userCode }, owner), 'deviceApprove');
        await post('/_auth/device/poll', { deviceCode: device.deviceCode }, undefined, false);

        expect(await keyRow(device.keyId)).toBeUndefined();
    });

    it('P2b: with the passkey proof → approved, and the device key is an ordinary 90-day key', async () =>
    {
        const { session, authenticator } = await boundOwner();
        const device = await startDevice();
        const passkeyResponse = await passkeyProof(session, authenticator, 'deviceApprove');

        expect((await post('/_auth/device/approve', { userCode: device.userCode, passkeyResponse }, session)).status).toBe(200);
        expect((await post('/_auth/device/poll', { deviceCode: device.deviceCode }, undefined, false)).status).toBe(200);

        expectOrdinaryKey(await keyRow(device.keyId));
    });

    it('P2U: a passkey proof whose assertion did not verify the person (no PIN, no biometric) → 403 and the device not approved; with verification → approved', async () =>
    {
        const { session, authenticator } = await boundOwner();
        const device = await startDevice();
        const options = await post('/_auth/session/passkey-proof/options', { procedure: 'deviceApprove' }, session);
        const presenceOnly = authenticator.assert({
            challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter: 1, userVerified: false,
        });

        await expectPasskeyProofRequired(await post('/_auth/device/approve', { userCode: device.userCode, passkeyResponse: presenceOnly }, session), 'deviceApprove');
        await post('/_auth/device/poll', { deviceCode: device.deviceCode }, undefined, false);
        expect(await keyRow(device.keyId)).toBeUndefined();

        const passkeyResponse = await passkeyProof(session, authenticator, 'deviceApprove');
        expect((await post('/_auth/device/approve', { userCode: device.userCode, passkeyResponse }, session)).status).toBe(200);
        expect((await post('/_auth/device/poll', { deviceCode: device.deviceCode }, undefined, false)).status).toBe(200);
        expectOrdinaryKey(await keyRow(device.keyId));
    });

    it('P2c: an account without binding approves without a proof, as before', async () =>
    {
        const owner = await signIn();
        const device = await startDevice();

        expect((await post('/_auth/device/approve', { userCode: device.userCode }, owner)).status).toBe(200);
        await post('/_auth/device/poll', { deviceCode: device.deviceCode }, undefined, false);

        expectOrdinaryKey(await keyRow(device.keyId));
    });

    it('P2L: issuing a device link — bound without a proof → 403 and no link; with it → the device key is ordinary; unbound → issued', async () =>
    {
        const { session, authenticator } = await boundOwner();

        await expectPasskeyProofRequired(await post('/_auth/device/link/issue', {}, session), 'linkIssue');
        expect(await getTestDb().select().from(deviceLinks)).toEqual([]);

        const passkeyResponse = await passkeyProof(session, authenticator, 'linkIssue');
        const issued = await post('/_auth/device/link/issue', { passkeyResponse }, session);
        expect(issued.status).toBe(200);
        expectOrdinaryKey(await keyRow(await completeLink(session, await issued.json())));

        expect((await disableWithPassword(session)).status).toBe(200);
        expect((await post('/_auth/device/link/issue', {}, session)).status).toBe(200);
    });

    it('P2A: a bound session adding a passkey — without a proof → 403 and none added; with one → added', async () =>
    {
        const { session, authenticator } = await boundOwner();
        const another = await FixtureAuthenticator.create();

        await expectPasskeyProofRequired(await registerPasskey(session, another), 'passkeyAdd');
        expect(await getTestDb().select().from(passkeys)).toHaveLength(1);

        const passkeyResponse = await passkeyProof(session, authenticator, 'passkeyAdd');
        expect((await registerPasskey(session, another, passkeyResponse)).status).toBe(200);
        expect(await getTestDb().select().from(passkeys)).toHaveLength(2);
    });

    it('P2W: a bound account with no password setting one — without a proof → 403 and none set; with one → set', async () =>
    {
        const { session, authenticator } = await boundOwner();
        await getTestDb().update(users).set({ passwordHash: null }).where(eq(users.email, 'owner@test.com'));
        const passwordOf = async () => (await getTestDb().select().from(users).where(eq(users.email, 'owner@test.com')))[0].passwordHash;

        await expectPasskeyProofRequired(await changePassword(session, { newPassword: 'Another123!' }), 'passwordSet');
        expect(await passwordOf()).toBeNull();

        const passkeyResponse = await passkeyProof(session, authenticator, 'passwordSet');
        expect((await changePassword(session, { newPassword: 'Another123!', passkeyResponse })).status).toBe(204);
        expect(await passwordOf()).not.toBeNull();
    });

    it('P2O: a bound admin session mints an ops token — without a proof → 403 and none minted; with one → minted; an unbound admin → minted', async () =>
    {
        const asAdmin = async () => await getTestDb().update(users)
            .set({ roleId: (await getRoleByName('admin'))!.id })
            .where(eq(users.email, 'owner@test.com'));
        const issue = (session: Session, passkeyResponse?: unknown) =>
            post('/_auth/ops-tokens', { name: 'ops', scopes: ['*'], expiresInDays: null, passkeyResponse }, session);
        const tokenCount = async () => (await getTestDb().select().from(opsTokens)).length;

        await asAdmin();
        const unbound = await signIn();
        expect((await issue(unbound)).status).toBe(200);

        const { session, authenticator } = await boundOwner();
        await expectPasskeyProofRequired(await issue(session), 'opsTokenIssue');
        expect(await tokenCount()).toBe(1);

        const minted = await issue(session, await passkeyProof(session, authenticator, 'opsTokenIssue'));
        expect(minted.status).toBe(200);
        expect((await minted.json()).token).toMatch(/^spfn_ops_/);
        expect(await tokenCount()).toBe(2);
    });

    it('P3: an owner who lost every passkey, with no password → the operator\'s reset turns binding off and the live bound session becomes an ordinary key', async () =>
    {
        const session = await boundSession();
        await getTestDb().update(passkeys).set({ revokedAt: new Date() });
        await getTestDb().update(users).set({ passwordHash: null }).where(eq(users.email, 'owner@test.com'));
        const [owner] = await getTestDb().select().from(users).where(eq(users.email, 'owner@test.com'));

        await resetSessionBindingService(owner.id);

        const [after] = await getTestDb().select().from(users).where(eq(users.id, owner.id));
        expect(after.sessionBinding).toBe('none');
        expectOrdinaryKey(await keyRow(session.keyId));
        expect(await works(session)).toBe(true);
    });
});
