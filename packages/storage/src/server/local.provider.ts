/**
 * 로컬 파일시스템 프로바이더 — 개발용.
 *
 * 객체를 `LOCAL_STORAGE_DIR`(기본 `.storage`) 아래 key 경로로 그대로 기록한다.
 * 공개 URL은 소비 앱이 `getStorageService().getStream(key)`로 스트리밍하는
 * provider-중립 라우트(`LOCAL_STORAGE_BASE_URL`, 기본 `/api/storage`)를 가리킨다.
 * presigned PUT은 서명 개념이 없어 미지원 — 그림 생성 등 서버 직접 업로드만 쓴다.
 *
 * 파일시스템이라 객체 저장소와 다른 점 하나: 같은 이름이 파일이면서 디렉터리일 수 없으므로
 * `a/b`와 `a/b/c.png`를 동시에 저장할 수 없다(S3·GCS는 가능). README 참고.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
    MAX_FILE_SIZE,
    StorageKeyError,
    StorageObjectExistsError,
    StorageObjectNotFoundError,
    StorageVersionNotFoundError,
} from '../shared/index';
import { deleteManyIndividually } from './delete-many';
import { downloadUrlOptions, responseHeaderQuery } from './download-url';
import { assertKeyPrefix, assertObjectKey, compareKeys, resolveMaxKeys } from './object-key';
import { awaitStreamStart } from './object-stream';
import { deleteEveryListedObject } from './prefix-delete';
import { resolveLocalConfig } from './service-config';
import type { Readable } from 'node:stream';
import type {
    DeleteManyResult,
    DownloadUrlOptions,
    IStorageProvider,
    LocalProviderConfig,
    PrefixDeleteResult,
    PresignedUrlParams,
    PublicUploadParams,
    PresignedUrlResult,
    StorageCopyOptions,
    StorageListOptions,
    StorageListResult,
    StorageObject,
    StorageObjectStat,
    StorageUploadOptions,
} from '../shared/index';

/**
 * create-only 쓰기의 임시 파일을 두는 디렉터리 — 스토리지 루트 바로 아래. 이름에 백슬래시가 있어 어떤
 * key·prefix의 경로도 될 수 없다(`assertObjectKey`가 모든 provider에서 백슬래시를 거부한다). 그래서
 * `list`·`deletePrefix`·`stat`·`download`처럼 key로 닿는 경로는 이 디렉터리에 닿지 않는다 — 이름으로
 * 걸러 내는 것이 아니라 닿을 길이 없다. 백슬래시가 구분자인 Windows에서는 성립하지 않는다.
 */
const PARTIAL_DIR = '\\partial';

export class LocalStorageProvider implements IStorageProvider
{
    readonly providerKind = 'local' as const;
    private baseDir: string;
    private baseUrl: string;

    constructor(config: LocalProviderConfig = {})
    {
        const { dir, baseUrl } = resolveLocalConfig(config);
        this.baseDir = dir;
        this.baseUrl = baseUrl;
    }

    /** key를 baseDir 안의 실제 경로로. traversal(`..` 등)은 차단. */
    private pathFor(key: string): string
    {
        const full = resolve(this.baseDir, key);
        if (!isWithin(this.baseDir, full))
        {
            throw new Error(`Invalid storage key: ${key}`);
        }

        return full;
    }

    async getUploadUrl(_params: PresignedUrlParams & { temp?: boolean }): Promise<PresignedUrlResult>
    {
        throw new Error('presigned upload not supported by local storage provider');
    }

    async getPublicUploadUrl(_params: PublicUploadParams): Promise<PresignedUrlResult>
    {
        throw new Error('presigned upload not supported by local storage provider');
    }

    async getDownloadUrl(key: string, options?: number | DownloadUrlOptions): Promise<string>
    {
        return this.getPublicUrl(key) + responseHeaderQuery(downloadUrlOptions(options));
    }

    getPublicUrl(key: string): string
    {
        return `${this.baseUrl}/${key}`;
    }

    /** `ifAbsent`는 임시 파일에 다 쓴 뒤 `link`로 게시한다(`publishExclusive`). */
    async upload(key: string, body: string | Buffer, _contentType: string, options: StorageUploadOptions = {}): Promise<void>
    {
        assertObjectKey(key);
        const path = await this.prepareTarget(key);
        if (options.ifAbsent)
        {
            return publishExclusive(await this.partialPath(), path, key, temp => writeFile(temp, body, { flag: 'wx' }));
        }
        await writeFile(path, body);
    }

