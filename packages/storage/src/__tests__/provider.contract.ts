/**
 * provider 공용 계약 스위트 — local·S3 호환·GCS 어느 구현이든 이 케이스를 그대로 통과해야 한다.
 *
 * 이 파일 자체는 vitest가 수집하지 않는다(`*.test.ts`가 아님). `contract.*.test.ts`가
 * 하네스를 넘겨 등록한다. 케이스마다 다른 키 루트를 써서 실버킷에서 잔재가 겹치지 않게 한다.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreManifest, snapshotPrefix } from '../server/snapshot-restore';
import { StorageKeyError, StorageObjectNotFoundError, StorageVersionNotFoundError } from '../shared/index';
import type { Readable } from 'node:stream';
import type { IStorageProvider, Manifest } from '../shared/index';

export interface StorageContractHarness
{
    /** 케이스마다 호출된다. 같은 백엔드를 공유해도 되고 매번 새로 만들어도 된다. */
    createProvider(): IStorageProvider | Promise<IStorageProvider>;
    /** 이 실행이 쓸 키 루트. 실버킷에서는 실행마다 다른 값을 줘야 잔재와 겹치지 않는다. */
    root: string;
    /** 등록하는 구현체의 정체 — provider별 행을 수집 시점에 가른다. */
    providerKind: 'gcs' | 's3' | 'local';
    /** 버킷에 객체 버전 관리가 켜져 있다고 선언했는가. 버전 행이 이 값으로 갈린다. */
    versioning: boolean;
}

interface CaseContext
{
    storage: IStorageProvider;
    root: string;
}

/** 어느 백엔드에도 존재할 수 없는 버전 id. */
const MISSING_VERSION_ID = '9999999999999999';

/** 어느 provider에도 닿기 전에 거부돼야 하는 키 — traversal·절대경로·URL·제어문자. */
const INVALID_KEYS = [
    '',
    '../secret.txt',
    'gen/../../etc/passwd',
    '/absolute.txt',
    'gen//double.txt',
    'gen/./same.txt',
    'gen/trailing/',
    'gen\\windows.txt',
    'https://cdn.example.com/card.webp',
    '//cdn.example.com/card.webp',
    `gen/nul${String.fromCharCode(0)}.txt`,
    `gen/newline${String.fromCharCode(10)}.txt`,
];

/**
 * 실버킷 provider 등록. 필수 env가 전부 있으면 계약을 돌리고, 하나도 없으면 비활성으로 둔다.
 * 일부만 설정된 상태는 조용히 건너뛰지 않고 실패한다 — env 이름 오타 하나로 실버킷 검증이
 * 통째로 사라지는 것을 막는다. 로컬 계약은 gate가 없어 언제나 돈다.
 */
export function registerOptInStorageProviderContract(
    name: string,
    requiredEnv: string[],
    versioningEnv: string,
    createHarness: () => StorageContractHarness,
): void
{
    const present = requiredEnv.filter(key => (process.env[key] ?? '').length > 0);
    if (present.length === requiredEnv.length)
    {
        registerStorageProviderContract(name, createHarness());

        return;
    }

    describe(`${name} provider contract (opt-in, not configured)`, () =>
    {
        it('is either fully configured or fully unset', () =>
        {
            expect(present, `partial config — set all of ${requiredEnv.join(', ')} to run this contract`).toEqual([]);
            expect(
                isVersioningDeclared(versioningEnv),
                `${versioningEnv}=1 without ${requiredEnv.join(', ')} — the version rows would silently disappear`,
            ).toBe(false);
        });
    });
}

/** `*_VERSIONED=1`을 선언했는가. 선언만으로는 버킷이 실제로 버전을 돌려준다는 보장이 없다. */
export function isVersioningDeclared(versioningEnv: string): boolean
{
    return process.env[versioningEnv] === '1';
}

