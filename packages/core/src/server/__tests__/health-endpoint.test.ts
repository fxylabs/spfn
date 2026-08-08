/**
 * The built-in health endpoint as an app actually meets it
 *
 * ✅ 테스트 범위:
 * - .infrastructure({ database: false }) 를 선언한 서버의 health 응답
 * - 앱 라우트가 내장 health 경로와 충돌할 때의 경고
 *
 * 🔗 관련 파일:
 * - src/server/create-server.ts
 * - src/server/helpers.ts
 *
 * Issue #119: examples/01-minimal-api declared no database, so the server refused
 * to boot; once it booted, health answered 503 forever because a database nobody
 * asked for counted as missing, and the example's own /health route never ran.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { route, defineRouter } from '@spfn/core/route';
import { defineServerConfig } from '../config-builder';
import { createServer } from '../create-server';
import { serverLogger } from '../logger';

const noDatabaseConfig = () => defineServerConfig()
    .port(0)
    .infrastructure({ database: false, redis: false })
    .healthCheck({ enabled: true, detailed: true })
    .build();

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('built-in health endpoint', () =>
{
    it('answers 200 for a server that declared no database', async () =>
    {
        const app = await createServer(noDatabaseConfig());

        const res = await app.fetch(new Request('http://localhost/health'));
        const body: any = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toBe('ok');
        expect(body.services.database.status).toBe('disabled');
        expect(body.services.redis.status).toBe('disabled');
    });

    it('warns that an app route on the health path never runs', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        const appHealth = route.get('/health').handler(async () => ({ status: 'from-app' }));
        const config = defineServerConfig()
            .port(0)
            .infrastructure({ database: false, redis: false })
            .routes(defineRouter({ appHealth }))
            .build();

        const app = await createServer(config);
        const res = await app.fetch(new Request('http://localhost/health'));
        const body: any = await res.json();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('GET /health'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('appHealth'));
        expect(body.status).not.toBe('from-app');
    });

    it('stays quiet when the app route sits on another path', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        const appStatus = route.get('/status').handler(async () => ({ status: 'from-app' }));
        const config = defineServerConfig()
            .port(0)
            .infrastructure({ database: false, redis: false })
            .routes(defineRouter({ appStatus }))
            .build();

        const app = await createServer(config);

        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('never runs'));

        const res = await app.fetch(new Request('http://localhost/status'));
        const body: any = await res.json();
        expect(body.status).toBe('from-app');
    });
});
