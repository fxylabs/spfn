/**
 * @spfn/storage — provider-agnostic object storage.
 *
 * presigned 업로드(S3 SigV4 / GCS V4 / R2 등 S3호환)·직접 업/다운로드·공개 URL·
 * 서버사이드 복사·프리픽스 정리·스트리밍 다운로드를 단일 인터페이스로 제공한다.
 * DB 없이 결과 key/URL은 소비 앱의 도메인 엔티티에 저장한다.
 */

import type { Readable } from 'node:stream';

/**
 * 키·프리픽스가 구조적으로 유효하지 않을 때. provider에 요청을 보내기 전에 던지므로
 * 잘못된 키가 스토리지에 닿지 않는다.
 */
export class StorageKeyError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'StorageKeyError';
    }
}

/**
 * 대상 객체가 없을 때 — provider 3종이 같은 타입으로 통일한다. `code`는 Node 관습을
 * 따라 `ENOENT`이므로 provider와 무관하게 `error.code === 'ENOENT'`로도 판정할 수 있다.
 */
export class StorageObjectNotFoundError extends Error
{
    readonly key: string;
    readonly code = 'ENOENT';

    constructor(key: string)
    {
        super(`Object not found: ${key}`);
        this.name = 'StorageObjectNotFoundError';
        this.key = key;
    }
}

/**
 * 객체는 있지만 요청한 버전이 없을 때 — lifecycle로 사라졌거나 애초에 없던 버전이다.
 * `StorageObjectNotFoundError`를 상속하지 않는다: 404로 접으면 "객체가 없다"와 구분되지 않는다.
 */
export class StorageVersionNotFoundError extends Error
{
    readonly key: string;
    readonly versionId: string;

    constructor(key: string, versionId: string)
    {
        super(`Object version not found: ${key} (versionId ${versionId})`);
        this.name = 'StorageVersionNotFoundError';
        this.key = key;
        this.versionId = versionId;
    }
}

/** 매니페스트의 형태가 깨졌거나 현재 provider·prefix와 맞지 않을 때. 복원은 시작도 하지 않는다. */
export class StorageManifestInvalidError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'StorageManifestInvalidError';
    }
}

export interface PresignedUrlParams
{
    key: string;
    contentType: string;
    expiresIn?: number;
    /** 업로드 크기 상한(bytes). GCS는 서명으로 강제, S3 presigned PUT은 강제 불가(README 참고). */
    maxBytes?: number;
    /** 정확한 업로드 크기(bytes). S3·GCS 모두 서명으로 강제. */
    contentLength?: number;
}

export interface PublicUploadParams
{
    key: string;
    contentType: string;
    /** 정확한 업로드 크기(bytes). S3·GCS 모두 서명으로 강제. */
    contentLength?: number;
    /** 업로드 크기 상한(bytes). GCS는 서명으로 강제, S3 presigned PUT은 강제 불가(README 참고). */
    maxBytes?: number;
    maxAge?: number;
    expiresIn?: number;
}

export interface PresignedUrlResult
{
    /** 클라이언트가 PUT 할 presigned URL */
    uploadUrl: string;
    /** 업로드된 객체 key (provider-중립 이름) */
    key: string;
    expiresIn: number;
    /** 서명에 포함된 헤더 — 클라이언트가 PUT 요청에 그대로 보내야 서명이 유효하다. */
    requiredHeaders?: Record<string, string>;
}

export interface DeleteManyResult
{
    deleted: string[];
    failed: Array<{ key: string; error: string }>;
}

/** `list`가 돌려주는 객체 한 건. */
export interface StorageObject
{
    key: string;
    /** 바이트 크기. provider가 알려주지 않으면 0. */
    size: number;
    lastModified?: Date;
    /** provider의 엔티티 태그. 기록용이다 — GCS etag는 메타데이터 수정에도 바뀌므로 비교에 쓰지 않는다. */
    etag?: string;
    /** 객체 버전 식별자. list 응답이 실어 줄 때만(GCS generation). 언제나 문자열이다. */
    versionId?: string;
    /** 콘텐츠 해시(hex). GCS md5Hash처럼 list 응답이 실어 줄 때만. */
    contentHash?: string;
}

