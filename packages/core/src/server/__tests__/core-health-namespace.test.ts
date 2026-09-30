/**
 * Where the built-in health endpoint answers, cell by cell.
 *
 * ✅ 테스트 범위:
 * - /_core/health 가 앱 라우트·앱 미들웨어와 무관하게 항상 답하는지
 * - core 가 /health 를 더 이상 등록하지 않고, 410 안내만 남기는지
 * - healthCheck({ path }) 가 명시적 opt-in 으로만 두번째 경로를 여는지
 * - healthCheck.enabled: false 가 안내까지 포함해 전부 끄는지
 *
 * 🔗 관련 파일:
 * - src/server/create-server.ts
 * - src/server/namespace.ts
 *
 * 설계 근거: readiness probe 의 경로는 이 저장소가 바꿀 수 없는 곳에 박혀 있다 —
 * GitOps 매니페스트의 readinessProbe, Dockerfile 의 HEALTHCHECK, 로드밸런서 콘솔.
 * 버전을 올려도 그것들은 따라오지 않는다. 그래서 앱이 무엇을 선언하든 참인 주소가
 * 하나 필요하고, 그것이 /_core/health 다.
 *
 * 내장 엔드포인트는 전부 앱 라우트보다, 그리고 beforeRoutes 훅보다 먼저 등록된다.
 * Hono 미들웨어는 자기 뒤에 등록된 핸들러만 감싸므로, 이 순서가 probe 를 인증 없이
 * 닿게 하는 유일한 장치다. 15번 칸이 그 회귀를 막는다.
 *
 * 각 it 은 설계 승인 시점의 케이스 표 한 칸에 1:1로 대응한다. 칸 번호는 그 표의
 * 번호이며, 단정은 표에 적힌 기대 결과를 그대로 옮긴 것이다.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { route, defineRouter } from '@spfn/core/route';
import { defineServerConfig } from '../config-builder';
import { createServer } from '../create-server';
import { CORE_HEALTH_PATH, CORE_NAMESPACE, LEGACY_HEALTH_PATH } from '../namespace';
import { createServerlessApp, resetServerlessApp } from '../serverless';
import { serverLogger } from '../logger';

import type { Hono, MiddlewareHandler } from 'hono';
import type { Router } from '@spfn/core/route';

function serverConfig(options: {
    routes?: Router<any>;
    healthCheck?: { enabled?: boolean; path?: string; detailed?: boolean };
    use?: MiddlewareHandler[];
    beforeRoutes?: (app: Hono) => void;
    proxyGuard?: boolean;
} = {})
{
    const builder = defineServerConfig()
        .port(0)
        .infrastructure({ database: false, redis: false })
        .healthCheck(options.healthCheck ?? { enabled: true, detailed: true });

    if (options.routes)
    {
        builder.routes(options.routes);
    }

    if (options.use)
    {
        builder.use(options.use);
    }

    if (options.beforeRoutes)
    {
        builder.lifecycle({ beforeRoutes: options.beforeRoutes });
    }

    if (options.proxyGuard)
    {
        builder.proxyGuard({ mode: 'strict', secret: 'a'.repeat(48) });
    }

    return builder.build();
}

function get(app: { fetch: (request: Request) => Response | Promise<Response> }, path: string)
{
    return app.fetch(new Request(`http://localhost${path}`));
}

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('cell 1 — enabled, no path configured, app declares nothing', () =>
{
    it('answers at /_core/health', async () =>
    {
        const app = await createServer(serverConfig());

        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(core.status).toBe('ok');
    });

    it('answers 410 at /health, naming where it went', async () =>
    {
        const app = await createServer(serverConfig());

        const gone = await get(app, LEGACY_HEALTH_PATH);
        const body: any = await gone.json();

        expect(gone.status).toBe(410);
        expect(body.movedTo).toBe(CORE_HEALTH_PATH);
        expect(body.detail).toContain(CORE_HEALTH_PATH);
        expect(body.detail).toContain('healthCheck');
    });

    it('warns once, however many times the path is probed', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);
        const app = await createServer(serverConfig());

        await get(app, LEGACY_HEALTH_PATH);
        await get(app, LEGACY_HEALTH_PATH);
        await get(app, LEGACY_HEALTH_PATH);

        const notices = warn.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('410'));

        expect(notices).toHaveLength(1);
        expect(notices[0][0]).toContain(CORE_HEALTH_PATH);
    });

    it('says nothing at boot — the notice belongs to the request, not the start-up', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        await createServer(serverConfig());

        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('410'));
    });
});

describe('cell 2 — enabled, no path configured, app declares GET /health', () =>
{
    const appHealth = route.get(LEGACY_HEALTH_PATH).handler(async () => ({ status: 'from-app' }));

    it('leaves /health entirely to the app', async () =>
    {
        const app = await createServer(serverConfig({ routes: defineRouter({ appHealth }) }));

        const mine: any = await (await get(app, LEGACY_HEALTH_PATH)).json();
        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(mine.status).toBe('from-app');
        expect(core.status).toBe('ok');
    });

    it('says nothing about it — the app owns that path now', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        const app = await createServer(serverConfig({ routes: defineRouter({ appHealth }) }));
        await get(app, LEGACY_HEALTH_PATH);

        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('410'));
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('never runs'));
    });
});

describe('cell 3 — enabled, no path configured, app declares POST /health only', () =>
{
    it('answers 410 on GET and leaves POST to the app', async () =>
    {
        const createHealth = route.post(LEGACY_HEALTH_PATH).handler(async () => ({ status: 'from-app' }));

        const app = await createServer(serverConfig({ routes: defineRouter({ createHealth }) }));

        const read = await get(app, LEGACY_HEALTH_PATH);
        const write = await app.fetch(new Request(`http://localhost${LEGACY_HEALTH_PATH}`, { method: 'POST' }));

        expect(read.status).toBe(410);
        expect(write.status).toBe(200);
    });
});

describe('cell 4 — enabled, path: \'/health\', app declares nothing', () =>
{
    it('restores the built-in on /health, with no 410 anywhere', async () =>
    {
        const app = await createServer(serverConfig({
            healthCheck: { enabled: true, path: LEGACY_HEALTH_PATH, detailed: true },
        }));

        const restored = await get(app, LEGACY_HEALTH_PATH);
        const body: any = await restored.json();
        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(restored.status).toBe(200);
        expect(body.status).toBe('ok');
        expect(core.status).toBe('ok');
    });
});

describe('cell 5 — enabled, path: \'/health\', app declares GET /health', () =>
{
    const appHealth = route.get(LEGACY_HEALTH_PATH).handler(async () => ({ status: 'from-app' }));
    const config = () => serverConfig({
        routes: defineRouter({ appHealth }),
        healthCheck: { enabled: true, path: LEGACY_HEALTH_PATH, detailed: true },
    });

    it('gives the path to the built-in, because the app asked for it there', async () =>
    {
        const app = await createServer(config());

        const answered: any = await (await get(app, LEGACY_HEALTH_PATH)).json();

        expect(answered.status).toBe('ok');
        expect(answered.status).not.toBe('from-app');
    });

    it('warns that the app route never runs', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        await createServer(config());

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('appHealth'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('never runs'));
    });
});

describe('cell 6 — enabled, path: \'/healthz\', app declares nothing', () =>
{
    it('answers at the configured path and at /_core/health', async () =>
    {
        const app = await createServer(serverConfig({
            healthCheck: { enabled: true, path: '/healthz', detailed: true },
        }));

        const custom: any = await (await get(app, '/healthz')).json();
        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(custom.status).toBe('ok');
        expect(core.status).toBe('ok');
    });

    it('still answers 410 at /health — a configured path is not the old one', async () =>
    {
        const app = await createServer(serverConfig({
            healthCheck: { enabled: true, path: '/healthz', detailed: true },
        }));

        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(410);
    });
});

describe('cell 7 — enabled, path: \'/healthz\', app declares GET /healthz', () =>
{
    it('gives the path to the built-in and warns that the app route never runs', async () =>
    {
        const appHealthz = route.get('/healthz').handler(async () => ({ status: 'from-app' }));
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        const app = await createServer(serverConfig({
            routes: defineRouter({ appHealthz }),
            healthCheck: { enabled: true, path: '/healthz', detailed: true },
        }));

        const answered: any = await (await get(app, '/healthz')).json();

        expect(answered.status).toBe('ok');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('appHealthz'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('never runs'));
    });
});

describe('cell 8 — enabled, path: \'/healthz\', app declares GET /health', () =>
{
    it('leaves /health to the app and keeps the built-in on both its own paths', async () =>
    {
        const appHealth = route.get(LEGACY_HEALTH_PATH).handler(async () => ({ status: 'from-app' }));

        const app = await createServer(serverConfig({
            routes: defineRouter({ appHealth }),
            healthCheck: { enabled: true, path: '/healthz', detailed: true },
        }));

        const mine: any = await (await get(app, LEGACY_HEALTH_PATH)).json();
        const custom: any = await (await get(app, '/healthz')).json();
        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(mine.status).toBe('from-app');
        expect(custom.status).toBe('ok');
        expect(core.status).toBe('ok');
    });
});

describe('cell 9 — enabled, path: \'/_core/health\' (redundant)', () =>
{
    it('registers the canonical path once and still signposts /health', async () =>
    {
        const app = await createServer(serverConfig({
            healthCheck: { enabled: true, path: CORE_HEALTH_PATH, detailed: true },
        }));

        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(core.status).toBe('ok');
        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(410);
    });
});

describe('cell 10 — disabled, app declares nothing', () =>
{
    it('answers on no path, and signposts nothing — /health was already a 404 here', async () =>
    {
        const app = await createServer(serverConfig({ healthCheck: { enabled: false } }));

        expect((await get(app, CORE_HEALTH_PATH)).status).toBe(404);
        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(404);
    });
});

describe('cell 11 — disabled, app declares GET /health', () =>
{
    it('lets the app route answer and leaves /_core/health absent', async () =>
    {
        const appHealth = route.get(LEGACY_HEALTH_PATH).handler(async () => ({ status: 'from-app' }));

        const app = await createServer(serverConfig({
            routes: defineRouter({ appHealth }),
            healthCheck: { enabled: false },
        }));

        const mine: any = await (await get(app, LEGACY_HEALTH_PATH)).json();

        expect(mine.status).toBe('from-app');
        expect((await get(app, CORE_HEALTH_PATH)).status).toBe(404);
    });
});

describe('cell 12 — disabled, path: \'/healthz\'', () =>
{
    it('answers on none of the three paths', async () =>
    {
        const app = await createServer(serverConfig({
            healthCheck: { enabled: false, path: '/healthz' },
        }));

        expect((await get(app, CORE_HEALTH_PATH)).status).toBe(404);
        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(404);
        expect((await get(app, '/healthz')).status).toBe(404);
    });
});

describe('cell 13 — enabled, app declares a route inside /_core/', () =>
{
    const appCoreHealth = route.get(CORE_HEALTH_PATH).handler(async () => ({ status: 'from-app' }));

    it('answers with the built-in, not the app route', async () =>
    {
        const app = await createServer(serverConfig({ routes: defineRouter({ appCoreHealth }) }));

        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(core.status).toBe('ok');
        expect(core.status).not.toBe('from-app');
    });

    it('warns that the route inside the namespace never runs', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        await createServer(serverConfig({ routes: defineRouter({ appCoreHealth }) }));

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('appCoreHealth'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(CORE_NAMESPACE));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('never runs'));
    });
});

describe('cell 14 — enabled, app declares a root-level parameter route', () =>
{
    /**
     * `GET /:slug` matches `/health` too, and it is registered before the
     * signpost. The app wins that path, which is correct — it declared a route
     * covering it. What must not move is the canonical endpoint: `/:slug` is one
     * segment and `/_core/health` is two, and the built-in is registered first
     * either way.
     */
    it('keeps /_core/health while the parameter route takes /health', async () =>
    {
        const getBySlug = route.get('/:slug').handler(async () => ({ status: 'from-slug' }));

        const app = await createServer(serverConfig({ routes: defineRouter({ getBySlug }) }));

        const slug: any = await (await get(app, LEGACY_HEALTH_PATH)).json();
        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(slug.status).toBe('from-slug');
        expect(core.status).toBe('ok');
    });
});