    async download(key: string): Promise<Buffer>
    {
        assertObjectKey(key);

        return readFile(this.pathFor(key)).catch((error: unknown) =>
        {
            throw isNotFoundError(error) ? new StorageObjectNotFoundError(key) : error;
        });
    }

    async getStream(key: string): Promise<Readable>
    {
        assertObjectKey(key);

        return awaitStreamStart(
            createReadStream(this.pathFor(key)),
            error => (isNotFoundError(error) ? new StorageObjectNotFoundError(key) : error),
        );
    }

    /**
     * 원본 부재를 raw ENOENT가 아니라 계약 오류로 통일한다 — 대상은 만들지 않는다.
     * 로컬은 버전이 없어 `sourceVersionId`는 현재 파일의 contentHash로만 만족된다.
     */
    async copy(from: string, to: string, options: StorageCopyOptions = {}): Promise<void>
    {
        assertObjectKey(from);
        assertObjectKey(to);
        const source = this.pathFor(from);
        const found = await stat(source).catch(() => null);
        const versionId = options.sourceVersionId;
        if (!found?.isFile())
        {
            throw versionId === undefined
                ? new StorageObjectNotFoundError(from)
                : new StorageVersionNotFoundError(from, versionId);
        }
        if (versionId !== undefined && versionId !== await sha256(source))
        {
            throw new StorageVersionNotFoundError(from, versionId);
        }
        const target = await this.prepareTarget(to);
        if (options.ifAbsent)
        {
            return publishExclusive(await this.partialPath(), target, to, temp => copyFile(source, temp, constants.COPYFILE_EXCL));
        }
        await copyFile(source, target);
    }

    /** 버전이 없으므로 `versionId`는 싣지 않는다 — 대신 sha256을 `contentHash`로 준다. */
    async stat(key: string): Promise<StorageObjectStat>
    {
        assertObjectKey(key);
        const path = this.pathFor(key);
        const found = await stat(path).catch(() => null);
        if (!found?.isFile())
        {
            throw new StorageObjectNotFoundError(key);
        }

        return { key, size: found.size, lastModified: found.mtime, contentHash: await sha256(path) };
    }

    async list(prefix: string, options: StorageListOptions = {}): Promise<StorageListResult>
    {
        assertKeyPrefix(prefix);
        const maxKeys = resolveMaxKeys(options.maxKeys);
        const remaining = (await this.walk(prefix))
            .filter(object => options.cursor === undefined || compareKeys(object.key, options.cursor) > 0);
        const objects = remaining.slice(0, maxKeys);

        return {
            objects,
            ...(remaining.length > objects.length ? { cursor: objects[objects.length - 1].key } : {}),
        };
    }

    /** 빈 디렉터리는 남을 수 있다 — `list`가 파일만 세므로 API 상으로는 보이지 않는다. */
    async deletePrefix(prefix: string): Promise<PrefixDeleteResult>
    {
        assertKeyPrefix(prefix);

        return deleteEveryListedObject(
            cursor => this.list(prefix, cursor === undefined ? {} : { cursor }),
            key => this.delete(key),
        );
    }

    async delete(key: string): Promise<void>
    {
        assertObjectKey(key);
        const path = this.pathFor(key);

        try
        {
            const [realBaseDir, realParentDir] = await Promise.all([
                realpath(this.baseDir),
                realpath(dirname(path)),
            ]);
            if (!isWithin(realBaseDir, realParentDir))
            {
                throw new Error(`Invalid storage key: ${key}`);
            }
            await unlink(path);
        }
        catch (error)
        {
            if (!isNotFoundError(error))
            {
                throw error;
            }
        }
    }

    async deleteMany(keys: string[]): Promise<DeleteManyResult>
    {
        return deleteManyIndividually(keys, key => this.delete(key));
    }

    /** 로컬은 temp 태그 개념이 없어 no-op. */
    async finalizeObject(_key: string): Promise<void>
    {
    }

    getMaxFileSize(): number
    {
        return MAX_FILE_SIZE;
    }

