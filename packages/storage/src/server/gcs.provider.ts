/**
 * Google Cloud Storage 프로바이더.
 * `public/*` 키 → 공개 버킷, 그 외 → 비공개 버킷(V4 signed). presigned는 GCS V4 native.
 * temp 업로드는 `tmp/<key>`에 서명하고 finalizeObject가 최종 key로 이동(rewrite).
 * 고아 정리는 버킷 lifecycle 규칙(matchesPrefix: tmp/ + age) — README 참고.
 *
 * @google-cloud/storage는 optional dependency — STORAGE_PROVIDER=gcs일 때만 동적 로드된다.
 */

import { Storage, type Bucket } from '@google-cloud/storage';
import {
    DEFAULT_EXPIRES_IN,
    MAX_FILE_SIZE,
    StorageObjectNotFoundError,
    StorageVersionNotFoundError,
} from '../shared/index';
import { createOnlyFailure } from './create-only';
import { deleteManyIndividually } from './delete-many';
import { downloadUrlOptions } from './download-url';
import { isPublicKey } from './keys';
import { assertKeyPrefix, assertObjectKey, resolveMaxKeys } from './object-key';
import { awaitStreamStart } from './object-stream';
import { deleteEveryListedObject } from './prefix-delete';
import { resolveGcsConfig } from './service-config';
import { assertSizeLimits, gcsContentLengthRange } from './size-limit';
import type { Readable } from 'node:stream';
import type {
    DeleteManyResult,
    DownloadUrlOptions,
    GcsProviderConfig,
    IStorageProvider,
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

export class GcsStorageProvider implements IStorageProvider
{
    readonly providerKind = 'gcs' as const;
    private storage: Storage;
    /**
     * `ifAbsent` 쓰기 전용 — `autoRetry: false`라 요청 계층(retry-request)과 `save`가 재시도하지 않는다.
     * 호출 단위 옵션은 쓰지 않는다: SDK가 공유 `storage.retryOptions.autoRetry`를 바꿨다 되돌리는 방식이라
     * 같은 인스턴스의 동시 호출과 경합한다.
     */
    private createOnlyStorage: Storage;
    private publicBucket: Bucket;
    private privateBucket: Bucket;
    private publicBucketName: string;
    private privateBucketName: string;

    constructor(config: GcsProviderConfig = {})
    {
        const { projectId, credentials, publicBucket, privateBucket } = resolveGcsConfig(config);
        const storageOptions = { projectId, ...(credentials ? { credentials } : {}) };
        this.storage = new Storage(storageOptions);
        this.createOnlyStorage = new Storage({ ...storageOptions, retryOptions: { autoRetry: false } });
        this.publicBucketName = publicBucket;
        this.privateBucketName = privateBucket;
        this.publicBucket = this.storage.bucket(this.publicBucketName);
        this.privateBucket = this.storage.bucket(this.privateBucketName);
    }

    private resolveBucket(key: string): Bucket
    {
        return isPublicKey(key) ? this.publicBucket : this.privateBucket;
    }

    /** `ifAbsent` 쓰기는 재시도 없는 인스턴스의 같은 버킷으로 보낸다. */
    private writeBucket(key: string, ifAbsent?: boolean): Bucket
    {
        return ifAbsent
            ? this.createOnlyStorage.bucket(isPublicKey(key) ? this.publicBucketName : this.privateBucketName)
            : this.resolveBucket(key);
    }

    /** temp=true면 `tmp/<key>`에 서명 — finalizeObject 전에는 최종 key로 읽을 수 없다. */
    async getUploadUrl(params: PresignedUrlParams & { temp?: boolean }): Promise<PresignedUrlResult>
    {
        const { key, contentType, expiresIn = DEFAULT_EXPIRES_IN, temp, maxBytes, contentLength } = params;
        assertSizeLimits(maxBytes, contentLength);
        const extensionHeaders = sizeExtensionHeaders(maxBytes, contentLength);
        const [uploadUrl] = await this.resolveBucket(key).file(temp ? TEMP_KEY_PREFIX + key : key).getSignedUrl({
            version: 'v4', action: 'write', expires: Date.now() + expiresIn * 1000, contentType,
            ...(extensionHeaders ? { extensionHeaders } : {}),
        });

        return { uploadUrl, key, expiresIn, ...(extensionHeaders ? { requiredHeaders: extensionHeaders } : {}) };
    }

    async getPublicUploadUrl(params: PublicUploadParams): Promise<PresignedUrlResult>
    {
        const { key, contentType, maxAge = 2592000, expiresIn = DEFAULT_EXPIRES_IN, maxBytes, contentLength } = params;
        assertSizeLimits(maxBytes, contentLength);
        const extensionHeaders = {
            'cache-control': `public, max-age=${maxAge}, immutable`,
            ...sizeExtensionHeaders(maxBytes, contentLength),
        };
        const [uploadUrl] = await this.resolveBucket(key).file(key).getSignedUrl({
            version: 'v4', action: 'write', expires: Date.now() + expiresIn * 1000, contentType,
            extensionHeaders,
        });

        return { uploadUrl, key, expiresIn, requiredHeaders: extensionHeaders };
    }

    async getDownloadUrl(key: string, options?: number | DownloadUrlOptions): Promise<string>
    {
        const { expiresIn, responseContentDisposition, responseContentType } = downloadUrlOptions(options);
        const [url] = await this.resolveBucket(key).file(key).getSignedUrl({
            version: 'v4', action: 'read', expires: Date.now() + expiresIn * 1000,
            ...(responseContentDisposition ? { responseDisposition: responseContentDisposition } : {}),
            ...(responseContentType ? { responseType: responseContentType } : {}),
        });

        return url;
    }

    getPublicUrl(key: string): string
    {
        return `https://storage.googleapis.com/${this.publicBucketName}/${key}`;
    }

    /**
     * `ifAbsent`는 `ifGenerationMatch: 0`을 재시도 없이 한 번 보낸다 — 살아 있는 generation이 없을 때만
     * GCS가 받아들인다.
     */
    async upload(key: string, body: string | Buffer, contentType: string, options: StorageUploadOptions = {}): Promise<void>
    {
        assertObjectKey(key);
        await this.writeBucket(key, options.ifAbsent).file(key)
            .save(
                typeof body === 'string' ? Buffer.from(body) : body,
                { contentType, resumable: false, ...createOnly(options.ifAbsent) },
            )
            .catch((error: unknown) =>
            {
                throw (options.ifAbsent ? createOnlyFailure(error, gcsStatus(error), key, MAY_HAVE_SENT) : null) ?? error;
            });
    }

    async download(key: string): Promise<Buffer>
    {
        assertObjectKey(key);
        const [buffer] = await this.resolveBucket(key).file(key).download().catch((error: unknown) =>
        {
            throw isGcsNotFound(error) ? new StorageObjectNotFoundError(key) : error;
        });

        return buffer;
    }

    async getStream(key: string): Promise<Readable>
    {
        assertObjectKey(key);

        return awaitStreamStart(
            this.resolveBucket(key).file(key).createReadStream(),
            error => (isGcsNotFound(error) ? new StorageObjectNotFoundError(key) : error),
        );
    }

    /**
     * 서버사이드 rewrite. `public/` 규칙상 원본과 대상이 다른 버킷일 수 있어 대상 File을 넘긴다.
     * `sourceVersionId`는 generation으로 스코프한다 — 그 generation이 없으면 404다.
     */
    async copy(from: string, to: string, options: StorageCopyOptions = {}): Promise<void>
    {
        assertObjectKey(from);
        assertObjectKey(to);
        const versionId = options.sourceVersionId;
        const bucket = this.writeBucket(from, options.ifAbsent);
        const source = versionId === undefined ? bucket.file(from) : bucket.file(from, { generation: versionId });
        await source.copy(this.writeBucket(to, options.ifAbsent).file(to), createOnly(options.ifAbsent)).catch((error: unknown) =>
        {
            const createOnlyError = options.ifAbsent ? createOnlyFailure(error, gcsStatus(error), to, MAY_HAVE_SENT) : null;
            if (createOnlyError)
            {
                throw createOnlyError;
            }
            if (!isGcsNotFound(error))
            {
                throw error;
            }

            throw versionId === undefined
                ? new StorageObjectNotFoundError(from)
                : new StorageVersionNotFoundError(from, versionId);
        });
    }

    /** `getMetadata`는 generation·etag·md5Hash를 함께 준다 — 추가 호출이 없다. */
    async stat(key: string): Promise<StorageObjectStat>
    {
        assertObjectKey(key);
        const [metadata] = await this.resolveBucket(key).file(key).getMetadata().catch((error: unknown) =>
        {
            throw isGcsNotFound(error) ? new StorageObjectNotFoundError(key) : error;
        });

        return toStorageObject(key, metadata);
    }

    async list(prefix: string, options: StorageListOptions = {}): Promise<StorageListResult>
    {
        assertKeyPrefix(prefix);
        const [files, nextQuery] = await this.resolveBucket(prefix).getFiles({
            prefix: `${prefix}/`,
            maxResults: resolveMaxKeys(options.maxKeys),
            autoPaginate: false,
            ...(options.cursor ? { pageToken: options.cursor } : {}),
        });
        const cursor = (nextQuery as { pageToken?: string } | null | undefined)?.pageToken;

        return {
            objects: files.map(file => toStorageObject(file.name, file.metadata)),
            ...(cursor ? { cursor } : {}),
        };
    }

    /**
     * 키 단위 삭제 루프. GCS 네이티브 SDK에는 `deleteFiles`가 있지만 페이지 경계와 부분 실패
     * 보고가 provider마다 갈리지 않도록 S3 provider와 같은 드라이버를 쓴다.
     */
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
        await this.resolveBucket(key).file(key).delete({ ignoreNotFound: true });
    }

    async deleteMany(keys: string[]): Promise<DeleteManyResult>
    {
        return deleteManyIndividually(keys, key => this.delete(key));
    }

    /** `tmp/<key>` → `key` 이동(서버사이드 rewrite). 이미 finalize된 경우 멱등 성공. */
    async finalizeObject(key: string): Promise<void>
    {
        const bucket = this.resolveBucket(key);
        const moveError = await bucket.file(TEMP_KEY_PREFIX + key).move(key)
            .then(() => null, (error: unknown) => error);
        if (moveError === null)
        {
            return;
        }
        if (isGcsNotFound(moveError))
        {
            const [exists] = await bucket.file(key).exists();
            if (exists)
            {
                return;
            }
        }

        throw moveError;
    }

    getMaxFileSize(): number
    {
        return MAX_FILE_SIZE;
    }
}