describe('cell 15 — enabled, a global middleware added in the beforeRoutes hook', () =>
{
    /**
     * The regression this whole design exists to prevent. `beforeRoutes` hands
     * an app the raw Hono instance and its documented use is
     * `app.use('/*', globalMiddleware())`. A Hono middleware wraps handlers
     * registered after it and no others — so a health endpoint registered after
     * this hook would sit behind an app's auth guard, and every readiness probe
     * would answer 401 with nothing saying why.
     */
    const authenticate: MiddlewareHandler = async (c, next) =>
    {
        if (!c.req.header('authorization'))
        {
            return c.json({ error: 'unauthorized' }, 401);
        }

        await next();

        return undefined;
    };

    it('leaves /_core/health reachable without credentials', async () =>
    {
        const app = await createServer(serverConfig({
            beforeRoutes: hono => hono.use('*', authenticate),
        }));

        const core = await get(app, CORE_HEALTH_PATH);

        expect(core.status).toBe(200);
        expect((await core.json() as any).status).toBe('ok');
    });

    it('leaves a configured second path reachable without credentials too', async () =>
    {
        const app = await createServer(serverConfig({
            healthCheck: { enabled: true, path: LEGACY_HEALTH_PATH, detailed: true },
            beforeRoutes: hono => hono.use('*', authenticate),
        }));

        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(200);
    });

    it('lets that middleware answer the signpost, which depends on nothing', async () =>
    {
        const app = await createServer(serverConfig({
            beforeRoutes: hono => hono.use('*', authenticate),
        }));

        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(401);
    });
});