export function registerStorageProviderContract(name: string, harness: StorageContractHarness): void
{
    describe(`${name} provider contract`, () =>
    {
        let storage: IStorageProvider;
        let root: string;

        beforeEach(async (context: { task: { name: string } }) =>
        {
            storage = await harness.createProvider();
            root = `${harness.root}/${slug(context.task.name)}`;
        });

        it('round-trips bytes through upload and download', async () =>
        {
            await storage.upload(`${root}/a.txt`, 'candidate-bytes', 'text/plain');

            expect((await storage.download(`${root}/a.txt`)).toString()).toBe('candidate-bytes');
        });

        it('round-trips bytes through upload and getStream', async () =>
        {
            await storage.upload(`${root}/a.txt`, 'streamed-bytes', 'text/plain');

            expect((await readAll(await storage.getStream(`${root}/a.txt`))).toString()).toBe('streamed-bytes');
        });

        it('streams an empty object without hanging', async () =>
        {
            await storage.upload(`${root}/empty.txt`, '', 'text/plain');

            expect((await readAll(await storage.getStream(`${root}/empty.txt`))).length).toBe(0);
        });

        it('rejects a missing key on download and getStream with the same contract error', async () =>
        {
            await expect(storage.download(`${root}/missing.txt`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
            await expect(storage.getStream(`${root}/missing.txt`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
        });

        it('copies to a new key and preserves the source', async () =>
        {
            await storage.upload(`${root}/candidate.txt`, 'picked', 'text/plain');

            await storage.copy(`${root}/candidate.txt`, `${root}/confirmed/asset.txt`);

            expect((await storage.download(`${root}/confirmed/asset.txt`)).toString()).toBe('picked');
            expect((await storage.download(`${root}/candidate.txt`)).toString()).toBe('picked');
        });

        it('copies a key holding reserved URL characters', async () =>
        {
            const source = `${root}/req 1/a+b?c#d.png`;
            await storage.upload(source, 'reserved', 'image/png');

            await storage.copy(source, `${root}/confirmed/a+b?c#d.png`);

            expect((await storage.download(`${root}/confirmed/a+b?c#d.png`)).toString()).toBe('reserved');
            expect((await storage.download(source)).toString()).toBe('reserved');
        });

        it('overwrites an existing destination on copy', async () =>
        {
            await storage.upload(`${root}/source.txt`, 'new', 'text/plain');
            await storage.upload(`${root}/target.txt`, 'old', 'text/plain');

            await storage.copy(`${root}/source.txt`, `${root}/target.txt`);

            expect((await storage.download(`${root}/target.txt`)).toString()).toBe('new');
        });

        it('rejects a missing copy source and leaves the destination absent', async () =>
        {
            await expect(storage.copy(`${root}/missing.txt`, `${root}/target.txt`))
                .rejects.toBeInstanceOf(StorageObjectNotFoundError);
            await expect(storage.download(`${root}/target.txt`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
        });

        it('lists only objects under the prefix path boundary', async () =>
        {
            await storage.upload(`${root}/req-1/a.txt`, 'a', 'text/plain');
            await storage.upload(`${root}/req-1/nested/b.txt`, 'b', 'text/plain');
            await storage.upload(`${root}/req-10/c.txt`, 'c', 'text/plain');

            const listed = await storage.list(`${root}/req-1`);

            expect(listed.objects.map(object => object.key).sort()).toEqual([
                `${root}/req-1/a.txt`,
                `${root}/req-1/nested/b.txt`,
            ]);
            expect(listed.cursor).toBeUndefined();
        });

        it('reports a size for each listed object', async () =>
        {
            await storage.upload(`${root}/sized/a.txt`, 'twelve bytes', 'text/plain');

            const [object] = (await storage.list(`${root}/sized`)).objects;

            expect(object.size).toBe(12);
        });

        it('returns an empty page for a prefix with no objects', async () =>
        {
            const listed = await storage.list(`${root}/nothing-here`);

            expect(listed).toEqual({ objects: [] });
        });

        it('paginates with maxKeys and a cursor, covering every key exactly once', async () =>
        {
            const expected = ['0', '1', '2', '3', '4'].map(index => `${root}/page/${index}.txt`);
            for (const key of expected)
            {
                await storage.upload(key, key, 'text/plain');
            }

            const seen: string[] = [];
            let cursor: string | undefined;
            let pages = 0;
            do
            {
                const listed = await storage.list(`${root}/page`, { maxKeys: 2, ...(cursor ? { cursor } : {}) });
                seen.push(...listed.objects.map(object => object.key));
                cursor = listed.cursor;
                pages += 1;
                expect(pages).toBeLessThanOrEqual(expected.length + 1);
            }
            while (cursor);

            expect(seen.sort()).toEqual(expected);
        });

        it('deletes every object under a prefix and leaves a sibling prefix intact', async () =>
        {
            await storage.upload(`${root}/req-1/a.txt`, 'a', 'text/plain');
            await storage.upload(`${root}/req-1/nested/b.txt`, 'b', 'text/plain');
            await storage.upload(`${root}/req-10/c.txt`, 'c', 'text/plain');

            expect(await storage.deletePrefix(`${root}/req-1`)).toEqual({ deleted: 2, failed: [] });

            await expect(storage.download(`${root}/req-1/a.txt`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
            await expect(storage.download(`${root}/req-1/nested/b.txt`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
            expect((await storage.download(`${root}/req-10/c.txt`)).toString()).toBe('c');
        });

        it('succeeds with no deletions on a prefix that holds nothing', async () =>
        {
            expect(await storage.deletePrefix(`${root}/never-used`)).toEqual({ deleted: 0, failed: [] });
        });

        it('deletes exactly one key and leaves its siblings', async () =>
        {
            await storage.upload(`${root}/pair/a.txt`, 'a', 'text/plain');
            await storage.upload(`${root}/pair/b.txt`, 'b', 'text/plain');

            await storage.delete(`${root}/pair/a.txt`);

            await expect(storage.download(`${root}/pair/a.txt`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
            expect((await storage.download(`${root}/pair/b.txt`)).toString()).toBe('b');
        });

        it('treats deleting a missing key as success', async () =>
        {
            await expect(storage.delete(`${root}/never-existed.txt`)).resolves.toBeUndefined();
        });

        it('rejects invalid keys on every object operation before reaching the provider', async () =>
        {
            for (const key of INVALID_KEYS)
            {
                await expect(storage.upload(key, 'x', 'text/plain'), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.download(key), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.getStream(key), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.delete(key), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.stat(key), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.copy(key, `${root}/target.txt`), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.copy(`${root}/source.txt`, key), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.list(key), key).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.deletePrefix(key), key).rejects.toBeInstanceOf(StorageKeyError);
            }
        });

        it('never lets an empty or root prefix mean the whole bucket', async () =>
        {
            await storage.upload(`${root}/survivor.txt`, 'keep', 'text/plain');

            for (const prefix of ['', '/', '//', '.', '..'])
            {
                await expect(storage.deletePrefix(prefix), prefix).rejects.toBeInstanceOf(StorageKeyError);
                await expect(storage.list(prefix), prefix).rejects.toBeInstanceOf(StorageKeyError);
            }

            expect((await storage.download(`${root}/survivor.txt`)).toString()).toBe('keep');
        });

        it('rejects a non-positive maxKeys instead of listing everything', async () =>
        {
            await expect(storage.list(`${root}/page`, { maxKeys: 0 })).rejects.toBeInstanceOf(StorageKeyError);
            await expect(storage.list(`${root}/page`, { maxKeys: 1.5 })).rejects.toBeInstanceOf(StorageKeyError);
        });

        it('lets a caller destroy a stream it never consumes', async () =>
        {
            await storage.upload(`${root}/big.txt`, 'x'.repeat(256 * 1024), 'text/plain');
            const stream = await storage.getStream(`${root}/big.txt`);

            stream.destroy();

            await expect(closed(stream)).resolves.toBe('closed');
        });
    });
    registerStatAndSnapshotContract(name, harness);
    registerObjectVersionContract(name, harness);
}

/** 버전 관리 여부와 무관하게 언제나 도는 행 — stat·snapshot·restore의 성능 저하 경로를 포함한다. */
function registerStatAndSnapshotContract(name: string, harness: StorageContractHarness): void
{
    describe(`${name} provider contract — stat and snapshots`, () =>
    {
        const context = caseContext(harness);

        it('reports size and lastModified for an existing object (5a: 존재하는 객체)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'twelve bytes', 'text/plain');

            const stat = await storage.stat(`${root}/a.txt`);

            expect(stat.key).toBe(`${root}/a.txt`);
            expect(stat.size).toBe(12);
            expect(stat.lastModified).toBeInstanceOf(Date);
            if (harness.providerKind === 'local')
            {
                expect(stat.contentHash).toBe(sha256Hex('twelve bytes'));
                expect(stat.versionId).toBeUndefined();
            }
        });

        it('reports a string versionId or none, matching list (5a: 버전 꺼진 버킷·interop 행, versionId 타입 행)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'a', 'text/plain');

            const stat = await storage.stat(`${root}/a.txt`);
            const [listed] = (await storage.list(root)).objects;

            expect(['string', 'undefined']).toContain(typeof stat.versionId);
            if (listed.versionId !== undefined)
            {
                expect(listed.versionId).toBe(stat.versionId);
            }
        });

        it('rejects a missing object on stat (5a: 없는 객체)', async () =>
        {
            await expect(context.storage.stat(`${context.root}/missing.txt`))
                .rejects.toBeInstanceOf(StorageObjectNotFoundError);
        });

        it('reflects an overwrite (5a: 덮어쓴 뒤 — local은 contentHash가 다르다)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'one', 'text/plain');
            const before = await storage.stat(`${root}/a.txt`);

            await storage.upload(`${root}/a.txt`, 'two bytes longer', 'text/plain');
            const after = await storage.stat(`${root}/a.txt`);

            expect(after.size).not.toBe(before.size);
            if (before.contentHash !== undefined)
            {
                expect(after.contentHash).not.toBe(before.contentHash);
            }
        });

        it('rejects a copy from a versionId that does not exist (5b: 존재하지 않는 versionId)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'a', 'text/plain');

            await expect(storage.copy(`${root}/a.txt`, `${root}/target.txt`, { sourceVersionId: MISSING_VERSION_ID }))
                .rejects.toBeInstanceOf(StorageVersionNotFoundError);
            await expect(storage.download(`${root}/target.txt`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
        });

        it('rejects a copy from a missing source key with a versionId (5b: 원본 key 없음 + versionId)', async () =>
        {
            const { storage, root } = context;

            await expect(storage.copy(`${root}/missing.txt`, `${root}/target.txt`, { sourceVersionId: MISSING_VERSION_ID }))
                .rejects.toBeInstanceOf(StorageVersionNotFoundError);
        });

        it('snapshots every object under the prefix across pages (5c: 객체 3개, maxKeys: 2)', async () =>
        {
            const { storage, root } = context;
            for (const name_ of ['a', 'b', 'c'])
            {
                await storage.upload(`${root}/snap/${name_}.txt`, name_, 'text/plain');
            }

            const manifest = await snapshotPrefix(storage, `${root}/snap`, { maxKeys: 2 });

            expect(manifest.entries.map(entry => entry.key).sort()).toEqual([
                `${root}/snap/a.txt`,
                `${root}/snap/b.txt`,
                `${root}/snap/c.txt`,
            ]);
            expect(manifest.prefix).toBe(`${root}/snap`);
            expect(manifest.provider).toBe(harness.providerKind);
            expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        });

        it('snapshots a prefix with no objects as an empty entry list (5c: 빈 prefix)', async () =>
        {
            const manifest = await snapshotPrefix(context.storage, `${context.root}/nothing-here`);

            expect(manifest.entries).toEqual([]);
        });

        it('snapshots on the path boundary (5c: gen/req-1 경로 경계)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/req-1/a.txt`, 'a', 'text/plain');
            await storage.upload(`${root}/req-10/c.txt`, 'c', 'text/plain');

            const manifest = await snapshotPrefix(storage, `${root}/req-1`);

            expect(manifest.entries.map(entry => entry.key)).toEqual([`${root}/req-1/a.txt`]);
        });

        it('validates the prefix before listing (5c: 잘못된 prefix)', async () =>
        {
            await expect(snapshotPrefix(context.storage, '')).rejects.toBeInstanceOf(StorageKeyError);
        });

        it('records a versionId exactly when stat exposes one (5c: 버전 꺼진 버킷·interop·local 행)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a', 'text/plain');

            const [entry] = (await snapshotPrefix(storage, `${root}/snap`)).entries;

            expect(entry.versionId).toBe((await storage.stat(`${root}/snap/a.txt`)).versionId);
        });

        it('restores an untouched snapshot without copying anything (5d: 손대지 않은 스냅샷)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a', 'text/plain');
            await storage.upload(`${root}/snap/b.txt`, 'b', 'text/plain');
            const manifest = await snapshotPrefix(storage, `${root}/snap`);
            const copy = vi.spyOn(storage, 'copy');

            const result = await restoreManifest(storage, manifest);

            expect(result.restored).toEqual([]);
            expect(result.skipped.map(entry => entry.reason)).toEqual(['already-current', 'already-current']);
            expect(copy).not.toHaveBeenCalled();
        });

        it('reports no-version for an entry that carries no version (5d: 항목에 versionId가 없음)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a', 'text/plain');
            const manifest = withoutVersionIds(await snapshotPrefix(storage, `${root}/snap`));
            await storage.delete(`${root}/snap/a.txt`);
            const copy = vi.spyOn(storage, 'copy');

            const result = await restoreManifest(storage, manifest);

            expect(result.skipped).toEqual([{ key: `${root}/snap/a.txt`, reason: 'no-version' }]);
            expect(copy).not.toHaveBeenCalled();
        });

        it('never reports a deleted object as failed (5d: 스냅샷 → 객체 삭제 → restore)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a', 'text/plain');
            const manifest = await snapshotPrefix(storage, `${root}/snap`);
            await storage.delete(`${root}/snap/a.txt`);

            const result = await restoreManifest(storage, manifest);

            expect(result.failed).toEqual([]);
            expect([...result.restored, ...result.skipped.map(entry => entry.key)]).toEqual([`${root}/snap/a.txt`]);
        });

        it('restores onto another prefix and leaves the source prefix untouched (5d: onto)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a', 'text/plain');
            const manifest = await snapshotPrefix(storage, `${root}/snap`);

            const result = await restoreManifest(storage, manifest, { onto: `${root}/restored` });

            expect([...result.restored, ...result.skipped.map(entry => entry.key)])
                .toEqual([`${root}/restored/a.txt`]);
            expect((await storage.download(`${root}/snap/a.txt`)).toString()).toBe('a');
        });
    });

    describe.skipIf(harness.providerKind !== 'gcs')(`${name} provider contract — snapshot without a top-up`, () =>
    {
        const context = caseContext(harness);

        it('takes no stat call when list already carries versionId (5c: gcs — stat spy 0회)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a', 'text/plain');
            await storage.upload(`${root}/snap/b.txt`, 'b', 'text/plain');
            const stat = vi.spyOn(storage, 'stat');

            await snapshotPrefix(storage, `${root}/snap`);

            expect(stat).not.toHaveBeenCalled();
        });
    });

    describe.skipIf(harness.providerKind === 'gcs')(`${name} provider contract — snapshot top-up`, () =>
    {
        const context = caseContext(harness);

        it('tops up with one stat per object when list omits versionId (5c: s3 — 객체당 HeadObject 1회)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a', 'text/plain');
            await storage.upload(`${root}/snap/b.txt`, 'b', 'text/plain');
            const stat = vi.spyOn(storage, 'stat');

            await snapshotPrefix(storage, `${root}/snap`);

            expect(stat).toHaveBeenCalledTimes(2);
        });
    });

    describe.skipIf(harness.providerKind !== 'local')(`${name} provider contract — content-hash copy`, () =>
    {
        const context = caseContext(harness);

        it('copies when sourceVersionId equals the current contentHash (5b: local + id == 현재 contentHash)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'hashed', 'text/plain');

            await storage.copy(`${root}/a.txt`, `${root}/copied.txt`, { sourceVersionId: sha256Hex('hashed') });

            expect((await storage.download(`${root}/copied.txt`)).toString()).toBe('hashed');
        });
    });
}

