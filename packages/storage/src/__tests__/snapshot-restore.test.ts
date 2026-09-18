/**
 * snapshotPrefix·restoreManifest의 단위 행 — 실백엔드가 만들어 줄 수 없는 상태(사라진 버전,
 * stat 장애, 동시성 상한, 매니페스트 형태)를 가짜 provider로 만든다. 실백엔드가 보여줄 수 있는
 * 행은 `provider.contract.ts`에 있다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    parseManifest,
    restoreManifest,
    serializeManifest,
    snapshotPrefix,
} from '../server/snapshot-restore';
import {
    StorageKeyError,
    StorageManifestInvalidError,
    StorageObjectNotFoundError,
    StorageVersionNotFoundError,
} from '../shared/index';
import type {
    DeleteManyResult,
    IStorageProvider,
    Manifest,
    ManifestEntry,
    PrefixDeleteResult,
    PresignedUrlResult,
    StorageCopyOptions,
    StorageListOptions,
    StorageListResult,
    StorageObject,
    StorageObjectStat,
} from '../shared/index';
import type { Readable } from 'node:stream';

interface FakeObject
{
    size: number;
    versionId?: string;
    contentHash?: string;
}

/**
 * list·stat·copy만 구현한 가짜 provider. `versions`는 "지금 존재하는 버전"이고, 매니페스트가
 * 가리키는 버전이 여기에 없으면 lifecycle이 걷어간 상태다.
 */
class FakeStorage implements IStorageProvider
{
    readonly providerKind: 'gcs' | 's3' | 'local';
    live = new Map<string, FakeObject>();
    versions = new Set<string>();
    pages: StorageListResult[] = [];
    maxConcurrentCopies = 0;
    private activeCopies = 0;

    constructor(providerKind: 'gcs' | 's3' | 'local' = 's3')
    {
        this.providerKind = providerKind;
    }

    async list(_prefix: string, _options: StorageListOptions = {}): Promise<StorageListResult>
    {
        return this.pages.shift() ?? { objects: [] };
    }

    async stat(key: string): Promise<StorageObjectStat>
    {
        const object = this.live.get(key);
        if (!object)
        {
            throw new StorageObjectNotFoundError(key);
        }

        return { key, ...object };
    }

    async copy(from: string, to: string, options: StorageCopyOptions = {}): Promise<void>
    {
        this.activeCopies += 1;
        this.maxConcurrentCopies = Math.max(this.maxConcurrentCopies, this.activeCopies);
        await Promise.resolve();
        this.activeCopies -= 1;
        const versionId = options.sourceVersionId;
        if (versionId !== undefined && !this.versions.has(`${from}@${versionId}`))
        {
            throw new StorageVersionNotFoundError(from, versionId);
        }
        this.live.set(to, { size: 1, ...(versionId ? { versionId: `${versionId}-restored` } : {}) });
    }

    getPublicUrl(key: string): string
    {
        return key;
    }

    getMaxFileSize(): number
    {
        return 0;
    }

    async getUploadUrl(): Promise<PresignedUrlResult>
    {
        throw new Error('not used by these cases');
    }

    async getPublicUploadUrl(): Promise<PresignedUrlResult>
    {
        throw new Error('not used by these cases');
    }

    async getDownloadUrl(): Promise<string>
    {
        throw new Error('not used by these cases');
    }

    async upload(): Promise<void>
    {
        throw new Error('not used by these cases');
    }

    async download(): Promise<Buffer>
    {
        throw new Error('not used by these cases');
    }

    async getStream(): Promise<Readable>
    {
        throw new Error('not used by these cases');
    }

    async deletePrefix(): Promise<PrefixDeleteResult>
    {
        throw new Error('not used by these cases');
    }

    async delete(): Promise<void>
    {
        throw new Error('not used by these cases');
    }

    async deleteMany(): Promise<DeleteManyResult>
    {
        throw new Error('not used by these cases');
    }

    async finalizeObject(): Promise<void>
    {
        throw new Error('not used by these cases');
    }
}

describe('StorageVersionNotFoundError', () =>
{
    it('is not a StorageObjectNotFoundError (5b: instanceof 행)', () =>
    {
        const error = new StorageVersionNotFoundError('gen/req-1/a.png', '17');

        expect(error).not.toBeInstanceOf(StorageObjectNotFoundError);
        expect(error.key).toBe('gen/req-1/a.png');
        expect(error.versionId).toBe('17');
    });
});