describe('cell 16 — enabled, the proxy guard in strict mode', () =>
{
    /**
     * A probe reaches the server directly and carries no proxy signature. A
     * guard that does not skip the health paths rejects every readiness check —
     * the pod never enters rotation and nothing says why. The signpost is skipped
     * for the same reason: an operator whose probe broke has to be able to read
     * the 410 rather than a rejection.
     */
    it('lets a probe reach /_core/health, and the signpost answer 410', async () =>
    {
        const app = await createServer(serverConfig({ proxyGuard: true }));

        expect((await get(app, CORE_HEALTH_PATH)).status).toBe(200);
        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(410);
    });
});

describe('cell 17 — enabled, path: \'/healthz\', the proxy guard in strict mode', () =>
{
    it('lets a probe reach the configured path without a signature', async () =>
    {
        const app = await createServer(serverConfig({
            healthCheck: { enabled: true, path: '/healthz', detailed: true },
            proxyGuard: true,
        }));

        expect((await get(app, '/healthz')).status).toBe(200);
        expect((await get(app, CORE_HEALTH_PATH)).status).toBe(200);
    });
});

describe('cell 18 — a serverless app', () =>
{
    it('gets the same paths, because createServerlessApp goes through createServer', async () =>
    {
        resetServerlessApp();

        // Core's required variables — the boot check refuses an app without them.
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
        vi.stubEnv('NEXT_PUBLIC_SPFN_API_URL', 'http://localhost:8790');

        const app = await createServerlessApp(serverConfig());

        const core: any = await (await get(app, CORE_HEALTH_PATH)).json();

        expect(core.status).toBe('ok');
        expect((await get(app, LEGACY_HEALTH_PATH)).status).toBe(410);

        vi.unstubAllEnvs();
        resetServerlessApp();
    });
});
