/**
 * prefix 스냅샷과 매니페스트 기반 복원 — provider 위에서 도는 함수들.
 *
 * `list`·`stat`·`copy`·`providerKind`만 쓴다. provider 모듈을 import하지 않는다:
 * `gcs.provider.ts`가 optional dependency인 `@google-cloud/storage`를 정적으로 import하므로
 * 여기서 provider를 끌어오면 S3만 설치한 앱이 import 시점에 깨진다.
 *
 * 어느 API도 noncurrent 버전을 열거하지 않는다. 스냅샷은 그 순간의 live 버전을 적어 두고,
 * 복원은 적어 둔 버전을 원본으로 같은 key에 다시 쓴다(= 새 버전이 생긴다).
 */

import {
    StorageManifestInvalidError,
    StorageObjectNotFoundError,
    StorageVersionNotFoundError,
} from '../shared/index';
import { errorMessage } from './delete-many';
import { isPublicKey } from './keys';
import { assertKeyPrefix, assertObjectKey, assertPositiveInteger } from './object-key';
import type {
    IStorageProvider,
    Manifest,
    ManifestEntry,
    RestoreResult,
    StorageObject,
    StorageObjectStat,
} from '../shared/index';

const DEFAULT_CONCURRENCY = 8;

export interface SnapshotOptions
{
    /** 동시에 진행할 `stat` 보충 호출 수(양의 정수, 기본 8). */
    concurrency?: number;
    /** `list`에 그대로 넘기는 페이지 크기(양의 정수). */
    maxKeys?: number;
}

export interface RestoreOptions
{
    /** 원래 자리 대신 이 prefix 아래로 복원한다. public/private 경계는 넘지 못한다. */
    onto?: string;
    /** 동시에 진행할 항목 수(양의 정수, 기본 8). */
    concurrency?: number;
}

/**
 * `<prefix>/` 아래 live 객체 전부를 매니페스트로 적는다. `versionId`를 list가 실어 주지 않는
 * provider에서는 객체당 `stat`을 한 번 더 부른다(GCS는 list만으로 끝난다).
 *
 * 원자적이지 않다 — 순회 중 생성된 객체는 빠질 수 있고, 덮어쓰인 객체는 그 페이지가 본 버전으로
 * 기록된다. 리스팅은 한 페이지씩 돌지만 `entries`는 전부 메모리에 쌓이므로 매니페스트 크기는
 * 객체 수에 비례한다 — 아주 큰 prefix는 하위 prefix로 나눠 여러 번 찍는다.
 */
export async function snapshotPrefix(
    storage: IStorageProvider,
    prefix: string,
    options: SnapshotOptions = {},
): Promise<Manifest>
{
    assertKeyPrefix(prefix);
    const concurrency = resolveConcurrency(options.concurrency);
    const pageSize = options.maxKeys === undefined ? {} : { maxKeys: options.maxKeys };
    const entries: ManifestEntry[] = [];
    let cursor: string | undefined;

    do
    {
        const page = await storage.list(prefix, { ...pageSize, ...(cursor ? { cursor } : {}) });
        entries.push(...await entriesForPage(storage, page.objects, concurrency));
        cursor = page.cursor;
    }
    while (cursor);

    return {
        schemaVersion: 1,
        createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        prefix,
        provider: storage.providerKind,
        entries,
    };
}

/**
 * 매니페스트가 적어 둔 버전으로 되돌린다. copy 한 번 전에 사전 검사를 모두 끝내고(provider
 * 일치·`onto` 검증·대상 key 검증), 그 뒤로는 항목별 결과를 모아 돌려준다 — 첫 실패에서 멈추지
 * 않는다. 원자적이지 않다.
 */
export async function restoreManifest(
    storage: IStorageProvider,
    manifest: Manifest,
    options: RestoreOptions = {},
): Promise<RestoreResult>
{
    const concurrency = resolveConcurrency(options.concurrency);
    const targets = planRestore(storage, manifest, options.onto);
    const result: RestoreResult = { restored: [], skipped: [], failed: [] };
    await inBatches(targets, concurrency, target => restoreEntry(storage, target, result));

    return result;
}

/** 매니페스트를 JSON으로. 알려진 필드만 나간다. */
export function serializeManifest(manifest: Manifest): string
{
    return JSON.stringify(knownManifestFields(manifest));
}

/**
 * JSON을 매니페스트로. 형태가 어긋나면 `StorageManifestInvalidError`.
 * 알려진 필드만 남긴다 — 왕복은 알려진 필드에 대해서만 같다(전방 호환은 "받아들인다"이지
 * "보존한다"가 아니다).
 */
