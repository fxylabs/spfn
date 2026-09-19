/**
 * S3 / S3-호환 프로바이더 (AWS S3 · Cloudflare R2 · Wasabi · SeaweedFS).
 * R2 등은 `S3_ENDPOINT`만 추가하면 동작(S3 API 호환).
 * temp 업로드는 `lifecycle=temp` 태그 → finalizeObject로 제거. 고아 정리는 버킷 lifecycle 규칙(인프라).
 */

import {
    CopyObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    DeleteObjectTaggingCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
    DEFAULT_EXPIRES_IN,
    MAX_FILE_SIZE,
    StorageObjectNotFoundError,
    StorageVersionNotFoundError,
} from '../shared/index';
import { errorMessage } from './delete-many';
import { downloadUrlOptions } from './download-url';
import { assertKeyPrefix, assertObjectKey, resolveMaxKeys } from './object-key';
import { deleteEveryListedObject } from './prefix-delete';
import { assertSizeLimits } from './size-limit';
import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type {
    DeleteManyResult,
    DownloadUrlOptions,
    IStorageProvider,
    PrefixDeleteResult,
    PresignedUrlParams,
    PublicUploadParams,
    PresignedUrlResult,
    S3ProviderConfig,
    StorageCopyOptions,
    StorageListOptions,
    StorageListResult,
    StorageObjectStat,
} from '../shared/index';

const MAX_DELETE_OBJECTS = 1000;

export class S3StorageProvider implements IStorageProvider
{
    readonly providerKind = 's3' as const;
    private client: S3Client;
    private bucket: string;
    private publicBaseUrl: string;

