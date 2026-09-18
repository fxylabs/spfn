/**
 * 계약 스위트의 상시 실행 경로. env gate가 없으므로 조용히 건너뛸 수 없다 —
 * opt-in provider(S3·GCS)가 꺼져 있어도 이 파일이 계약 전체를 매 실행 검증한다.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { LocalStorageProvider } from '../server/local.provider';
import { registerStorageProviderContract } from './provider.contract';

let storageRoot: string;

beforeAll(async () =>
{
    storageRoot = await mkdtemp(join(tmpdir(), 'spfn-storage-contract-'));
});

afterAll(async () =>
{
    await rm(storageRoot, { recursive: true, force: true });
});

registerStorageProviderContract('local', {
    createProvider: () => new LocalStorageProvider({ dir: storageRoot }),
    root: 'contract',
    providerKind: 'local',
    // 로컬 파일시스템에는 객체 버전이 없다 — 버전 행은 돌지 않고 성능 저하 행이 이 경로를 덮는다.
    versioning: false,
});
