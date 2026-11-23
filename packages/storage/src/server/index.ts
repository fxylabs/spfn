/**
 * @spfn/storage/server — 스토리지 서비스 진입점. 기본 서비스는 `getStorageService`, 추가 서비스는 `createStorageService`.
 *
 * provider는 env `STORAGE_PROVIDER`(`local`|`s3`|`gcs`)로 선택. 미설정이면 개발은 `local`,
 * 운영(NODE_ENV=production)은 `s3`. gcs/local은 동적 로드.
 */

import { isDeepStrictEqual } from 'node:util';
import { resolveStorageConfig } from './service-config';
import type { IStorageProvider, StorageServiceOptions } from '../shared/index';
import type { ResolvedStorageConfig } from './service-config';

let defaultService: Promise<IStorageProvider> | null = null;
let defaultConfig: ResolvedStorageConfig | null = null;

/**
 * 기본 서비스 — 프로세스에 하나다. options는 최초 호출에만 적용되며 앱 부트 시 한 번 주입하는 용도다.
 * 이후 options 없이 부르거나, 같은 서비스를 만드는 options로 부르면 같은 서비스를 돌려준다. "같은
 * 서비스"는 표기가 아니라 실효 설정(env fallback·기본값 적용 후, 고른 provider의 것만)으로 판단한다.
 * provider는 `local`·`gcs`가 아닌 값이면 모두 `s3`로 읽는다(`'S3'`·`''`·`'r2'`도 `s3`다).
 * SDK가 나중에 유도하는 값은 유도하지 않는다 — 생략한 GCS `projectId`(SDK가 자격 증명·환경에서 비동기로
 * 찾는다)와 적어 준 값, 끝 `/`만 다른 S3 `endpoint`는 다르게 나와 거부된다. 정확한 규칙은 README.
 * 다른 서비스를 만드는 options로 부르면 재구성하지 않고 거부한다 — 다른 버킷·provider는
 * `createStorageService`로 만든다.
 */
export async function getStorageService(options?: StorageServiceOptions): Promise<IStorageProvider>
{
    if (defaultService === null)
    {
        defaultConfig = resolveStorageConfig(options ?? {});
        defaultService = createStorageService(options ?? {}).catch((error: unknown) =>
        {
            defaultService = null;
            throw error;
        });
    }
    else if (options !== undefined && !isDeepStrictEqual(resolveStorageConfig(options), defaultConfig))
    {
        throw new Error(
            'getStorageService() was called with options that configure a different service than the default one '
            + 'was created with; it never reconfigures. Use createStorageService(options) for another bucket or provider.',
        );
    }

    return defaultService;
}

/**
 * 독립된 서비스를 새로 만든다 — 기본 서비스와 상태(클라이언트·버킷·루트)를 공유하지 않는다.
 * 두 번째 버킷(보존 정책·권한·provider가 다른 기록용 버킷 등)에 쓴다. 호출마다 새 인스턴스다.
 */
export async function createStorageService(options: StorageServiceOptions): Promise<IStorageProvider>
{
    const { provider } = resolveStorageConfig(options);
    if (provider === 'local')
    {
        const { LocalStorageProvider } = await import('./local.provider');

        return new LocalStorageProvider(options.local);
    }
    if (provider === 'gcs')
    {
        const { GcsStorageProvider } = await import('./gcs.provider');

        return new GcsStorageProvider(options.gcs);
    }
    const { S3StorageProvider } = await import('./s3.provider');

    return new S3StorageProvider(options.s3);
}

export * from './keys';
export { assertKeyPrefix, assertObjectKey } from './object-key';
export { parseManifest, restoreManifest, serializeManifest, snapshotPrefix } from './snapshot-restore';
export type { RestoreOptions, SnapshotOptions } from './snapshot-restore';
export type {
    DeleteManyResult,
    DownloadUrlOptions,
    GcsProviderConfig,
    IStorageProvider,
    LocalProviderConfig,
    Manifest,
    ManifestEntry,
    PrefixDeleteResult,
    PresignedUrlParams,
    PublicUploadParams,
    PresignedUrlResult,
    RestoreResult,
    S3ProviderConfig,
    StorageCopyOptions,
    StorageListOptions,
    StorageListResult,
    StorageObject,
    StorageObjectStat,
    StorageServiceOptions,
    StorageUploadOptions,
} from '../shared/index';
export {
    DEFAULT_EXPIRES_IN,
    MAX_FILE_SIZE,
    StorageKeyError,
    StorageManifestInvalidError,
    StorageObjectExistsError,
    StorageObjectNotFoundError,
    StorageVersionNotFoundError,
    StorageWriteOutcomeUnknownError,
} from '../shared/index';
