import { Readable } from 'node:stream';
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3StorageProvider } from '../server/s3.provider';
import { StorageObjectNotFoundError, StorageVersionNotFoundError } from '../shared/index';

describe('S3StorageProvider deletion', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('uses DeleteObject and treats an empty provider response as success', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const provider = new S3StorageProvider();

        await provider.delete('public/card.webp');

        const command = send.mock.calls[0]?.[0];
        expect(command).toBeInstanceOf(DeleteObjectCommand);
        expect((command as DeleteObjectCommand).input).toMatchObject({ Key: 'public/card.webp' });
    });

    it('propagates DeleteObject provider errors', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('provider unavailable') as never);
        const provider = new S3StorageProvider();

        await expect(provider.delete('card.webp')).rejects.toThrow('provider unavailable');
    });

    it('rejects URLs before sending a provider command', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const provider = new S3StorageProvider();

        await expect(provider.delete('https://cdn.example.com/card.webp')).rejects.toThrow(
            'requires a storage key',
        );
        expect(send).not.toHaveBeenCalled();
    });

    it('uses DeleteObjects and reports per-key errors', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            Errors: [{ Key: 'failed.webp', Code: 'AccessDenied', Message: 'denied' }],
        } as never);
        const provider = new S3StorageProvider();

        await expect(provider.deleteMany(['deleted.webp', 'failed.webp'])).resolves.toEqual({
            deleted: ['deleted.webp'],
            failed: [{ key: 'failed.webp', error: 'AccessDenied: denied' }],
        });
        expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectsCommand);
    });

    it('returns all keys as failed when a batch request rejects', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('network error') as never);
        const provider = new S3StorageProvider();

        await expect(provider.deleteMany(['one', 'two'])).resolves.toEqual({
            deleted: [],
            failed: [
                { key: 'one', error: 'network error' },
                { key: 'two', error: 'network error' },
            ],
        });
    });
});

describe('S3StorageProvider presigned upload size limits', () =>
{
    const provider = new S3StorageProvider({
        region: 'us-east-1',
        bucket: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
    });

    it('signs content-length when contentLength is given and returns it as a required header', async () =>
    {
        const result = await provider.getUploadUrl({ key: 'private/a.webp', contentType: 'image/webp', contentLength: 1234 });

        expect(signedHeaders(result.uploadUrl)).toContain('content-length');
        expect(result.requiredHeaders).toMatchObject({ 'content-length': '1234' });
    });

    it('does not sign content-length for maxBytes alone (not enforceable on presigned PUT)', async () =>
    {
        const result = await provider.getUploadUrl({ key: 'private/a.webp', contentType: 'image/webp', maxBytes: 10485760 });

        expect(signedHeaders(result.uploadUrl)).not.toContain('content-length');
        expect(result).not.toHaveProperty('requiredHeaders');
    });

    it('returns tagging and cache-control required headers for public uploads', async () =>
    {
        const result = await provider.getPublicUploadUrl({ key: 'public/a.webp', contentType: 'image/webp', contentLength: 99 });

        expect(signedHeaders(result.uploadUrl)).toContain('content-length');
        expect(result.requiredHeaders).toEqual({
            'cache-control': 'public, max-age=2592000, immutable',
            'x-amz-tagging': 'lifecycle=temp',
            'content-length': '99',
        });
    });

    it('rejects invalid size limits before signing', async () =>
    {
        await expect(provider.getUploadUrl({ key: 'a', contentType: 'image/webp', contentLength: 1.5 }))
            .rejects.toThrow('contentLength must be a positive integer');
    });
});

describe('S3StorageProvider server-side copy', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('URL-encodes CopySource so keys with reserved characters copy intact', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await provider.copy('gen/req 1/a+b?c#d.png', 'confirmed/asset.png');

        const command = send.mock.calls[0]?.[0] as CopyObjectCommand;
        expect(command).toBeInstanceOf(CopyObjectCommand);
        expect(command.input.CopySource).toBe('assets/gen/req%201/a%2Bb%3Fc%23d.png');
        expect(command.input.Key).toBe('confirmed/asset.png');
    });

    it('normalizes a NoSuchKey source error to the not-found contract error', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(namedError('NoSuchKey') as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await expect(provider.copy('gen/missing.png', 'confirmed/asset.png'))
            .rejects.toMatchObject({ name: 'StorageObjectNotFoundError', key: 'gen/missing.png' });
    });

    it('normalizes a bare 404 status to the not-found contract error', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(statusError(404) as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await expect(provider.copy('gen/missing.png', 'confirmed/asset.png'))
            .rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('propagates non-404 copy failures unchanged', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(statusError(403) as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await expect(provider.copy('gen/a.png', 'confirmed/a.png')).rejects.not.toBeInstanceOf(StorageObjectNotFoundError);
    });
});

