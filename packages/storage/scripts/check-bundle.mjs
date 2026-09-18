/**
 * 번들 회귀 방어 — 오류 클래스가 엔트리마다 복제되면 `error instanceof StorageObjectNotFoundError`가
 * 엔트리를 가로지를 때 조용히 false가 된다(예: 타입은 `@spfn/storage`에서, provider는
 * `@spfn/storage/server`에서 가져오는 흔한 조합). tsup의 코드 분할이 깨지면 여기서 빌드를 멈춘다.
 */

import { GcsStorageProvider } from '../dist/server/gcs.provider.js';
import { LocalStorageProvider } from '../dist/server/local.provider.js';
import { S3StorageProvider } from '../dist/server/s3.provider.js';
import * as serverEntry from '../dist/server/index.js';
import * as sharedEntry from '../dist/shared/index.js';

const failures = [];

const errorNames = [
    'StorageKeyError',
    'StorageManifestInvalidError',
    'StorageObjectNotFoundError',
    'StorageVersionNotFoundError',
];

for (const name of errorNames)
{
    if (sharedEntry[name] !== serverEntry[name])
    {
        failures.push(`${name} differs between the shared and server entry points`);
    }
}

// 세 provider 모두 빈 프리픽스를 거부하므로 네트워크 없이 실제 오류 동일성을 확인할 수 있다.
const providers = [
    ['local', new LocalStorageProvider({ dir: '.storage-bundle-check' })],
    ['s3', new S3StorageProvider({ bucket: 'bundle-check' })],
    ['gcs', new GcsStorageProvider({ publicBucket: 'bundle-check', privateBucket: 'bundle-check' })],
];

for (const [name, provider] of providers)
{
    const error = await provider.deletePrefix('').then(() => null, thrown => thrown);
    if (!(error instanceof sharedEntry.StorageKeyError))
    {
        failures.push(`${name} provider throws a StorageKeyError that fails instanceof against the shared entry`);
    }
}

if (failures.length > 0)
{
    console.error('Bundle check failed:');
    for (const failure of failures)
    {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

console.log('Bundle check passed: one error-class identity across every entry point.');
