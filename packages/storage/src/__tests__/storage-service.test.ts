import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProviderConfig } from '../shared/index';

type ServerModule = typeof import('../server/index');

describe('storage service factory and default service', () =>
{
    let testRoot: string;
    let server: ServerModule;
    const previousLocalDir = process.env.LOCAL_STORAGE_DIR;

    beforeEach(async () =>
    {
        testRoot = await mkdtemp(join(tmpdir(), 'spfn-storage-service-'));
        // 기본 서비스는 모듈 상태다 — 행마다 새 모듈로 시작한다.
        vi.resetModules();
        server = await import('../server/index');
    });

    afterEach(async () =>
    {
        vi.restoreAllMocks();
        if (previousLocalDir === undefined)
        {
            delete process.env.LOCAL_STORAGE_DIR;
        }
        else
        {
            process.env.LOCAL_STORAGE_DIR = previousLocalDir;
        }
        await rm(testRoot, { recursive: true, force: true });
    });

    it('creates services that write to their own roots without sharing state', async () =>
    {
        const files = await server.createStorageService({ provider: 'local', local: { dir: join(testRoot, 'files') } });
        const records = await server.createStorageService({ provider: 'local', local: { dir: join(testRoot, 'records') } });

        await files.upload('a.txt', 'file-bytes', 'text/plain');
        await records.upload('a.txt', 'record-bytes', 'text/plain');

        expect((await files.download('a.txt')).toString()).toBe('file-bytes');
        expect((await records.download('a.txt')).toString()).toBe('record-bytes');
    });

    it('refuses to reconfigure the default service with different options', async () =>
    {
        const options = { provider: 'local' as const, local: { dir: join(testRoot, 'default') } };
        const first = await server.getStorageService(options);

        await expect(server.getStorageService({ provider: 'local', local: { dir: join(testRoot, 'other') } }))
            .rejects.toThrow('createStorageService');
        await expect(server.getStorageService({ ...options, local: { ...options.local } })).resolves.toBe(first);
        await expect(server.getStorageService()).resolves.toBe(first);
    });

    // 같은 서비스를 만드는 다른 표기 — 원래 옵션 객체를 비교하면 하나같이 앱 부트를 거부한다.
    it.each<[string, (root: string) => LocalProviderConfig, (root: string) => LocalProviderConfig]>([
        ['a missing optional and an explicit undefined', root => ({ dir: join(root, 'a') }), root => ({ dir: join(root, 'a'), baseUrl: undefined })],
        ['a relative and an absolute root', () => ({ dir: 'a' }), root => ({ dir: join(root, 'a') })],
        ['the env-backed root left out and spelled out', () => ({}), root => ({ dir: join(root, 'from-env') })],
    ])('accepts %s as the same default service', async (_spelling, first, second) =>
    {
        vi.spyOn(process, 'cwd').mockReturnValue(testRoot);
        process.env.LOCAL_STORAGE_DIR = join(testRoot, 'from-env');
        const service = await server.getStorageService({ provider: 'local', local: first(testRoot) });

        await expect(server.getStorageService({ provider: 'local', local: second(testRoot) })).resolves.toBe(service);
    });

    it('ignores the options of a provider the default service does not use', async () =>
    {
        const options = { provider: 'local' as const, local: { dir: join(testRoot, 'default') } };
        const service = await server.getStorageService(options);

        await expect(server.getStorageService({ ...options, s3: { bucket: 'elsewhere' } })).resolves.toBe(service);
    });

    it('hands concurrent first callers one default service', async () =>
    {
        const options = { provider: 'local' as const, local: { dir: join(testRoot, 'default') } };

        const [left, right] = await Promise.all([server.getStorageService(options), server.getStorageService(options)]);

        expect(left).toBe(right);
    });
});