describe('snapshotPrefix', () =>
{
    it('records the current provider (5c: manifest.provider)', async () =>
    {
        const storage = new FakeStorage('gcs');
        storage.pages = [{ objects: [listed('gen/req-1/a.png', '17')] }];

        expect((await snapshotPrefix(storage, 'gen/req-1')).provider).toBe('gcs');
    });

    it('rejects a concurrency that is not a positive integer (5c: concurrency 0 / -1 / 1.5)', async () =>
    {
        const storage = new FakeStorage();
        const list = vi.spyOn(storage, 'list');

        for (const concurrency of [0, -1, 1.5])
        {
            await expect(snapshotPrefix(storage, 'gen/req-1', { concurrency }))
                .rejects.toBeInstanceOf(StorageKeyError);
        }
        expect(list).not.toHaveBeenCalled();
    });

    it('is not atomic across pages (5c 리뷰 행: 페이지 사이 객체 추가)', async () =>
    {
        const storage = new FakeStorage();
        storage.live.set('gen/req-1/a.png', { size: 1, versionId: '1' });
        storage.pages = [
            { objects: [listed('gen/req-1/a.png', '1')], cursor: 'page-2' },
            { objects: [listed('gen/req-1/late.png', '2')] },
        ];

        const manifest = await snapshotPrefix(storage, 'gen/req-1');

        expect(manifest.entries.map(entry => entry.key)).toEqual(['gen/req-1/a.png', 'gen/req-1/late.png']);
    });

    it('never asks the provider to enumerate noncurrent objects (5c: noncurrent 존재 — 정적 검사)', () =>
    {
        const banned = /ListObjectVersions|versions\s*:|softDeleted|\.restore\(/;
        const serverDir = join(import.meta.dirname, '..', 'server');

        const offenders = readdirSync(serverDir)
            .filter(name => name.endsWith('.ts'))
            .filter(name => banned.test(readFileSync(join(serverDir, name), 'utf8')));

        expect(offenders).toEqual([]);
    });
});

describe('restoreManifest pre-flight', () =>
{
    it('refuses a manifest from another provider (5d: provider 불일치)', async () =>
    {
        const storage = new FakeStorage('s3');
        const copy = vi.spyOn(storage, 'copy');

        await expect(restoreManifest(storage, manifest({ provider: 'gcs' })))
            .rejects.toBeInstanceOf(StorageManifestInvalidError);
        expect(copy).not.toHaveBeenCalled();
    });

    it('refuses an onto that crosses the public/private boundary (5d: public↔private)', async () =>
    {
        const storage = new FakeStorage();
        const copy = vi.spyOn(storage, 'copy');

        await expect(restoreManifest(storage, manifest({}), { onto: 'public/recovered' }))
            .rejects.toBeInstanceOf(StorageManifestInvalidError);
        expect(copy).not.toHaveBeenCalled();
    });

    it('refuses a target key over 1,024 bytes before copying (5d: onto로 대상 key 1024 초과)', async () =>
    {
        const storage = new FakeStorage();
        const copy = vi.spyOn(storage, 'copy');

        await expect(restoreManifest(storage, manifest({}), { onto: `gen/${'x'.repeat(1100)}` }))
            .rejects.toBeInstanceOf(StorageKeyError);
        expect(copy).not.toHaveBeenCalled();
    });

    it('rejects a concurrency that is not a positive integer (5d 리뷰 행: concurrency 0 / 음수)', async () =>
    {
        const storage = new FakeStorage();
        const stat = vi.spyOn(storage, 'stat');
        const copy = vi.spyOn(storage, 'copy');

        for (const concurrency of [0, -2])
        {
            await expect(restoreManifest(storage, manifest({}), { concurrency }))
                .rejects.toBeInstanceOf(StorageKeyError);
        }
        expect(stat).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
    });

    it('returns an empty result for a manifest with no entries (5d: entries 0개)', async () =>
    {
        const storage = new FakeStorage();

        expect(await restoreManifest(storage, manifest({ entries: [] })))
            .toEqual({ restored: [], skipped: [], failed: [] });
    });
});

describe('restoreManifest per entry', () =>
{
    it('skips an entry that has no versionId and restores its neighbour (5d: "null" 버전 포함)', async () =>
    {
        const storage = new FakeStorage();
        storage.versions.add('gen/req-1/b.png@7');

        const result = await restoreManifest(storage, manifest({
            entries: [{ key: 'gen/req-1/a.png', size: 1 }, { key: 'gen/req-1/b.png', size: 1, versionId: '7' }],
        }));

        expect(result.skipped).toEqual([{ key: 'gen/req-1/a.png', reason: 'no-version' }]);
        expect(result.restored).toEqual(['gen/req-1/b.png']);
    });

    it('reports version-missing when the recorded version is gone (5d: lifecycle로 사라짐)', async () =>
    {
        const storage = new FakeStorage();
        storage.versions.add('gen/req-1/b.png@7');

        const result = await restoreManifest(storage, manifest({
            entries: [
                { key: 'gen/req-1/a.png', size: 1, versionId: '3' },
                { key: 'gen/req-1/b.png', size: 1, versionId: '7' },
            ],
        }));

        expect(result.skipped).toEqual([{ key: 'gen/req-1/a.png', reason: 'version-missing' }]);
        expect(result.restored).toEqual(['gen/req-1/b.png']);
    });

    it('fails an entry whose stat throws and never copies it (5d: stat이 임의 예외)', async () =>
    {
        const storage = new FakeStorage();
        storage.versions.add('gen/req-1/a.png@3');
        vi.spyOn(storage, 'stat').mockRejectedValue(new Error('provider unavailable'));
        const copy = vi.spyOn(storage, 'copy');

        const result = await restoreManifest(storage, manifest({}));

        expect(result.failed).toEqual([{ key: 'gen/req-1/a.png', error: 'provider unavailable' }]);
        expect(copy).not.toHaveBeenCalled();
    });

    it('fails one entry on a copy error and keeps going (5d: copy가 임의 예외)', async () =>
    {
        const storage = new FakeStorage();
        storage.versions.add('gen/req-1/b.png@7');
        vi.spyOn(storage, 'copy').mockImplementation(async (from: string) =>
        {
            if (from === 'gen/req-1/a.png')
            {
                throw new Error('denied');
            }
        });

        const result = await restoreManifest(storage, manifest({
            entries: [
                { key: 'gen/req-1/a.png', size: 1, versionId: '3' },
                { key: 'gen/req-1/b.png', size: 1, versionId: '7' },
            ],
        }));

        expect(result.failed).toEqual([{ key: 'gen/req-1/a.png', error: 'denied' }]);
        expect(result.restored).toEqual(['gen/req-1/b.png']);
    });

    it('rewrites only the prefix, not a later repeat of it (5d: onto + gen/req-1/gen/req-1.png)', async () =>
    {
        const storage = new FakeStorage();
        storage.versions.add('gen/req-1/gen/req-1.png@3');
        const copy = vi.spyOn(storage, 'copy');

        const result = await restoreManifest(
            storage,
            manifest({ entries: [{ key: 'gen/req-1/gen/req-1.png', size: 1, versionId: '3' }] }),
            { onto: 'restore/req-1' },
        );

        expect(result.restored).toEqual(['restore/req-1/gen/req-1.png']);
        expect(copy).toHaveBeenCalledWith('gen/req-1/gen/req-1.png', 'restore/req-1/gen/req-1.png', { sourceVersionId: '3' });
    });

    it('treats an onto equal to the manifest prefix as a plain restore (5d 리뷰 행: onto == prefix)', async () =>
    {
        const storage = new FakeStorage();
        storage.versions.add('gen/req-1/a.png@3');

        const result = await restoreManifest(storage, manifest({}), { onto: 'gen/req-1' });

        expect(result.restored).toEqual(['gen/req-1/a.png']);
    });

    it('never runs more copies at once than concurrency allows (5d: concurrency 2, 항목 5)', async () =>
    {
        const storage = new FakeStorage();
        const entries = ['a', 'b', 'c', 'd', 'e'].map(name => ({ key: `gen/req-1/${name}.png`, size: 1, versionId: '3' }));
        for (const entry of entries)
        {
            storage.versions.add(`${entry.key}@3`);
        }

        const result = await restoreManifest(storage, manifest({ entries }), { concurrency: 2 });

        expect(result.restored).toHaveLength(5);
        expect(storage.maxConcurrentCopies).toBe(2);
    });

    it('skips an entry whose version is already live (5d: 손대지 않은 스냅샷)', async () =>
    {
        const storage = new FakeStorage();
        storage.live.set('gen/req-1/a.png', { size: 1, versionId: '3' });
        const copy = vi.spyOn(storage, 'copy');

        const result = await restoreManifest(storage, manifest({}));

        expect(result).toEqual({
            restored: [],
            skipped: [{ key: 'gen/req-1/a.png', reason: 'already-current' }],
            failed: [],
        });
        expect(copy).not.toHaveBeenCalled();
    });

    it('compares contentHash when the entry has no versionId (5d: local 손대지 않은 스냅샷)', async () =>
    {
        const storage = new FakeStorage('local');
        storage.live.set('gen/req-1/a.png', { size: 1, contentHash: 'abc' });

        const result = await restoreManifest(storage, manifest({
            provider: 'local',
            entries: [{ key: 'gen/req-1/a.png', size: 1, contentHash: 'abc' }],
        }));

        expect(result.skipped).toEqual([{ key: 'gen/req-1/a.png', reason: 'already-current' }]);
    });
});

describe('serializeManifest and parseManifest', () =>
{
    it('round-trips the known fields (5e: 정상 왕복)', () =>
    {
        const original = manifest({
            entries: [{ key: 'gen/req-1/a.png', size: 3, etag: 'e', contentHash: 'c', versionId: '3' }],
        });

        expect(parseManifest(serializeManifest(original))).toEqual(original);
    });

    it('round-trips an empty entry list (5e 리뷰 행: entries [])', () =>
    {
        const original = manifest({ entries: [] });

        expect(parseManifest(serializeManifest(original))).toEqual(original);
    });

    it('rejects a schemaVersion it does not know (5e: schemaVersion 2)', () =>
    {
        expect(() => parseManifest(JSON.stringify({ ...manifest({}), schemaVersion: 2 })))
            .toThrow(StorageManifestInvalidError);
    });

    it('rejects an entry without a key (5e: 항목에 key 없음)', () =>
    {
        expect(() => parseManifest(JSON.stringify({ ...manifest({}), entries: [{ size: 1 }] })))
            .toThrow(StorageManifestInvalidError);
    });

    it('rejects an entry outside the prefix (5e: 항목 key가 prefix 밖)', () =>
    {
        const outside = { ...manifest({}), entries: [{ key: 'gen/req-10/a.png', size: 1, versionId: '3' }] };

        expect(() => parseManifest(JSON.stringify(outside))).toThrow(StorageManifestInvalidError);
    });

    it('rejects a provider outside the known set (5e: provider azure)', () =>
    {
        expect(() => parseManifest(JSON.stringify({ ...manifest({}), provider: 'azure' })))
            .toThrow(StorageManifestInvalidError);
    });

    it('rejects a numeric versionId instead of coercing it (5e 리뷰 행: versionId가 숫자)', () =>
    {
        const numeric = { ...manifest({}), entries: [{ key: 'gen/req-1/a.png', size: 1, versionId: 3 }] };

        expect(() => parseManifest(JSON.stringify(numeric))).toThrow(StorageManifestInvalidError);
    });

    it('accepts unknown fields but drops them (5e: 알 수 없는 추가 필드)', () =>
    {
        const extended = {
            ...manifest({}),
            futureField: 'kept by a newer writer',
            entries: [{ key: 'gen/req-1/a.png', size: 1, versionId: '3', futureEntryField: 1 }],
        };

        const parsed = parseManifest(JSON.stringify(extended));

        expect(parsed).not.toHaveProperty('futureField');
        expect(parsed.entries[0]).not.toHaveProperty('futureEntryField');
        expect(Object.keys(parsed.entries[0]).sort()).toEqual(['key', 'size', 'versionId']);
    });

    it('rejects text that is not JSON at all', () =>
    {
        expect(() => parseManifest('{')).toThrow(StorageManifestInvalidError);
    });
});

function manifest(overrides: Partial<Manifest>): Manifest
{
    return {
        schemaVersion: 1,
        createdAt: '2026-09-18T00:00:00Z',
        prefix: 'gen/req-1',
        provider: 's3',
        entries: [{ key: 'gen/req-1/a.png', size: 1, versionId: '3' }] as ManifestEntry[],
        ...overrides,
    };
}

function listed(key: string, versionId: string): StorageObject
{
    return { key, size: 1, versionId };
}