    /**
     * 쓰기 대상 경로를 만들고 반환한다. 디렉터리를 만든 뒤 실제 경로를 확인하므로
     * 스토리지 루트 밖을 가리키는 심볼릭 링크를 타고 파일을 쓰지 않는다(`delete`와 같은 판정).
     */
    private async prepareTarget(key: string): Promise<string>
    {
        const path = this.pathFor(key);
        const parent = dirname(path);
        await mkdir(parent, { recursive: true });
        const [realBaseDir, realParentDir] = await Promise.all([realpath(this.baseDir), realpath(parent)]);
        if (!isWithin(realBaseDir, realParentDir))
        {
            throw new StorageKeyError(`Invalid storage key: ${key} — resolves outside the storage root`);
        }

        return path;
    }

    /** create-only 쓰기 하나의 임시 파일 경로(`PARTIAL_DIR` 아래, 아직 없는 이름). */
    private async partialPath(): Promise<string>
    {
        const dir = join(this.baseDir, PARTIAL_DIR);
        await mkdir(dir, { recursive: true });

        return join(dir, randomUUID());
    }

    private async walk(prefix: string): Promise<StorageObject[]>
    {
        const objects: StorageObject[] = [];
        await collectFiles(this.pathFor(prefix), prefix, objects);

        return objects.sort((left, right) => compareKeys(left.key, right.key));
    }
}

/**
 * `<prefix>/` 아래 일반 파일만 모은다. 심볼릭 링크는 파일도 디렉터리도 아니라 건너뛰므로
 * 링크를 타고 스토리지 루트 밖으로 나가지 않는다.
 */
async function collectFiles(dir: string, keyPrefix: string, objects: StorageObject[]): Promise<void>
{
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) =>
    {
        if (isNotFoundError(error) || isNotDirectoryError(error))
        {
            return [];
        }

        throw error;
    });
    for (const entry of entries)
    {
        const key = `${keyPrefix}/${entry.name}`;
        if (entry.isDirectory())
        {
            await collectFiles(join(dir, entry.name), key, objects);
        }
        else if (entry.isFile())
        {
            const info = await stat(join(dir, entry.name));
            objects.push({ key, size: info.size, lastModified: info.mtime });
        }
    }
}

/**
 * create-only 쓰기를 원자적으로 게시한다. 바이트는 `PARTIAL_DIR`의 임시 파일에 먼저 다 쓰고, `link`로
 * 최종 key에 건다 — `link`는 대상이 있으면 EEXIST로 실패하므로 판정과 게시가 한 연산이다
 * (`rename`은 대상을 바꿔치기하므로 쓸 수 없다). 그래서 도중에 실패한 쓰기(ENOSPC·EFBIG·스트림 오류)는
 * key에 아무것도 남기지 않고, 다른 독자는 완성된 바이트만 본다. 임시 이름은 성공·실패 모두 지운다.
 * 하드 링크가 없는 파일시스템(FAT·exFAT 등)에서는 `link`가 EPERM/ENOTSUP으로 실패해 그대로 전파된다 —
 * 원자성을 잃은 쓰기로 대신하지 않는다.
 */
async function publishExclusive(
    temp: string,
    target: string,
    key: string,
    write: (temp: string) => Promise<void>,
): Promise<void>
{
    await write(temp)
        .then(() => link(temp, target).catch(async (error: unknown) =>
        {
            throw await existsFailure(error, target, key);
        }))
        .finally(() => unlink(temp).catch(() => undefined));
}

/**
 * 배타적 생성의 EEXIST를 계약 오류로 바꾼다. 같은 이름의 디렉터리(`a/b/c`가 있는 `a/b`)도
 * EEXIST를 내지만 그건 객체가 아니므로 원래 오류를 그대로 둔다 — `stat`은 그 key를 없다고 한다.
 */
async function existsFailure(error: unknown, path: string, key: string): Promise<unknown>
{
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
    {
        return error;
    }
    const found = await lstat(path).catch(() => null);

    return found?.isDirectory() ? error : new StorageObjectExistsError(key);
}

/** 파일 전체를 메모리에 올리지 않고 해시한다 — 스냅샷이 큰 객체를 훑기 때문이다. */
async function sha256(path: string): Promise<string>
{
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);

    return hash.digest('hex');
}

function isWithin(root: string, candidate: string): boolean
{
    return candidate === root || candidate.startsWith(root + sep);
}

function isNotDirectoryError(error: unknown): boolean
{
    return error instanceof Error && 'code' in error && error.code === 'ENOTDIR';
}

function isNotFoundError(error: unknown): boolean
{
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