export function parseManifest(json: string): Manifest
{
    const decoded = decodeJson(json);
    if (decoded.error !== undefined)
    {
        throw new StorageManifestInvalidError(`Invalid manifest: ${decoded.error}`);
    }
    const source = asRecord(decoded.value, 'manifest');
    if (source.schemaVersion !== 1)
    {
        throw new StorageManifestInvalidError(`Invalid manifest: schemaVersion must be 1, got ${String(source.schemaVersion)}`);
    }
    const prefix = readPrefix(source.prefix);

    return {
        schemaVersion: 1,
        createdAt: readString(source.createdAt, 'createdAt'),
        prefix,
        provider: readProvider(source.provider),
        entries: readEntries(source.entries, prefix),
    };
}

interface RestoreTarget
{
    entry: ManifestEntry;
    targetKey: string;
}

/** 사전 검사 — 여기서 던지면 copy는 한 번도 일어나지 않는다. */
function planRestore(storage: IStorageProvider, manifest: Manifest, onto?: string): RestoreTarget[]
{
    if (manifest.provider !== storage.providerKind)
    {
        throw new StorageManifestInvalidError(
            `Invalid manifest: recorded on ${manifest.provider}, restoring with the ${storage.providerKind} provider`,
        );
    }
    if (onto !== undefined)
    {
        assertKeyPrefix(onto);
        assertSameVisibility(onto, manifest.prefix);
    }

    return manifest.entries.map((entry) =>
    {
        const targetKey = resolveTargetKey(entry.key, manifest.prefix, onto);
        assertObjectKey(targetKey);

        return { entry, targetKey };
    });
}

/** `public/` 경계를 넘는 복원은 GCS에서 버킷을 갈아타 비공개 바이트를 공개해 버린다. */
function assertSameVisibility(onto: string, prefix: string): void
{
    if (isPublicKey(onto) !== isPublicKey(prefix))
    {
        throw new StorageManifestInvalidError(
            `Invalid manifest restore: ${onto} crosses the public/private boundary of ${prefix}`,
        );
    }
}

/** prefix 부분만 잘라 붙인다 — `replace`는 key 안쪽에 또 나오는 prefix를 건드린다. */
function resolveTargetKey(key: string, prefix: string, onto?: string): string
{
    if (onto === undefined)
    {
        return key;
    }
    if (!key.startsWith(`${prefix}/`))
    {
        throw new StorageManifestInvalidError(`Invalid manifest: entry ${key} is not under ${prefix}/`);
    }

    return onto + key.slice(prefix.length);
}

async function restoreEntry(storage: IStorageProvider, target: RestoreTarget, result: RestoreResult): Promise<void>
{
    const current = await currentStat(storage, target.targetKey);
    if (current.error !== undefined)
    {
        result.failed.push({ key: target.targetKey, error: current.error });

        return;
    }
    if (current.stat && isAlreadyCurrent(target.entry, current.stat))
    {
        result.skipped.push({ key: target.targetKey, reason: 'already-current' });

        return;
    }
    if (target.entry.versionId === undefined)
    {
        result.skipped.push({ key: target.targetKey, reason: 'no-version' });

        return;
    }
    await copyRecordedVersion(storage, target, target.entry.versionId, result);
}

/**
 * 대상의 현재 상태. 객체가 없는 것은 실패가 아니다 — 삭제된 key야말로 복원 대상이다.
 * 그 외 `stat` 오류만 항목 실패로 보고하고 copy는 시도하지 않는다.
 */
async function currentStat(
    storage: IStorageProvider,
    key: string,
): Promise<{ stat: StorageObjectStat | null; error?: string }>
{
    return storage.stat(key).then(
        stat => ({ stat }),
        (error: unknown) => (error instanceof StorageObjectNotFoundError
            ? { stat: null }
            : { stat: null, error: errorMessage(error) }),
    );
}

/** 이미 매니페스트의 버전이 live면 copy를 건너뛴다 — 안 그러면 복원할 때마다 새 버전이 생긴다. */
function isAlreadyCurrent(entry: ManifestEntry, current: StorageObjectStat): boolean
{
    if (entry.versionId !== undefined)
    {
        return entry.versionId === current.versionId;
    }

    return entry.contentHash !== undefined && entry.contentHash === current.contentHash;
}

async function copyRecordedVersion(
    storage: IStorageProvider,
    target: RestoreTarget,
    versionId: string,
    result: RestoreResult,
): Promise<void>
{
    await storage.copy(target.entry.key, target.targetKey, { sourceVersionId: versionId }).then(
        () => void result.restored.push(target.targetKey),
        (error: unknown) =>
        {
            if (error instanceof StorageVersionNotFoundError)
            {
                result.skipped.push({ key: target.targetKey, reason: 'version-missing' });

                return;
            }
            result.failed.push({ key: target.targetKey, error: errorMessage(error) });
        },
    );
}

