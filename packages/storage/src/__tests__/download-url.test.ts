import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadUrlOptions, responseHeaderQuery } from '../server/download-url';
import { GcsStorageProvider } from '../server/gcs.provider';
import { LocalStorageProvider } from '../server/local.provider';
import { S3StorageProvider } from '../server/s3.provider';
import { DEFAULT_EXPIRES_IN } from '../shared/index';

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/object') }));

const DISPOSITION = "attachment; filename*=UTF-8''report.md";

interface GcsInternals
{
    privateBucket: { file: (key: string) => { getSignedUrl: (config: Record<string, unknown>) => Promise<[string]> } };
}

describe('downloadUrlOptions', () =>
{
    it('reads a number as expiresIn and fills the default otherwise', () =>
    {
        expect(downloadUrlOptions(900)).toEqual({ expiresIn: 900 });
        expect(downloadUrlOptions(undefined)).toEqual({ expiresIn: DEFAULT_EXPIRES_IN });
        expect(downloadUrlOptions({ responseContentType: 'text/plain' }))
            .toEqual({ expiresIn: DEFAULT_EXPIRES_IN, responseContentType: 'text/plain' });
    });

    it('builds the local query only for the headers given', () =>
    {
        expect(responseHeaderQuery({})).toBe('');
        const query = new URLSearchParams(responseHeaderQuery({ responseContentDisposition: DISPOSITION }));
        expect([...query.keys()]).toEqual(['response-content-disposition']);
        expect(query.get('response-content-disposition')).toBe(DISPOSITION);
    });
});

describe('getDownloadUrl response headers', () =>
{
    afterEach(() =>
    {
        vi.clearAllMocks();
    });

    it('S3 signs ResponseContentDisposition and ResponseContentType into GetObject', async () =>
    {
        const provider = new S3StorageProvider({ bucket: 'b', region: 'us-east-1' });

        await provider.getDownloadUrl('artifacts/ws/abc', { expiresIn: 900, responseContentDisposition: DISPOSITION, responseContentType: 'text/markdown' });

        const [, command, options] = vi.mocked(getSignedUrl).mock.calls[0] as unknown as [unknown, GetObjectCommand, { expiresIn: number }];
        expect(command).toBeInstanceOf(GetObjectCommand);
        expect(command.input).toMatchObject({ Bucket: 'b', Key: 'artifacts/ws/abc', ResponseContentDisposition: DISPOSITION, ResponseContentType: 'text/markdown' });
        expect(options).toEqual({ expiresIn: 900 });
    });

    it('S3 keeps the positional expiresIn form', async () =>
    {
        const provider = new S3StorageProvider({ bucket: 'b', region: 'us-east-1' });

        await provider.getDownloadUrl('artifacts/ws/abc', 60);

        const [, command, options] = vi.mocked(getSignedUrl).mock.calls[0] as unknown as [unknown, GetObjectCommand, { expiresIn: number }];
        expect(command.input).toEqual({ Bucket: 'b', Key: 'artifacts/ws/abc', ResponseContentDisposition: undefined, ResponseContentType: undefined });
        expect(options).toEqual({ expiresIn: 60 });
    });

    it('GCS passes responseDisposition and responseType to the V4 signed URL', async () =>
    {
        const provider = new GcsStorageProvider({ publicBucket: 'pub', privateBucket: 'priv' });
        const signed = vi.fn().mockResolvedValue(['https://storage.example/signed']);
        (provider as unknown as GcsInternals).privateBucket = { file: () => ({ getSignedUrl: signed }) };

        const url = await provider.getDownloadUrl('artifacts/ws/abc', { responseContentDisposition: DISPOSITION });

        expect(url).toBe('https://storage.example/signed');
        expect(signed).toHaveBeenCalledWith(expect.objectContaining({ action: 'read', version: 'v4', responseDisposition: DISPOSITION }));
        expect(signed.mock.calls[0]?.[0]).not.toHaveProperty('responseType');
    });

    it('Local appends the headers as query parameters', async () =>
    {
        const provider = new LocalStorageProvider({ dir: '.storage-download-url-test', baseUrl: 'http://localhost:3000/storage' });

        const url = await provider.getDownloadUrl('artifacts/ws/abc', { responseContentDisposition: DISPOSITION, responseContentType: 'text/markdown' });

        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/storage/artifacts/ws/abc');
        expect(parsed.searchParams.get('response-content-disposition')).toBe(DISPOSITION);
        expect(parsed.searchParams.get('response-content-type')).toBe('text/markdown');
        expect(await provider.getDownloadUrl('artifacts/ws/abc')).toBe('http://localhost:3000/storage/artifacts/ws/abc');
    });
});