/**
 * 버전 관리가 켜졌다고 선언한 버킷에서만 도는 행(`*_VERSIONED=1`). 선언만 하고 실제로는
 * 버전 id가 없는 버킷은 첫 행에서 시끄럽게 실패한다 — 조용히 건너뛰지 않는다.
 */
function registerObjectVersionContract(name: string, harness: StorageContractHarness): void
{
    describe.skipIf(!harness.versioning)(`${name} provider contract — object versions`, () =>
    {
        const context = caseContext(harness);

        it('exposes a version id, as the contract declares (guard: *_VERSIONED=1)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'a', 'text/plain');

            const stat = await storage.stat(`${root}/a.txt`);

            expect(
                typeof stat.versionId,
                'this contract was configured with _VERSIONED=1 but the bucket returns no version id',
            ).toBe('string');
        });

        it('reports a new versionId after an overwrite (5a: 덮어쓴 뒤)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'v1', 'text/plain');
            const first = await storage.stat(`${root}/a.txt`);

            await storage.upload(`${root}/a.txt`, 'v2', 'text/plain');

            expect((await storage.stat(`${root}/a.txt`)).versionId).not.toBe(first.versionId);
        });

        it('copies the bytes of an earlier version and mints a new one (5b: 이전 versionId 지정)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/a.txt`, 'v1', 'text/plain');
            const first = await storage.stat(`${root}/a.txt`);
            await storage.upload(`${root}/a.txt`, 'v2', 'text/plain');

            await storage.copy(`${root}/a.txt`, `${root}/restored.txt`, { sourceVersionId: first.versionId as string });

            expect((await storage.download(`${root}/restored.txt`)).toString()).toBe('v1');
            expect((await storage.stat(`${root}/restored.txt`)).versionId).not.toBe(first.versionId);
        });

        it('copies a reserved-character key from an earlier version (5b: req 1/a+b?c#d.png + versionId)', async () =>
        {
            const { storage, root } = context;
            const source = `${root}/req 1/a+b?c#d.png`;
            await storage.upload(source, 'v1', 'image/png');
            const first = await storage.stat(source);
            await storage.upload(source, 'v2', 'image/png');

            await storage.copy(source, `${root}/confirmed/a+b?c#d.png`, { sourceVersionId: first.versionId as string });

            expect((await storage.download(`${root}/confirmed/a+b?c#d.png`)).toString()).toBe('v1');
        });

        it('restores only the object that changed (5d: 스냅샷 → 1개 덮어쓰기 → restore)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a1', 'text/plain');
            await storage.upload(`${root}/snap/b.txt`, 'b1', 'text/plain');
            const manifest = await snapshotPrefix(storage, `${root}/snap`);
            await storage.upload(`${root}/snap/a.txt`, 'a2', 'text/plain');
            const download = vi.spyOn(storage, 'download');

            const result = await restoreManifest(storage, manifest);

            expect(result).toEqual({
                restored: [`${root}/snap/a.txt`],
                skipped: [{ key: `${root}/snap/b.txt`, reason: 'already-current' }],
                failed: [],
            });
            expect(download).not.toHaveBeenCalled();
            expect((await storage.download(`${root}/snap/a.txt`)).toString()).toBe('a1');
        });

        it('restores the manifest version, not an intermediate one (5d: 두 번 덮어쓰기)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'v1', 'text/plain');
            const manifest = await snapshotPrefix(storage, `${root}/snap`);
            await storage.upload(`${root}/snap/a.txt`, 'v2', 'text/plain');
            await storage.upload(`${root}/snap/a.txt`, 'v3', 'text/plain');

            await restoreManifest(storage, manifest);

            expect((await storage.download(`${root}/snap/a.txt`)).toString()).toBe('v1');
        });

        it('restores a deleted object from its recorded version (5d: 객체 삭제 → restore)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'a1', 'text/plain');
            const manifest = await snapshotPrefix(storage, `${root}/snap`);
            await storage.delete(`${root}/snap/a.txt`);

            const result = await restoreManifest(storage, manifest);

            expect(result.restored).toEqual([`${root}/snap/a.txt`]);
            expect((await storage.download(`${root}/snap/a.txt`)).toString()).toBe('a1');
        });

        it('mints a new versionId on restore (5d: restore 뒤 stat)', async () =>
        {
            const { storage, root } = context;
            await storage.upload(`${root}/snap/a.txt`, 'v1', 'text/plain');
            const manifest = await snapshotPrefix(storage, `${root}/snap`);
            await storage.upload(`${root}/snap/a.txt`, 'v2', 'text/plain');

            await restoreManifest(storage, manifest);

            expect((await storage.stat(`${root}/snap/a.txt`)).versionId).not.toBe(manifest.entries[0].versionId);
        });
    });
}