describe('S3StorageProvider streaming download', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('returns the response body as a stream', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: Readable.from(['chunk']) } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        const stream = await provider.getStream('gen/a.png');

        expect(stream.read().toString()).toBe('chunk');
    });

    it('normalizes NoSuchKey and an empty body to the not-found contract error', async () =>
    {
        const provider = new S3StorageProvider({ bucket: 'assets' });
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(namedError('NoSuchKey') as never);
        await expect(provider.getStream('gen/a.png')).rejects.toBeInstanceOf(StorageObjectNotFoundError);

        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        await expect(provider.download('gen/a.png')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });
});

describe('S3StorageProvider prefix listing and cleanup', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('lists on the path boundary and maps the continuation token to a cursor', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            Contents: [{ Key: 'gen/req-1/a.png', Size: 3, LastModified: new Date('2026-07-27T00:00:00Z') }],
            IsTruncated: true,
            NextContinuationToken: 'token-2',
        } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        const listed = await provider.list('gen/req-1', { maxKeys: 1, cursor: 'token-1' });

        const command = send.mock.calls[0]?.[0] as ListObjectsV2Command;
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        expect(command.input).toMatchObject({ Prefix: 'gen/req-1/', MaxKeys: 1, ContinuationToken: 'token-1' });
        expect(listed).toEqual({
            objects: [{ key: 'gen/req-1/a.png', size: 3, lastModified: new Date('2026-07-27T00:00:00Z') }],
            cursor: 'token-2',
        });
    });

    it('drops the cursor when the provider reports a complete listing', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            Contents: [{ Key: 'gen/req-1/a.png' }],
            IsTruncated: false,
            NextContinuationToken: 'stale-token',
        } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        expect(await provider.list('gen/req-1')).toEqual({ objects: [{ key: 'gen/req-1/a.png', size: 0 }] });
    });

    it('deletes a prefix key by key across pages, never with DeleteObjects', async () =>
    {
        const pages = [
            { Contents: [{ Key: 'gen/req-1/a.png' }], IsTruncated: true, NextContinuationToken: 'token-2' },
            { Contents: [{ Key: 'gen/req-1/b.png' }], IsTruncated: false },
        ];
        const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((command: unknown) =>
            Promise.resolve(command instanceof ListObjectsV2Command ? pages.shift() : {}) as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        expect(await provider.deletePrefix('gen/req-1')).toEqual({ deleted: 2, failed: [] });

        const commands = send.mock.calls.map(call => call[0]);
        expect(commands.some(command => command instanceof DeleteObjectsCommand)).toBe(false);
        expect(commands.filter(command => command instanceof DeleteObjectCommand)
            .map(command => (command as DeleteObjectCommand).input.Key))
            .toEqual(['gen/req-1/a.png', 'gen/req-1/b.png']);
    });

    it('reports per-key deletion failures without throwing', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockImplementation((command: unknown) =>
        {
            if (command instanceof ListObjectsV2Command)
            {
                return Promise.resolve({ Contents: [{ Key: 'gen/req-1/a.png' }], IsTruncated: false }) as never;
            }

            return Promise.reject(new Error('access denied')) as never;
        });
        const provider = new S3StorageProvider({ bucket: 'assets' });

        expect(await provider.deletePrefix('gen/req-1')).toEqual({
            deleted: 0,
            failed: [{ key: 'gen/req-1/a.png', error: 'access denied' }],
        });
    });

    it('rejects an empty prefix before listing anything', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await expect(provider.deletePrefix('')).rejects.toThrow('Invalid storage prefix');
        expect(send).not.toHaveBeenCalled();
    });
});

