/**
 * @spfn/storage/server — 스토리지 서비스 진입점.
 *
 * provider는 env `STORAGE_PROVIDER`(`local`|`s3`|`gcs`)로 선택. 미설정이면 개발은 `local`,
 * 운영(NODE_ENV=production)은 `s3`. gcs/local은 동적 로드.
 */

import type { IStorageProvider, StorageServiceOptions } from '../shared/index';

let _service: IStorageProvider | null = null;

/** options는 최초 호출에만 적용된다(싱글턴 캐시). 앱 부트 시 한 번 주입하는 용도. */
export async function getStorageService(options: StorageServiceOptions = {}): Promise<IStorageProvider>
{
    if (_service)
    {
        return _service;
    }
    const provider = options.provider
        ?? process.env.STORAGE_PROVIDER
        ?? (process.env.NODE_ENV === 'production' ? 's3' : 'local');
    if (provider === 'local')
    {
        const { LocalStorageProvider } = await import('./local.provider');
        _service = new LocalStorageProvider(options.local);
    }
    else if (provider === 'gcs')
    {
        const { GcsStorageProvider } = await import('./gcs.provider');
        _service = new GcsStorageProvider(options.gcs);
    }
    else
    {
        const { S3StorageProvider } = await import('./s3.provider');
        _service = new S3StorageProvider(options.s3);
    }

    return _service;
}

export * from './keys';
export { assertKeyPrefix, assertObjectKey } from './object-key';
export type {
    DeleteManyResult,
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
} from '../shared/index';
export {
    DEFAULT_EXPIRES_IN,
    MAX_FILE_SIZE,
    StorageKeyError,
    StorageManifestInvalidError,
    StorageObjectNotFoundError,
    StorageVersionNotFoundError,
} from '../shared/index';
