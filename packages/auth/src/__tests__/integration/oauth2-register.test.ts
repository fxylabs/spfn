/**
 * @spfn/auth - OAuth 2.1 dynamic client registration (design #93 v2, case table 8a)
 *
 * One test per row of 8a. `POST /_auth/oauth2/register` is the one endpoint in
 * this feature that anybody may call, so the table is mostly about what it
 * refuses: plain http off loopback, an https origin the application did not
 * allow, a fragment, an empty redirect list, a confidential auth method, a grant
 * type this server does not issue.
 *
 * Every refusal is RFC 7591 §3.2.2 shaped (`{ error, error_description }`),
 * because the caller is an OAuth client library and not this application's own
 * client.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    createTestUser,
    mountAuthApp,
    registerClient,
    resetMemoryRateLimitStore,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import { MAX_UNGRANTED_CLIENTS_PER_IP } from '@/server/services/oauth2-client.service';
import { oauth2Clients } from '@/server/entities';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Client names are unique to this file: one fork runs every suite. */
const NAME = 'register-suite-cli';

const ALLOWED_HTTPS_ORIGIN = 'https://register-suite.example';

/** An account to hang a grant off, for the row about re-registration. */
const EMAIL = 'register-suite@test.com';

interface RegistrationBody
{
    error?: string;
    error_description?: string;
    client_id?: string;
    client_id_issued_at?: number;
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
    grant_types?: string[];
    response_types?: string[];
}