/** 케이스마다 새 provider와 케이스 전용 키 루트를 준다 — 실버킷에서 잔재가 겹치지 않게. */
function caseContext(harness: StorageContractHarness): CaseContext
{
    const context = { storage: undefined as unknown as IStorageProvider, root: '' };

    beforeEach(async (task: { task: { name: string } }) =>
    {
        context.storage = await harness.createProvider();
        context.root = `${harness.root}/${slug(task.task.name)}`;
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    return context;
}

/** 버전 관리가 꺼진 백엔드에서 찍힌 매니페스트의 모양 — 어느 provider에서도 만들어 볼 수 있다. */
function withoutVersionIds(manifest: Manifest): Manifest
{
    return {
        ...manifest,
        entries: manifest.entries.map(({ versionId: _versionId, ...entry }) => entry),
    };
}

function sha256Hex(body: string): string
{
    return createHash('sha256').update(body).digest('hex');
}

async function readAll(stream: Readable): Promise<Buffer>
{
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
    {
        chunks.push(Buffer.from(chunk as Buffer));
    }

    return Buffer.concat(chunks);
}

function closed(stream: Readable): Promise<string>
{
    return new Promise((resolve, reject) =>
    {
        stream.once('close', () => resolve('closed'));
        stream.once('error', reject);
    });
}

function slug(testName: string): string
{
    return testName.toLowerCase().replace(/[^a-z\d]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