const TEMP_KEY_PREFIX = 'tmp/';

interface GcsObjectMetadata
{
    size?: string | number;
    updated?: string;
    etag?: string;
    generation?: string | number;
    md5Hash?: string;
}

/**
 * generation은 typings상 `string | number`라 언제나 `String()`으로 맞춘다 — list 경로와 stat
 * 경로가 다른 타입을 쓰면 `already-current` 비교가 조용히 빗나간다.
 */
function toStorageObject(key: string, metadata: GcsObjectMetadata): StorageObject
{
    const updated = metadata.updated;
    const contentHash = hexMd5(metadata.md5Hash);

    return {
        key,
        size: Number(metadata.size ?? 0),
        ...(updated ? { lastModified: new Date(updated) } : {}),
        ...(metadata.etag ? { etag: metadata.etag } : {}),
        ...(metadata.generation === undefined ? {} : { versionId: String(metadata.generation) }),
        ...(contentHash ? { contentHash } : {}),
    };
}

/** composite 객체와 XML multipart 업로드에는 md5Hash가 없다 — crc32c는 기록하지 않는다. */
function hexMd5(md5Hash?: string): string | undefined
{
    return md5Hash ? Buffer.from(md5Hash, 'base64').toString('hex') : undefined;
}

function isGcsNotFound(error: unknown): boolean
{
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 404;
}