/** `stat`이 돌려주는 객체 한 건의 메타데이터. */
export interface StorageObjectStat
{
    key: string;
    size: number;
    lastModified?: Date;
    etag?: string;
    /**
     * 콘텐츠 해시(hex). gcs·s3에서는 정보용이고 판정에 쓰지 않는다 — composite·multipart
     * 객체에는 md5가 없어 미정의다. local만 `already-current` 판정에 쓴다.
     */
    contentHash?: string;
    /** 현재 live 버전의 식별자. 버전 관리가 없는 provider·버킷에서는 미정의. */
    versionId?: string;
}

/** 서버사이드 복사 옵션. */
export interface StorageCopyOptions
{
    /** 이 버전을 원본으로 복사한다. 그 버전이 없으면 `StorageVersionNotFoundError`. */
    sourceVersionId?: string;
}

/** 매니페스트 한 항목 — 스냅샷 시점의 객체 하나. */
export interface ManifestEntry
{
    key: string;
    size: number;
    etag?: string;
    contentHash?: string;
    versionId?: string;
}

/**
 * prefix 하나의 스냅샷. 보관은 앱 몫이다 — 패키지는 형태와 직렬화만 제공한다.
 * `entries`의 모든 key는 `${prefix}/` 아래다(`parseManifest`가 검증한다).
 */
export interface Manifest
{
    schemaVersion: 1;
    /** ISO 8601, 밀리초 없음. */
    createdAt: string;
    prefix: string;
    /** 스냅샷을 찍은 provider. 다른 provider로는 복원하지 않는다. */
    provider: 'gcs' | 's3' | 'local';
    entries: ManifestEntry[];
}

/** `restoreManifest`의 항목별 결과. 첫 실패에서 멈추지 않는다(`deletePrefix`와 같은 보고 방식). */
export interface RestoreResult
{
    /** 복원(copy)된 대상 key. */
    restored: string[];
    skipped: Array<{ key: string; reason: 'already-current' | 'no-version' | 'version-missing' }>;
    failed: Array<{ key: string; error: string }>;
}

export interface StorageListOptions
{
    /** 한 페이지 최대 개수(양의 정수). 미지정 시 1,000. */
    maxKeys?: number;
    /** 직전 페이지가 돌려준 커서. provider마다 형식이 다른 불투명 값이다. */
    cursor?: string;
}

export interface StorageListResult
{
    objects: StorageObject[];
    /** 다음 페이지 커서. `undefined`면 마지막 페이지다 — 빈 `objects`로 판단하면 안 된다. */
    cursor?: string;
}

/** `deletePrefix` 결과. 삭제 대상이 많을 수 있어 성공은 개수만 센다. */
export interface PrefixDeleteResult
{
    deleted: number;
    failed: Array<{ key: string; error: string }>;
}

/** S3/S3-호환 프로바이더 설정. 미지정 필드는 process.env(S3_*)로 fallback. */
export interface S3ProviderConfig
{
    region?: string;
    endpoint?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    publicBaseUrl?: string;
}

/** GCS 프로바이더 설정. 미지정 필드는 process.env(GCS_*)로 fallback. */
export interface GcsProviderConfig
{
    projectId?: string;
    publicBucket?: string;
    privateBucket?: string;
    credentialsJsonBase64?: string;
}

/** 로컬 프로바이더 설정. 미지정 필드는 process.env(LOCAL_STORAGE_*)로 fallback. */
export interface LocalProviderConfig
{
    dir?: string;
    baseUrl?: string;
}

/**
 * getStorageService 옵션 — 앱의 검증된 설정(env 스키마 등)을 주입하는 경로.
 * provider 미지정 시 STORAGE_PROVIDER env, 그것도 없으면 dev=local/prod=s3.
 */
export interface StorageServiceOptions
{
    provider?: 'local' | 's3' | 'gcs';
    s3?: S3ProviderConfig;
    gcs?: GcsProviderConfig;
    local?: LocalProviderConfig;
}

