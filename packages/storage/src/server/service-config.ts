/**
 * 서비스 설정의 실효값 — 옵션에 env fallback과 기본값을 적용한 결과다. provider 생성자가 이 값으로
 * 클라이언트를 만들고, 기본 서비스의 "같은 서비스인가" 비교도 같은 값을 본다. 그래서 빠진 필드와
 * `undefined`, 상대·절대 경로, env 값을 그대로 적은 옵션처럼 같은 서비스를 만드는 표기는 같게 나온다.
 * 옵션은 모두 문자열이라 값으로 비교된다.
 */

import { resolve } from 'node:path';
import type { GcsProviderConfig, LocalProviderConfig, S3ProviderConfig, StorageServiceOptions } from '../shared/index';

export interface ResolvedS3Config
{
    region: string;
    endpoint: string | undefined;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
}

export interface ResolvedGcsConfig
{
    projectId: string | undefined;
    credentials: Record<string, unknown> | null;
    publicBucket: string;
    privateBucket: string;
}

export interface ResolvedLocalConfig
{
    /** 절대 경로. */
    dir: string;
    /** 끝의 `/`를 뗀 값. */
    baseUrl: string;
}

/** 고른 provider의 설정만 담는다 — 쓰지 않는 provider의 옵션은 서비스를 바꾸지 않는다. */
export type ResolvedStorageConfig =
    | { provider: 'local'; local: ResolvedLocalConfig }
    | { provider: 'gcs'; gcs: ResolvedGcsConfig }
    | { provider: 's3'; s3: ResolvedS3Config };

/** provider 미지정 시 STORAGE_PROVIDER env, 그것도 없으면 dev=local/prod=s3. 모르는 값은 s3다. */
export function resolveStorageConfig(options: StorageServiceOptions): ResolvedStorageConfig
{
    const provider = options.provider
        ?? process.env.STORAGE_PROVIDER
        ?? (process.env.NODE_ENV === 'production' ? 's3' : 'local');
    if (provider === 'local')
    {
        return { provider, local: resolveLocalConfig(options.local) };
    }
    if (provider === 'gcs')
    {
        return { provider, gcs: resolveGcsConfig(options.gcs) };
    }

    return { provider: 's3', s3: resolveS3Config(options.s3) };
}

export function resolveS3Config(config: S3ProviderConfig = {}): ResolvedS3Config
{
    const region = config.region ?? process.env.S3_REGION ?? 'us-east-1';
    const bucket = config.bucket ?? process.env.S3_BUCKET ?? '';

    return {
        region,
        endpoint: (config.endpoint ?? process.env.S3_ENDPOINT) || undefined,
        bucket,
        accessKeyId: config.accessKeyId ?? process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: config.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY ?? '',
        publicBaseUrl: (config.publicBaseUrl ?? process.env.S3_PUBLIC_BASE_URL
            ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/, ''),
    };
}

export function resolveGcsConfig(config: GcsProviderConfig = {}): ResolvedGcsConfig
{
    return {
        projectId: (config.projectId ?? process.env.GCS_PROJECT_ID) || undefined,
        credentials: decodeCredentials(config.credentialsJsonBase64 ?? process.env.GCS_CREDENTIALS_JSON_BASE64 ?? ''),
        publicBucket: config.publicBucket ?? process.env.GCS_PUBLIC_BUCKET ?? '',
        privateBucket: config.privateBucket ?? process.env.GCS_PRIVATE_BUCKET ?? '',
    };
}

export function resolveLocalConfig(config: LocalProviderConfig = {}): ResolvedLocalConfig
{
    return {
        dir: resolve(process.cwd(), config.dir ?? process.env.LOCAL_STORAGE_DIR ?? '.storage'),
        baseUrl: (config.baseUrl ?? process.env.LOCAL_STORAGE_BASE_URL ?? '/api/storage').replace(/\/+$/, ''),
    };
}

/** 같은 JSON의 다른 인코딩(공백·키 순서)도 같은 자격 증명이 되도록 디코드한 객체로 둔다. */
function decodeCredentials(base64: string): Record<string, unknown> | null
{
    if (!base64)
    {
        return null;
    }

    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
}