    constructor(config: S3ProviderConfig = {})
    {
        const region = config.region ?? process.env.S3_REGION ?? 'us-east-1';
        const endpoint = config.endpoint ?? process.env.S3_ENDPOINT;
        this.bucket = config.bucket ?? process.env.S3_BUCKET ?? '';
        this.client = new S3Client({
            region,
            credentials: {
                accessKeyId: config.accessKeyId ?? process.env.S3_ACCESS_KEY_ID ?? '',
                secretAccessKey: config.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY ?? '',
            },
            ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        });
        this.publicBaseUrl = (config.publicBaseUrl ?? process.env.S3_PUBLIC_BASE_URL
            ?? `https://${this.bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/, '');
    }

    /** maxBytes는 presigned PUT 서명 조건에 넣을 수 없어 무시된다 — 크기 강제는 contentLength로. */
    async getUploadUrl(params: PresignedUrlParams & { temp?: boolean }): Promise<PresignedUrlResult>
    {
        const { key, contentType, expiresIn = DEFAULT_EXPIRES_IN, temp, maxBytes, contentLength } = params;
        assertSizeLimits(maxBytes, contentLength);
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: contentType,
            ...(temp ? { Tagging: 'lifecycle=temp' } : {}),
            ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
        });
        const requiredHeaders = {
            ...(temp ? { 'x-amz-tagging': 'lifecycle=temp' } : {}),
            ...(contentLength !== undefined ? { 'content-length': String(contentLength) } : {}),
        };

        return {
            uploadUrl: await getSignedUrl(this.client, command, { expiresIn }), key, expiresIn,
            ...(Object.keys(requiredHeaders).length > 0 ? { requiredHeaders } : {}),
        };
    }

    /** maxBytes는 presigned PUT 서명 조건에 넣을 수 없어 무시된다 — 크기 강제는 contentLength로. */
    async getPublicUploadUrl(params: PublicUploadParams): Promise<PresignedUrlResult>
    {
        const { key, contentType, contentLength, maxBytes, maxAge = 2592000, expiresIn = DEFAULT_EXPIRES_IN } = params;
        assertSizeLimits(maxBytes, contentLength);
        const cacheControl = `public, max-age=${maxAge}, immutable`;
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: contentType,
            CacheControl: cacheControl,
            Tagging: 'lifecycle=temp',
            ...(contentLength ? { ContentLength: contentLength } : {}),
        });
        const requiredHeaders = {
            'cache-control': cacheControl,
            'x-amz-tagging': 'lifecycle=temp',
            ...(contentLength ? { 'content-length': String(contentLength) } : {}),
        };

        return { uploadUrl: await getSignedUrl(this.client, command, { expiresIn }), key, expiresIn, requiredHeaders };
    }

    async getDownloadUrl(key: string, options?: number | DownloadUrlOptions): Promise<string>
    {
        const { expiresIn, responseContentDisposition, responseContentType } = downloadUrlOptions(options);
        const command = new GetObjectCommand({
            Bucket: this.bucket, Key: key,
            ResponseContentDisposition: responseContentDisposition,
            ResponseContentType: responseContentType,
        });

        return getSignedUrl(this.client, command, { expiresIn });
    }

    getPublicUrl(key: string): string
    {
        return `${this.publicBaseUrl}/${key}`;
    }

    async upload(key: string, body: string | Buffer, contentType: string): Promise<void>
    {
        assertObjectKey(key);
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    }

    async download(key: string): Promise<Buffer>
    {
        const body = await this.getObjectBody(key);

        return Buffer.from(await body.transformToByteArray());
    }

    /** Node 런타임에서 SDK가 돌려주는 Body는 Readable이다(브라우저 빌드가 아님). */
    async getStream(key: string): Promise<Readable>
    {
        return await this.getObjectBody(key) as unknown as Readable;
    }

    async copy(from: string, to: string, options: StorageCopyOptions = {}): Promise<void>
    {
        assertObjectKey(from);
        assertObjectKey(to);
        const versionId = options.sourceVersionId;
        await this.client
            .send(new CopyObjectCommand({
                Bucket: this.bucket,
                CopySource: copySourceFor(this.bucket, from, versionId),
                Key: to,
            }))
            .catch((error: unknown) =>
            {
                throw copyFailure(error, from, versionId);
            });
    }

    /** `HeadObject`는 버전 관리가 켜진 버킷에서만 `VersionId`를 싣는다 — 그 외에는 미정의로 남는다. */
    async stat(key: string): Promise<StorageObjectStat>
    {
        assertObjectKey(key);
        const head = await this.client
            .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
            .catch((error: unknown) =>
            {
                throw isS3NotFound(error) ? new StorageObjectNotFoundError(key) : error;
            });
        const etag = normalizeEtag(head.ETag);
        const contentHash = contentHashFromEtag(etag);
        const versionId = liveVersionId(head.VersionId);

        return {
            key,
            size: head.ContentLength ?? 0,
            ...(head.LastModified ? { lastModified: head.LastModified } : {}),
            ...(etag ? { etag } : {}),
            ...(contentHash ? { contentHash } : {}),
            ...(versionId ? { versionId } : {}),
        };
    }

    async list(prefix: string, options: StorageListOptions = {}): Promise<StorageListResult>
    {
        assertKeyPrefix(prefix);
        const page = await this.client.send(new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: `${prefix}/`,
            MaxKeys: resolveMaxKeys(options.maxKeys),
            ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
        }));

        return {
            objects: (page.Contents ?? [])
                .filter(item => typeof item.Key === 'string')
                .map(item =>
                {
                    const etag = normalizeEtag(item.ETag);

                    return {
                        key: item.Key as string,
                        size: item.Size ?? 0,
                        ...(item.LastModified ? { lastModified: item.LastModified } : {}),
                        ...(etag ? { etag } : {}),
                    };
                }),
            ...(page.IsTruncated && page.NextContinuationToken ? { cursor: page.NextContinuationToken } : {}),
        };
    }

    /** 키 단위 삭제 루프 — GCS interoperability가 `DeleteObjects`를 지원하지 않는다. */
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
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }

    async deleteMany(keys: string[]): Promise<DeleteManyResult>
    {
        const result: DeleteManyResult = { deleted: [], failed: [] };
        const validKeys: string[] = [];
        for (const key of keys)
        {
            try
            {
                assertObjectKey(key);
                validKeys.push(key);
            }
            catch (error)
            {
                result.failed.push({ key, error: errorMessage(error) });
            }
        }
        for (let offset = 0; offset < validKeys.length; offset += MAX_DELETE_OBJECTS)
        {
            const chunk = validKeys.slice(offset, offset + MAX_DELETE_OBJECTS);
            await this.deleteChunk(chunk, result);
        }

        return result;
    }

    private async deleteChunk(keys: string[], result: DeleteManyResult): Promise<void>
    {
        try
        {
            const response = await this.client.send(new DeleteObjectsCommand({
                Bucket: this.bucket,
                Delete: { Objects: keys.map(Key => ({ Key })) },
            }));
            const errorsByKey = new Map(response.Errors
                ?.filter(error => error.Key)
                .map(error => [error.Key as string, formatS3Error(error.Code, error.Message)]));
            if (response.Errors?.some(error => !error.Key))
            {
                const error = formatS3Error(response.Errors[0]?.Code, response.Errors[0]?.Message);
                result.failed.push(...keys.map(key => ({ key, error })));

                return;
            }
            for (const key of keys)
            {
                const error = errorsByKey.get(key);
                if (error)
                {
                    result.failed.push({ key, error });
                }
                else
                {
                    result.deleted.push(key);
                }
            }
        }
        catch (error)
        {
            const message = errorMessage(error);
            result.failed.push(...keys.map(key => ({ key, error: message })));
        }
    }

    async finalizeObject(key: string): Promise<void>
    {
        await this.client.send(new DeleteObjectTaggingCommand({ Bucket: this.bucket, Key: key }));
    }

    getMaxFileSize(): number
    {
        return MAX_FILE_SIZE;
    }

    private async getObjectBody(key: string): Promise<NonNullable<GetObjectCommandOutput['Body']>>
    {
        assertObjectKey(key);
        const response = await this.client
            .send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
            .catch((error: unknown) =>
            {
                throw isS3NotFound(error) ? new StorageObjectNotFoundError(key) : error;
            });
        if (!response.Body)
        {
            throw new StorageObjectNotFoundError(key);
        }

        return response.Body;
    }
}

function formatS3Error(code?: string, message?: string): string
{
    return [code, message].filter(Boolean).join(': ') || 'Object deletion failed';
}

/**
 * `x-amz-copy-source` 값은 URL 인코딩해야 하고 SDK가 대신 해주지 않는다. 세그먼트 단위로
 * 인코딩해 `/` 구분자는 남기고 `?`·`#`·`+`·공백·유니코드가 든 키도 그대로 복사되게 한다.
 */
function encodeCopySource(bucket: string, key: string): string
{
    return `${bucket}/${key}`.split('/').map(encodeURIComponent).join('/');
}

/**
 * `?versionId=`는 세그먼트 인코딩 **뒤에** 붙인다 — 먼저 붙이면 구분자 `?`까지 `%3F`가 되어
 * 버전이 아니라 키의 일부로 읽힌다(키에 든 `?`는 이미 `%3F`라 구분이 모호하지 않다).
 */
function copySourceFor(bucket: string, key: string, versionId?: string): string
{
    const source = encodeCopySource(bucket, key);

    return versionId === undefined ? source : `${source}?versionId=${encodeURIComponent(versionId)}`;
}

/** 버전을 지정한 복사의 실패는 버전 부재로 접는다 — 버전 관리가 꺼진 버킷의 400도 같은 뜻이다. */
function copyFailure(error: unknown, from: string, versionId?: string): unknown
{
    if (versionId === undefined)
    {
        return isS3NotFound(error) ? new StorageObjectNotFoundError(from) : error;
    }

    return isMissingVersion(error) ? new StorageVersionNotFoundError(from, versionId) : error;
}

function isMissingVersion(error: unknown): boolean
{
    const name = (error as { name?: string } | null)?.name;

    return isS3NotFound(error) || name === 'NoSuchVersion' || name === 'InvalidArgument';
}

/** ETag는 따옴표로 감싸여 온다. 값 자체는 provider가 준 그대로 둔다. */
function normalizeEtag(etag?: string): string | undefined
{
    return etag ? etag.replace(/^"|"$/g, '') : undefined;
}

/** multipart ETag(`…-N`)는 MD5가 아니다 — 콘텐츠 해시로 기록하지 않는다. */
function contentHashFromEtag(etag?: string): string | undefined
{
    return etag !== undefined && /^[\da-f]{32}$/i.test(etag) ? etag.toLowerCase() : undefined;
}

/**
 * `"null"` 버전은 버전 관리가 정지된 사이에 쓰였거나 버전 관리 이전부터 있던 객체다.
 * 덮어쓰기로 사라지므로 복원 대상으로 삼지 않는다.
 */
function liveVersionId(versionId?: string): string | undefined
{
    return versionId === undefined || versionId === 'null' ? undefined : versionId;
}

/** SDK 오류는 name과 HTTP 상태 둘 중 하나로만 404를 알릴 때가 있어 양쪽을 본다. */
function isS3NotFound(error: unknown): boolean
{
    const name = (error as { name?: string } | null)?.name;
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;

    return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