describe('S3StorageProvider stat', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('maps HeadObject to the stat contract, dropping the ETag quotes', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            ContentLength: 3,
            LastModified: new Date('2026-07-27T00:00:00Z'),
            ETag: '"9a0364b9e99bb480dd25e1f0284c8555"',
            VersionId: 'v-1',
        } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        expect(await provider.stat('gen/req-1/a.png')).toEqual({
            key: 'gen/req-1/a.png',
            size: 3,
            lastModified: new Date('2026-07-27T00:00:00Z'),
            etag: '9a0364b9e99bb480dd25e1f0284c8555',
            contentHash: '9a0364b9e99bb480dd25e1f0284c8555',
            versionId: 'v-1',
        });
    });

    it('leaves contentHash undefined for a multipart ETag (5a: S3 multipart ETag …-N)', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            ContentLength: 8388608,
            ETag: '"9a0364b9e99bb480dd25e1f0284c8555-3"',
            VersionId: 'v-1',
        } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        const stat = await provider.stat('gen/req-1/big.bin');

        expect(stat.contentHash).toBeUndefined();
        expect(stat.etag).toBe('9a0364b9e99bb480dd25e1f0284c8555-3');
        expect(stat.versionId).toBe('v-1');
    });

    it('drops the "null" version id (5d: 버전 관리 이전 객체)', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 1, VersionId: 'null' } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        expect((await provider.stat('gen/req-1/old.png')).versionId).toBeUndefined();
    });

    it('rejects a missing object with the not-found contract error (5a: 없는 객체)', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(namedError('NotFound') as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await expect(provider.stat('gen/missing.png')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('uses HeadObject, never a version listing', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 1 } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await provider.stat('gen/req-1/a.png');

        expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    });
});

describe('S3StorageProvider versioned copy', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('appends ?versionId= after segment encoding (5b: req 1/a+b?c#d.png + versionId)', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await provider.copy('gen/req 1/a+b?c#d.png', 'confirmed/asset.png', { sourceVersionId: 'v 1/2' });

        const command = send.mock.calls[0]?.[0] as CopyObjectCommand;
        expect(command.input.CopySource).toBe('assets/gen/req%201/a%2Bb%3Fc%23d.png?versionId=v%201%2F2');
    });

    it('keeps the unversioned CopySource unchanged (5b: 옵션 없음 — 회귀)', async () =>
    {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await provider.copy('gen/req-1/a.png', 'confirmed/asset.png');

        expect((send.mock.calls[0]?.[0] as CopyObjectCommand).input.CopySource).toBe('assets/gen/req-1/a.png');
    });

    it('folds NoSuchVersion, 404 and InvalidArgument into the version error (5b: 존재하지 않는 versionId)', async () =>
    {
        const provider = new S3StorageProvider({ bucket: 'assets' });
        for (const error of [namedError('NoSuchVersion'), statusError(404), namedError('InvalidArgument')])
        {
            vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(error as never);

            await expect(provider.copy('gen/a.png', 'confirmed/a.png', { sourceVersionId: 'v-1' }))
                .rejects.toBeInstanceOf(StorageVersionNotFoundError);
        }
    });

    it('propagates an unrelated failure of a versioned copy', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(statusError(403) as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        await expect(provider.copy('gen/a.png', 'confirmed/a.png', { sourceVersionId: 'v-1' }))
            .rejects.not.toBeInstanceOf(StorageVersionNotFoundError);
    });
});

describe('S3StorageProvider list metadata', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('carries the ETag and never a version id (ListObjectsV2 does not return one)', async () =>
    {
        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            Contents: [{ Key: 'gen/req-1/a.png', Size: 3, ETag: '"abc"' }],
        } as never);
        const provider = new S3StorageProvider({ bucket: 'assets' });

        const [object] = (await provider.list('gen/req-1')).objects;

        expect(object).toEqual({ key: 'gen/req-1/a.png', size: 3, etag: 'abc' });
    });
});

function namedError(name: string): Error
{
    return Object.assign(new Error(name), { name });
}

function statusError(httpStatusCode: number): Error
{
    return Object.assign(new Error(`http ${httpStatusCode}`), { $metadata: { httpStatusCode } });
}

function signedHeaders(uploadUrl: string): string[]
{
    return (new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
}