export interface IStorageProvider
{
    /** 구현체의 정체. provider 위에서 도는 코드(snapshot/restore)가 provider를 import하지 않고 분기한다. */
    readonly providerKind: 'gcs' | 's3' | 'local';
    /**
     * presigned PUT URL. temp=true면 임시 업로드로 표시 — S3는 `lifecycle=temp` 태그,
     * GCS는 `tmp/<key>` prefix에 서명. 고아는 버킷 lifecycle 규칙이 정리(README 참고).
     * temp 객체는 finalizeObject 전에는 읽기가 보장되지 않는다(GCS는 최종 key에 없음).
     */
    getUploadUrl(params: PresignedUrlParams & { temp?: boolean }): Promise<PresignedUrlResult>;
    /** 공개 캐시 헤더가 붙은 presigned PUT URL. */
    getPublicUploadUrl(params: PublicUploadParams): Promise<PresignedUrlResult>;
    /** presigned GET URL(비공개 객체 다운로드용). */
    getDownloadUrl(key: string, expiresIn?: number): Promise<string>;
    /** 공개 객체의 영구 URL(서명 없이 서빙). */
    getPublicUrl(key: string): string;
    /** 서버 직접 업로드. */
    upload(key: string, body: string | Buffer, contentType: string): Promise<void>;
    /** 서버 직접 다운로드(전체를 메모리에 올린다). 객체가 없으면 StorageObjectNotFoundError. */
    download(key: string): Promise<Buffer>;
    /**
     * 스트리밍 다운로드 — 큰 객체를 메모리에 올리지 않고 프록시로 서빙하는 경로용.
     * 객체가 없으면 StorageObjectNotFoundError로 거부한다. 반환된 스트림은 호출자가
     * 반드시 소비하거나 `destroy()` 해야 한다(열린 파일 서술자·연결이 남는다).
     */
    getStream(key: string): Promise<Readable>;
    /**
     * 서버사이드 복사 — 바이트가 애플리케이션을 거치지 않는다. 원본이 없으면
     * StorageObjectNotFoundError, 대상이 이미 있으면 덮어쓴다. 원본은 남는다.
     * `sourceVersionId`를 주면 그 버전을 원본으로 삼고, 그 버전이 없으면(객체 자체가
     * 없는 경우 포함) StorageVersionNotFoundError로 거부한다.
     */
    copy(from: string, to: string, options?: StorageCopyOptions): Promise<void>;
    /**
     * 객체 한 건의 메타데이터. 객체가 없으면 StorageObjectNotFoundError.
     * `versionId`는 버전 관리가 켜진 버킷에서만, `contentHash`는 provider가 아는 경우에만 실린다.
     */
    stat(key: string): Promise<StorageObjectStat>;
    /**
     * `<prefix>/` 아래 객체를 한 페이지씩 나열한다. 경로 경계로만 매칭하므로
     * `list('gen/req-1')`은 `gen/req-10/...`을 절대 포함하지 않는다.
     * prefix 자체 키(`gen/req-1`)도 포함하지 않는다.
     */
    list(prefix: string, options?: StorageListOptions): Promise<StorageListResult>;
    /**
     * `<prefix>/` 아래 모든 객체를 삭제한다(경로 경계 매칭). prefix 자체 키는 남으므로
     * 그건 `delete(prefix)`로 지운다. 원자적이지 않다 — 진행 중 새로 올라온 객체는 남을 수 있다.
     */
    deletePrefix(prefix: string): Promise<PrefixDeleteResult>;
    /** 객체 key를 삭제한다. 존재하지 않는 객체도 성공으로 처리한다. 하위 객체는 건드리지 않는다. */
    delete(key: string): Promise<void>;
    /** 여러 객체를 삭제하고 key별 성공/실패 결과를 반환한다. */
    deleteMany?(keys: string[]): Promise<DeleteManyResult>;
    /**
     * 임시 객체를 영구화 — S3는 태그 제거, GCS는 `tmp/<key>` → `key` 이동. 멱등:
     * 이미 finalize된 key는 성공, temp·최종 어디에도 없으면(업로드 미완료) 에러.
     */
    finalizeObject(key: string): Promise<void>;
    getMaxFileSize(): number;
}

export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const DEFAULT_EXPIRES_IN = 3600;