describe.skipIf(!dbAvailable)('OAuth2 register (8a)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        configureTestAuthorizationServer({ allowedRedirectOrigins: [ALLOWED_HTTPS_ORIGIN] });
    });

    /**
     * Rate-limit counters are cleared between rows, but the standing cap on
     * unapproved clients is a database count and `clearTables` handles that —
     * so rows may share an address, and the two rows that are ABOUT an address
     * name their own.
     */
    async function register(
        body: Record<string, unknown>,
        ip = '198.51.100.1',
    ): Promise<{ status: number; body: RegistrationBody }>
    {
        const response = await registerClient(app, body, ip);

        return { status: response.status, body: await response.json() as RegistrationBody };
    }

    it('loopback http on an arbitrary port, allowedRedirectOrigins irrelevant → 201', async () =>
    {
        const { status, body } = await register({
            client_name: NAME,
            redirect_uris: ['http://localhost:52341/cb'],
        });

        expect(status).toBe(201);
        expect(body.client_id).toMatch(/^spfn_client_[0-9a-f]{32}$/);
    });

    it('http://evil.example/cb, allowedRedirectOrigins irrelevant → 400 invalid_redirect_uri', async () =>
    {
        const { status, body } = await register({
            client_name: NAME,
            redirect_uris: ['http://evil.example/cb'],
        });

        expect(status).toBe(400);
        expect(body.error).toBe('invalid_redirect_uri');
    });

    it('https://app.example/cb with the origin in allowedRedirectOrigins → 201', async () =>
    {
        const { status, body } = await register({
            client_name: NAME,
            redirect_uris: [`${ALLOWED_HTTPS_ORIGIN}/cb`],
        });

        expect(status).toBe(201);
        expect(body.redirect_uris).toEqual([`${ALLOWED_HTTPS_ORIGIN}/cb`]);
    });

    it('https://app.example/cb with the origin absent from allowedRedirectOrigins → 400', async () =>
    {
        const { status, body } = await register({
            client_name: NAME,
            redirect_uris: ['https://not-allowed.example/cb'],
        });

        expect(status).toBe(400);
        expect(body.error).toBe('invalid_redirect_uri');
    });

    it('an allowed https URI carrying a fragment → 400 invalid_redirect_uri', async () =>
    {
        const { status, body } = await register({
            client_name: NAME,
            redirect_uris: [`${ALLOWED_HTTPS_ORIGIN}/cb#frag`],
        });

        expect(status).toBe(400);
        expect(body.error).toBe('invalid_redirect_uri');
    });

    it('an allowed URI reaching a path through a dot segment → 400 invalid_redirect_uri', async () =>
    {
        // Every spelling `new URL` resolves away: `\` is a path separator for
        // http and https, and the authority may be written with one separator or
        // two. A registration that resolves is not the destination it names.
        const spellings = [
            'http://127.0.0.1:5/x/../cb',
            'http://127.0.0.1:5/x/..\\cb',
            'http:\\\\127.0.0.1:5\\x\\..\\cb',
            'https://app.example/other/..\\cb',
            `${ALLOWED_HTTPS_ORIGIN}/other/..\\cb`,
        ];

        for (const uri of spellings)
        {
            const { status, body } = await register({ client_name: NAME, redirect_uris: [uri] });

            expect(status).toBe(400);
            expect(body.error).toBe('invalid_redirect_uri');
        }
    });

    it('a body that is not JSON → 400 invalid_client_metadata', async () =>
    {
        // RFC 7591 §3.1 says a registration request is `application/json`. A body
        // that is not reads as no metadata at all, which is refused on the field
        // it is missing — the same answer an empty object earns, and not a 500.
        const response = await app.request('/_auth/oauth2/register', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'x-forwarded-for': '198.51.100.7' },
            body: 'client_name=nobody',
        });
        const body = await response.json() as RegistrationBody;

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_client_metadata');
    });

    it('an empty redirect_uris array → 400 invalid_client_metadata', async () =>
    {
        const { status, body } = await register({ client_name: NAME, redirect_uris: [] });

        expect(status).toBe(400);
        expect(body.error).toBe('invalid_client_metadata');
    });

    it('token_endpoint_auth_method: client_secret_basic → 400', async () =>
    {
        const { status, body } = await register({
            client_name: NAME,
            redirect_uris: ['http://127.0.0.1:1234/cb'],
            token_endpoint_auth_method: 'client_secret_basic',
        });

        expect(status).toBe(400);
        expect(body.error).toBe('invalid_client_metadata');
    });

    it('grant_types: ["client_credentials"] → 400 invalid_client_metadata', async () =>
    {
        const { status, body } = await register({
            client_name: NAME,
            redirect_uris: ['http://127.0.0.1:1234/cb'],
            grant_types: ['client_credentials'],
        });

        expect(status).toBe(400);
        expect(body.error).toBe('invalid_client_metadata');
    });

    it('registering again under the same client_name → 201 with a new client_id, the old row and its grant untouched', async () =>
    {
        const { oauth2ClientsRepository, oauth2GrantsRepository } = await import('@/server/repositories');
        const first = await register({ client_name: NAME, redirect_uris: ['http://127.0.0.1:1/cb'] });

        expect(first.status).toBe(201);

        // The half of the row a registration alone cannot show: somebody has
        // approved the first client, and the second registration is a different
        // CLI install rather than an amendment to that consent.
        const original = await oauth2ClientsRepository.findByClientId(first.body.client_id!);
        const userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        const granted = await oauth2GrantsRepository.upsert({
            client: original!.id,
            user: userId,
            resource: TEST_RESOURCE,
            scopes: ['mcp:read'],
        });

        const second = await register({ client_name: NAME, redirect_uris: ['http://127.0.0.1:2/cb'] });

        expect(second.status).toBe(201);
        expect(second.body.client_id).not.toBe(first.body.client_id);
        expect((await oauth2ClientsRepository.findByClientId(first.body.client_id!))?.redirectUris)
            .toEqual(['http://127.0.0.1:1/cb']);

        const live = await oauth2GrantsRepository.listActiveByUserId(userId);

        expect(live).toHaveLength(1);
        expect(live[0]!.grant.id).toBe(granted.id);
        expect(live[0]!.client.id).toBe(original!.id);
    });

    it('http://127.0.0.1/cb and http://localhost/cb together → 201, both stored as written', async () =>
    {
        const uris = ['http://127.0.0.1/cb', 'http://localhost/cb'];
        const { status, body } = await register({ client_name: NAME, redirect_uris: uris });

        expect(status).toBe(201);
        expect(body.redirect_uris).toEqual(uris);
    });

    it('the response carries client_id_issued_at, the redirect_uris verbatim, and auth method none', async () =>
    {
        const uris = ['http://[0:0:0:0:0:0:0:1]:9/cb'];
        const before = Math.floor(Date.now() / 1000);
        const { status, body } = await register({ client_name: NAME, redirect_uris: uris });

        expect(status).toBe(201);
        expect(body.client_id_issued_at).toBeGreaterThanOrEqual(before - 5);
        expect(body.redirect_uris).toEqual(uris);
        expect(body.token_endpoint_auth_method).toBe('none');
        expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
        expect(body.response_types).toEqual(['code']);
        expect(body.client_name).toBe(NAME);
    });

    it('too many registrations from one IP → 429 from the rate limiter, in the application envelope', async () =>
    {
        const address = '198.51.100.240';
        const answers: { status: number; body: RegistrationBody }[] = [];

        for (let attempt = 0; attempt < 12; attempt++)
        {
            answers.push(await register({
                client_name: `${NAME}-burst-${attempt}`,
                redirect_uris: [`http://127.0.0.1:${9000 + attempt}/cb`],
            }, address));
        }

        // Two different bounds answer 429 on this route, and which one fired is
        // legible from the body: this is the limiter in front of the route, so
        // the request never reaches the service that speaks RFC 7591.
        expect(answers.slice(0, 10).map(answer => answer.status)).toEqual(Array(10).fill(201));
        expect(answers[10]!.status).toBe(429);
        expect(answers[10]!.body.error_description).toBeUndefined();
        expect(answers[10]!.body.error).not.toBe('invalid_client_metadata');
    });

    /**
     * The other half of the same row, and the half a rate limiter cannot cover:
     * a client row costs nothing to make and lives until the purge job sweeps
     * it, so an attacker slow enough to stay under any window would otherwise
     * accumulate rows forever. Driven through the service because the burst
     * limiter in front of the route refuses long before this cap is reached.
     */
    it('too many UNAPPROVED clients standing from one IP → 429, whatever the rate', async () =>
    {
        const { registerOAuth2ClientService } = await import('@/server/services/oauth2-client.service');
        const address = '198.51.100.241';

        for (let attempt = 0; attempt < MAX_UNGRANTED_CLIENTS_PER_IP; attempt++)
        {
            const result = await registerOAuth2ClientService({
                client_name: `${NAME}-standing-${attempt}`,
                redirect_uris: [`http://127.0.0.1:${8000 + attempt}/cb`],
            }, address);

            expect(result.ok).toBe(true);
        }

        const over = await registerOAuth2ClientService({
            client_name: `${NAME}-standing-over`,
            redirect_uris: ['http://127.0.0.1:8999/cb'],
        }, address);

        expect(over.ok).toBe(false);
        expect(over.ok === false && over.status).toBe(429);

        // The other bound, through the route this time, so the shape the
        // client's OAuth library reads is asserted too. The limiter has seen
        // nothing from this address — the twenty above went past it.
        const refused = await register({
            client_name: `${NAME}-standing-route`,
            redirect_uris: ['http://127.0.0.1:8998/cb'],
        }, address);

        expect(refused.status).toBe(429);
        expect(refused.body.error).toBe('invalid_client_metadata');
        expect(refused.body.error_description)
            .toBe(`This address has registered ${MAX_UNGRANTED_CLIENTS_PER_IP} clients in the last hour `
                + 'that nobody has approved. Complete or abandon one of those, or try again later.');
    });

    it('twenty unapproved clients registered an hour ago → 201, the window has moved past them', async () =>
    {
        const { registerOAuth2ClientService } = await import('@/server/services/oauth2-client.service');
        const address = '198.51.100.242';

        for (let attempt = 0; attempt < MAX_UNGRANTED_CLIENTS_PER_IP; attempt++)
        {
            const result = await registerOAuth2ClientService({
                client_name: `${NAME}-aged-${attempt}`,
                redirect_uris: [`http://127.0.0.1:${7000 + attempt}/cb`],
            }, address);

            expect(result.ok).toBe(true);
        }

        // Age the whole standing population past the window, written by the
        // database so the row is judged by the clock that stores it.
        await getTestDb()
            .update(oauth2Clients)
            .set({ createdAt: sql`now() - interval '2 hours'` })
            .where(eq(oauth2Clients.createdIp, address));

        const { status, body } = await register({
            client_name: `${NAME}-aged-now`,
            redirect_uris: ['http://127.0.0.1:7999/cb'],
        }, address);

        expect(status).toBe(201);
        expect(body.client_id).toMatch(/^spfn_client_[0-9a-f]{32}$/);
    });

    it('twenty-one registrations from one address at once → twenty rows, not twenty-one', async () =>
    {
        const { registerOAuth2ClientService } = await import('@/server/services/oauth2-client.service');
        const address = '198.51.100.243';

        // Every one of these counts before any of them has committed, which is
        // what a count-then-insert cap cannot survive.
        const results = await Promise.all(
            Array.from({ length: MAX_UNGRANTED_CLIENTS_PER_IP + 1 }, (_unused, index) =>
                registerOAuth2ClientService({
                    client_name: `${NAME}-race-${index}`,
                    redirect_uris: [`http://127.0.0.1:${6000 + index}/cb`],
                }, address)),
        );

        expect(results.filter(result => result.ok)).toHaveLength(MAX_UNGRANTED_CLIENTS_PER_IP);

        const rows = await getTestDb()
            .select()
            .from(oauth2Clients)
            .where(eq(oauth2Clients.createdIp, address));

        expect(rows).toHaveLength(MAX_UNGRANTED_CLIENTS_PER_IP);
    });
});
