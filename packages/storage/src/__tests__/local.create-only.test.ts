import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from '../server/local.provider';

vi.mock('node:fs/promises', async importOriginal =>
{
    const actual = await importOriginal<typeof import('node:fs/promises')>();

    return { ...actual, writeFile: vi.fn(actual.writeFile), copyFile: vi.fn(actual.copyFile) };
});

/** 임시 파일 디렉터리(local.provider.ts `PARTIAL_DIR`) — 어떤 key도 이 이름을 가질 수 없다. */
const PARTIAL_DIR = '\\partial';
const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

/** 앞 절반만 쓰고 실패하는 쓰기 — 디스크가 차거나 프로세스가 도중에 끊긴 경우. */
async function writeHalfThenFail(path: unknown, bytes: Buffer): Promise<never>
{
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await actual.writeFile(path as string, bytes.subarray(0, bytes.length / 2), { flag: 'wx' });
    throw diskFull;
}

describe('LocalStorageProvider create-only write before it is published', () =>
{
    let testRoot: string;
    let provider: LocalStorageProvider;

    beforeEach(async () =>
    {
        testRoot = await mkdtemp(join(tmpdir(), 'spfn-storage-create-only-'));
        provider = new LocalStorageProvider({ dir: join(testRoot, 'storage') });
    });

    afterEach(async () =>
    {
        vi.mocked(fs.writeFile).mockReset();
        vi.mocked(fs.copyFile).mockReset();
        await rm(testRoot, { recursive: true, force: true });
    });

    it('upload leaves nothing at the key, so the next create-only upload succeeds', async () =>
    {
        const body = Buffer.from('0123456789abcdef');
        vi.mocked(fs.writeFile).mockImplementationOnce(path => writeHalfThenFail(path, body));

        await expect(provider.upload('log/000001.json', body, 'application/json', { ifAbsent: true }))
            .rejects.toBe(diskFull);
        await expect(readdir(join(testRoot, 'storage', 'log'))).resolves.toEqual([]);
        await expect(readdir(join(testRoot, 'storage', PARTIAL_DIR))).resolves.toEqual([]);

        await provider.upload('log/000001.json', body, 'application/json', { ifAbsent: true });
        await expect(provider.download('log/000001.json')).resolves.toEqual(body);
    });

    it('copy leaves nothing at the destination, so the next create-only copy succeeds', async () =>
    {
        await provider.upload('src.json', 'complete source', 'application/json');
        const source = await readFile(join(testRoot, 'storage', 'src.json'));
        vi.mocked(fs.copyFile).mockImplementationOnce((_from, to) => writeHalfThenFail(to, source));

        await expect(provider.copy('src.json', 'log/000001.json', { ifAbsent: true })).rejects.toBe(diskFull);
        await expect(readdir(join(testRoot, 'storage', 'log'))).resolves.toEqual([]);
        await expect(readdir(join(testRoot, 'storage', PARTIAL_DIR))).resolves.toEqual([]);

        await provider.copy('src.json', 'log/000001.json', { ifAbsent: true });
        await expect(provider.download('log/000001.json')).resolves.toEqual(source);
    });

    it('a write in progress is invisible to list, and deletePrefix cannot cut it short', async () =>
    {
        const body = Buffer.from('0123456789abcdef');
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        let finish = (): void => undefined;
        const halfWritten = new Promise<void>(resolveHalf =>
        {
            vi.mocked(fs.writeFile).mockImplementationOnce(async path =>
            {
                await actual.writeFile(path as string, body.subarray(0, body.length / 2), { flag: 'wx' });
                resolveHalf();
                await new Promise<void>(resolveFinish => (finish = resolveFinish));
                await actual.appendFile(path as string, body.subarray(body.length / 2));
            });
        });
        const writing = provider.upload('log/000001.json', body, 'application/json', { ifAbsent: true });
        await halfWritten;

        await expect(provider.list('log')).resolves.toEqual({ objects: [] });
        await expect(provider.deletePrefix('log')).resolves.toMatchObject({ deleted: 0 });

        finish();
        await writing;
        await expect(provider.download('log/000001.json')).resolves.toEqual(body);
    });
});
