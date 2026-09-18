/**
 * GCS 네이티브 provider 실버킷 계약 — opt-in.
 *
 * 두 버킷 이름이 모두 있을 때만 돈다(계약 키는 `public/`으로 시작하지 않으므로 실제 객체는
 * private 버킷에만 생긴다). 자격증명은 `STORAGE_CONTRACT_GCS_CREDENTIALS_JSON_BASE64`가
 * 없으면 ADC(워크로드 아이덴티티 포함)를 쓴다. 검증 전용 버킷에만 걸어야 한다.
 */

import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { GcsStorageProvider } from '../server/gcs.provider';
import { isVersioningDeclared, registerOptInStorageProviderContract } from './provider.contract';

const ROOT = `spfn-storage-contract/${randomUUID()}`;

registerOptInStorageProviderContract(
    'gcs',
    ['STORAGE_CONTRACT_GCS_PRIVATE_BUCKET', 'STORAGE_CONTRACT_GCS_PUBLIC_BUCKET'],
    'STORAGE_CONTRACT_GCS_VERSIONED',
    () =>
    {
        const createProvider = (): GcsStorageProvider => new GcsStorageProvider({
            privateBucket: process.env.STORAGE_CONTRACT_GCS_PRIVATE_BUCKET,
            publicBucket: process.env.STORAGE_CONTRACT_GCS_PUBLIC_BUCKET,
            ...(process.env.STORAGE_CONTRACT_GCS_PROJECT_ID
                ? { projectId: process.env.STORAGE_CONTRACT_GCS_PROJECT_ID }
                : {}),
            ...(process.env.STORAGE_CONTRACT_GCS_CREDENTIALS_JSON_BASE64
                ? { credentialsJsonBase64: process.env.STORAGE_CONTRACT_GCS_CREDENTIALS_JSON_BASE64 }
                : {}),
        });

        // 최선 노력 정리 — 실패해도 계약 결과를 가리지 않는다. 버킷 lifecycle 규칙이 최종 방어선이다.
        afterAll(async () =>
        {
            await createProvider().deletePrefix(ROOT).catch(() => undefined);
        });

        return { createProvider, root: ROOT, providerKind: 'gcs', versioning: isVersioningDeclared('STORAGE_CONTRACT_GCS_VERSIONED') };
    },
);