/** list가 버전을 실어 주지 않는 provider에서만 객체당 `stat`을 한 번 더 부른다. */
async function entriesForPage(
    storage: IStorageProvider,
    objects: StorageObject[],
    concurrency: number,
): Promise<ManifestEntry[]>
{
    const entries = await inBatches(objects, concurrency, async (object) =>
    {
        if (object.versionId !== undefined)
        {
            return toEntry(object.key, object);
        }

        // 순회 중 지워진 객체는 매니페스트에서 빠진다 — 스냅샷은 원자적이지 않다.
        return storage.stat(object.key).then(
            stat => toEntry(object.key, stat),
            (error: unknown) =>
            {
                if (error instanceof StorageObjectNotFoundError)
                {
                    return null;
                }

                throw error;
            },
        );
    });

    return entries.filter((entry): entry is ManifestEntry => entry !== null);
}

function toEntry(key: string, source: StorageObject | StorageObjectStat): ManifestEntry
{
    return {
        key,
        size: source.size,
        ...(source.etag ? { etag: source.etag } : {}),
        ...(source.contentHash ? { contentHash: source.contentHash } : {}),
        ...(source.versionId ? { versionId: source.versionId } : {}),
    };
}

/** 한 번에 `size`개까지만 동시에 돌린다 — `prefix-delete`의 페이지 드라이버와 같은 방식. */
async function inBatches<Item, Result>(
    items: Item[],
    size: number,
    run: (item: Item) => Promise<Result>,
): Promise<Result[]>
{
    const results: Result[] = [];
    for (let offset = 0; offset < items.length; offset += size)
    {
        results.push(...await Promise.all(items.slice(offset, offset + size).map(run)));
    }

    return results;
}

function resolveConcurrency(concurrency?: number): number
{
    if (concurrency === undefined)
    {
        return DEFAULT_CONCURRENCY;
    }
    assertPositiveInteger('concurrency', concurrency);

    return concurrency;
}

function knownManifestFields(manifest: Manifest): Manifest
{
    return {
        schemaVersion: 1,
        createdAt: manifest.createdAt,
        prefix: manifest.prefix,
        provider: manifest.provider,
        entries: manifest.entries.map(entry => toEntry(entry.key, entry)),
    };
}

function decodeJson(json: string): { value?: unknown; error?: string }
{
    try
    {
        return { value: JSON.parse(json) as unknown };
    }
    catch (error)
    {
        return { error: errorMessage(error) };
    }
}

function asRecord(value: unknown, label: string): Record<string, unknown>
{
    if (typeof value !== 'object' || value === null || Array.isArray(value))
    {
        throw new StorageManifestInvalidError(`Invalid manifest: ${label} must be an object`);
    }

    return value as Record<string, unknown>;
}

function readPrefix(value: unknown): string
{
    const prefix = readString(value, 'prefix');
    const failure = assertionFailure(() => assertKeyPrefix(prefix));
    if (failure)
    {
        throw new StorageManifestInvalidError(`Invalid manifest: ${failure}`);
    }

    return prefix;
}

function readProvider(value: unknown): Manifest['provider']
{
    if (value !== 'gcs' && value !== 's3' && value !== 'local')
    {
        throw new StorageManifestInvalidError(`Invalid manifest: unknown provider ${JSON.stringify(value)}`);
    }

    return value;
}

function readEntries(value: unknown, prefix: string): ManifestEntry[]
{
    if (!Array.isArray(value))
    {
        throw new StorageManifestInvalidError('Invalid manifest: entries must be an array');
    }

    return value.map((item) =>
    {
        const entry = asRecord(item, 'entry');
        const key = readString(entry.key, 'entry key');
        if (!key.startsWith(`${prefix}/`))
        {
            throw new StorageManifestInvalidError(`Invalid manifest: entry ${key} is not under ${prefix}/`);
        }

        return readEntry(key, entry);
    });
}

/** 알려진 필드만 남긴다 — 모르는 필드는 통과시키되 결과에는 싣지 않는다. */
function readEntry(key: string, entry: Record<string, unknown>): ManifestEntry
{
    if (typeof entry.size !== 'number' || !Number.isFinite(entry.size))
    {
        throw new StorageManifestInvalidError(`Invalid manifest: entry ${key} has no numeric size`);
    }

    return {
        key,
        size: entry.size,
        ...(entry.etag === undefined ? {} : { etag: readString(entry.etag, 'entry etag') }),
        ...(entry.contentHash === undefined ? {} : { contentHash: readString(entry.contentHash, 'entry contentHash') }),
        ...(entry.versionId === undefined ? {} : { versionId: readString(entry.versionId, 'entry versionId') }),
    };
}

/** `versionId`처럼 문자열이어야 하는 값은 숫자를 받아 주지 않는다 — 비교가 조용히 빗나간다. */
function readString(value: unknown, label: string): string
{
    if (typeof value !== 'string' || value.length === 0)
    {
        throw new StorageManifestInvalidError(`Invalid manifest: ${label} must be a non-empty string`);
    }

    return value;
}

function assertionFailure(assert: () => void): string | null
{
    try
    {
        assert();

        return null;
    }
    catch (error)
    {
        return errorMessage(error);
    }
}