/** generation 0은 "살아 있는 객체가 없다"는 뜻이다 — 쓰기와 rewrite 대상 모두에 같은 조건이다. */
function createOnly(ifAbsent?: boolean): { preconditionOpts?: { ifGenerationMatch: number } }
{
    return ifAbsent ? { preconditionOpts: { ifGenerationMatch: 0 } } : {};
}

/**
 * GCS의 create-only 쓰기는 응답이 없으면 언제나 "보냈을 수 있다"다. 한 작업의 요청이 어느 연결에도 쓰이지
 * 않았다는 것을 SDK가 알려 주지 않는다: node-fetch가 redirect를 안에서 따라가고(teeny-request는
 * `redirect`·`agent` 옵션을 넘기지 않는다) 최종 오류의 `erroredSysCall`은 마지막 연결의 것이라, 첫 요청이
 * 서버에 닿은 뒤 다음 연결의 `connect` 실패와 처음부터 나가지 않은 요청을 구분할 수 없다.
 */
const MAY_HAVE_SENT = true;

/** 응답을 받은 오류(ApiError)만 `code`에 HTTP 상태를 싣는다 — 연결 오류의 `code`는 `ECONNRESET` 같은 문자열이다. */
function gcsStatus(error: unknown): number | undefined
{
    const code = (error as { code?: unknown } | null)?.code;

    return typeof code === 'number' ? code : undefined;
}

function sizeExtensionHeaders(maxBytes?: number, contentLength?: number): Record<string, string> | null
{
    const range = gcsContentLengthRange(maxBytes, contentLength);

    return range ? { 'x-goog-content-length-range': range } : null;
}
