/**
 * S3 호환(MinIO·R2·AWS S3·GCS interoperability) 실버킷 계약 — opt-in.
 *
 * 아래 env가 전부 있을 때만 돈다. 실제로 객체를 쓰고 지우므로 검증 전용 버킷을 쓴다.
 * 로컬 MinIO 예:
 *   STORAGE_CONTRACT_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   STORAGE_CONTRACT_S3_BUCKET=spfn-storage-contract \
 *   STORAGE_CONTRACT_S3_ACCESS_KEY_ID=... STORAGE_CONTRACT_S3_SECRET_ACCESS_KEY=... pnpm test
 */

import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { S3StorageProvider } from '../server/s3.provider';
import { isVersioningDeclared, registerOptInStorageProviderContract } from './provider.contract';

const ROOT = `spfn-storage-contract/${randomUUID()}`;

registerOptInStorageProviderContract(
    's3-compatible',
    ['STORAGE_CONTRACT_S3_BUCKET', 'STORAGE_CONTRACT_S3_ACCESS_KEY_ID', 'STORAGE_CONTRACT_S3_SECRET_ACCESS_KEY'],
    'STORAGE_CONTRACT_S3_VERSIONED',
    () =>
    {
        const createProvider = (): S3StorageProvider => new S3StorageProvider({
            bucket: process.env.STORAGE_CONTRACT_S3_BUCKET,
            accessKeyId: process.env.STORAGE_CONTRACT_S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.STORAGE_CONTRACT_S3_SECRET_ACCESS_KEY,
            ...(process.env.STORAGE_CONTRACT_S3_ENDPOINT ? { endpoint: process.env.STORAGE_CONTRACT_S3_ENDPOINT } : {}),
            ...(process.env.STORAGE_CONTRACT_S3_REGION ? { region: process.env.STORAGE_CONTRACT_S3_REGION } : {}),
        });

        // 최선 노력 정리 — 실패해도 계약 결과를 가리지 않는다. 버킷 lifecycle 규칙이 최종 방어선이다.
        afterAll(async () =>
        {
            await createProvider().deletePrefix(ROOT).catch(() => undefined);
        });

        return { createProvider, root: ROOT, providerKind: 's3', versioning: isVersioningDeclared('STORAGE_CONTRACT_S3_VERSIONED') };
    },
);
