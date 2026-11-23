import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GcsStorageProvider } from '../server/gcs.provider';
import { StorageObjectNotFoundError, StorageVersionNotFoundError } from '../shared/index';
import { startConditionalWriteEndpoint } from './conditional-write-endpoint';
import type { ConditionalWriteDialect, ConditionalWriteEndpoint } from './conditional-write-endpoint';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface TestProviderInternals
{
    publicBucket: { file: (key: string) => { delete: (options: { ignoreNotFound: boolean }) => Promise<unknown> } };
    privateBucket: { file: (key: string) => { delete: (options: { ignoreNotFound: boolean }) => Promise<unknown> } };
}

describe('GcsStorageProvider deletion', () =>
{
    let previousPublicBucket: string | undefined;
    let previousPrivateBucket: string | undefined;

    beforeEach(() =>
    {
        previousPublicBucket = process.env.GCS_PUBLIC_BUCKET;
        previousPrivateBucket = process.env.GCS_PRIVATE_BUCKET;
        process.env.GCS_PUBLIC_BUCKET = 'public-test-bucket';
        process.env.GCS_PRIVATE_BUCKET = 'private-test-bucket';
    });

    afterEach(() =>
    {
        restoreEnv('GCS_PUBLIC_BUCKET', previousPublicBucket);
        restoreEnv('GCS_PRIVATE_BUCKET', previousPrivateBucket);
        vi.restoreAllMocks();
    });

    it('deletes from the bucket selected by key and ignores not found', async () =>
    {
        const deleteObject = vi.fn().mockResolvedValue([]);
        const provider = providerWithDelete(deleteObject);

        await provider.delete('public/card.webp');

        expect(deleteObject).toHaveBeenCalledWith({ ignoreNotFound: true });
    });

    it('propagates provider errors', async () =>
    {
        const deleteObject = vi.fn().mockRejectedValue(new Error('gcs unavailable'));
        const provider = providerWithDelete(deleteObject);

        await expect(provider.delete('private/card.webp')).rejects.toThrow('gcs unavailable');
    });

    it('rejects URLs before calling GCS', async () =>
    {
        const deleteObject = vi.fn().mockResolvedValue([]);
        const provider = providerWithDelete(deleteObject);

        await expect(provider.delete('https://storage.googleapis.com/bucket/card.webp')).rejects.toThrow(
            'requires a storage key',
        );
        expect(deleteObject).not.toHaveBeenCalled();
    });

    it('returns partial batch results', async () =>
    {
        const deleteObject = vi.fn().mockImplementation((options: { ignoreNotFound: boolean }) =>
        {
            expect(options).toEqual({ ignoreNotFound: true });
            if (deleteObject.mock.calls.length === 2)
            {
                return Promise.reject(new Error('denied'));
            }

            return Promise.resolve([]);
        });
        const provider = providerWithDelete(deleteObject);

        await expect(provider.deleteMany(['one', 'two'])).resolves.toEqual({
            deleted: ['one'],
            failed: [{ key: 'two', error: 'denied' }],
        });
    });
});

describe('GcsStorageProvider presigned upload size limits', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('signs x-goog-content-length-range 0,max for maxBytes and returns it as a required header', async () =>
    {
        const getSignedUrl = vi.fn().mockResolvedValue(['https://signed.example']);
        const provider = providerWithSignedUrl(getSignedUrl);

        const result = await provider.getUploadUrl({ key: 'private/a.webp', contentType: 'image/webp', maxBytes: 10485760 });

        expect(getSignedUrl.mock.calls[0]?.[0]).toMatchObject({
            extensionHeaders: { 'x-goog-content-length-range': '0,10485760' },
        });
        expect(result.requiredHeaders).toEqual({ 'x-goog-content-length-range': '0,10485760' });
    });

    it('signs an exact range for contentLength', async () =>
    {
        const getSignedUrl = vi.fn().mockResolvedValue(['https://signed.example']);
        const provider = providerWithSignedUrl(getSignedUrl);

        const result = await provider.getUploadUrl({ key: 'private/a.webp', contentType: 'image/webp', contentLength: 1234 });

        expect(result.requiredHeaders).toEqual({ 'x-goog-content-length-range': '1234,1234' });
    });

    it('omits size headers and requiredHeaders when no limit is given', async () =>
    {
        const getSignedUrl = vi.fn().mockResolvedValue(['https://signed.example']);
        const provider = providerWithSignedUrl(getSignedUrl);

        const result = await provider.getUploadUrl({ key: 'private/a.webp', contentType: 'image/webp' });

        expect(getSignedUrl.mock.calls[0]?.[0]).not.toHaveProperty('extensionHeaders');
        expect(result).not.toHaveProperty('requiredHeaders');
    });

    it('includes cache-control and the size range in public upload required headers', async () =>
    {
        const getSignedUrl = vi.fn().mockResolvedValue(['https://signed.example']);
        const provider = providerWithSignedUrl(getSignedUrl);

        const result = await provider.getPublicUploadUrl({ key: 'public/a.webp', contentType: 'image/webp', maxBytes: 512 });

        expect(result.requiredHeaders).toEqual({
            'cache-control': 'public, max-age=2592000, immutable',
            'x-goog-content-length-range': '0,512',
        });
    });

    it('rejects invalid size limits before signing', async () =>
    {
        const getSignedUrl = vi.fn().mockResolvedValue(['https://signed.example']);
        const provider = providerWithSignedUrl(getSignedUrl);

        await expect(provider.getUploadUrl({ key: 'a', contentType: 'image/webp', maxBytes: -1 }))
            .rejects.toThrow('maxBytes must be a positive integer');
        await expect(provider.getUploadUrl({ key: 'a', contentType: 'image/webp', maxBytes: 10, contentLength: 11 }))
            .rejects.toThrow('exceeds maxBytes');
        expect(getSignedUrl).not.toHaveBeenCalled();
    });
});

describe('GcsStorageProvider temp upload and finalize', () =>
{
    it('signs tmp/<key> for temp uploads and keeps the final key in the result', async () =>
    {
        const getSignedUrl = vi.fn().mockResolvedValue(['https://signed.example']);
        const { provider, file } = providerWithFiles({ getSignedUrl });

        const result = await provider.getUploadUrl({ key: 'private/a.webp', contentType: 'image/webp', temp: true });

        expect(file).toHaveBeenCalledWith('tmp/private/a.webp');
        expect(result.key).toBe('private/a.webp');
    });

    it('signs the final key directly without temp', async () =>
    {
        const getSignedUrl = vi.fn().mockResolvedValue(['https://signed.example']);
        const { provider, file } = providerWithFiles({ getSignedUrl });

        await provider.getUploadUrl({ key: 'private/a.webp', contentType: 'image/webp' });

        expect(file).toHaveBeenCalledWith('private/a.webp');
    });

    it('finalizeObject moves tmp/<key> to the final key', async () =>
    {
        const move = vi.fn().mockResolvedValue([]);
        const { provider, file } = providerWithFiles({ move });

        await provider.finalizeObject('private/a.webp');

        expect(file).toHaveBeenCalledWith('tmp/private/a.webp');
        expect(move).toHaveBeenCalledWith('private/a.webp');
    });

    it('finalizeObject succeeds when already finalized', async () =>
    {
        const move = vi.fn().mockRejectedValue(notFoundError());
        const exists = vi.fn().mockResolvedValue([true]);
        const { provider } = providerWithFiles({ move, exists });

        await expect(provider.finalizeObject('private/a.webp')).resolves.toBeUndefined();
    });

    it('finalizeObject rejects when neither temp nor final object exists', async () =>
    {
        const move = vi.fn().mockRejectedValue(notFoundError());
        const exists = vi.fn().mockResolvedValue([false]);
        const { provider } = providerWithFiles({ move, exists });

        await expect(provider.finalizeObject('private/a.webp')).rejects.toMatchObject({ code: 404 });
    });

    it('finalizeObject propagates non-404 move errors without an existence check', async () =>
    {
        const move = vi.fn().mockRejectedValue(new Error('gcs unavailable'));
        const exists = vi.fn();
        const { provider } = providerWithFiles({ move, exists });

        await expect(provider.finalizeObject('private/a.webp')).rejects.toThrow('gcs unavailable');
        expect(exists).not.toHaveBeenCalled();
    });
});

describe('GcsStorageProvider server-side copy', () =>
{
    it('rewrites into the bucket that owns the destination key', async () =>
    {
        const copy = vi.fn().mockResolvedValue([]);
        const { provider, publicFile, privateFile } = providerWithBuckets({ copy }, {});

        await provider.copy('gen/req-1/a.png', 'public/confirmed/a.png');

        expect(privateFile).toHaveBeenCalledWith('gen/req-1/a.png');
        expect(publicFile).toHaveBeenCalledWith('public/confirmed/a.png');
        expect(copy).toHaveBeenCalledWith(expect.anything(), {});
    });

    it('normalizes a 404 source error to the not-found contract error', async () =>
    {
        const copy = vi.fn().mockRejectedValue(notFoundError());
        const { provider } = providerWithFiles({ copy });

        await expect(provider.copy('gen/missing.png', 'confirmed/a.png'))
            .rejects.toMatchObject({ name: 'StorageObjectNotFoundError', key: 'gen/missing.png' });
    });

    it('propagates non-404 copy failures unchanged', async () =>
    {
        const copy = vi.fn().mockRejectedValue(new Error('gcs unavailable'));
        const { provider } = providerWithFiles({ copy });

        await expect(provider.copy('gen/a.png', 'confirmed/a.png')).rejects.toThrow('gcs unavailable');
    });
});

// 실제 SDK와 HTTP로(STORAGE_EMULATOR_HOST) — 재시도는 SDK 인스턴스 설정에 달려 있어 파일 스텁으로는 보이지 않는다.
describe('GcsStorageProvider create-only writes against an endpoint that loses the first response', () =>
{
    const key = 'log/000001.json';
    const writes = {
        upload: (provider: GcsStorageProvider) => provider.upload(key, '{}', 'application/json', { ifAbsent: true }),
        copy: (provider: GcsStorageProvider) => provider.copy('staging/a.json', key, { ifAbsent: true }),
    };
    let endpoint: ConditionalWriteEndpoint | undefined;
    let previousEmulatorHost: string | undefined;

    beforeEach(() =>
    {
        previousEmulatorHost = process.env.STORAGE_EMULATOR_HOST;
    });

    afterEach(async () =>
    {
        restoreEnv('STORAGE_EMULATOR_HOST', previousEmulatorHost);
        await endpoint?.close();
    });

    it.each(Object.entries(writes))('%s: sends the write once and reports the outcome as unknown', async (_name, write) =>
    {
        endpoint = await startConditionalWriteEndpoint(GCS_DIALECT);

        await expect(write(providerAt(endpoint.url))).rejects.toMatchObject({ name: 'StorageWriteOutcomeUnknownError', key });
        expect(endpoint.writes).toEqual([key]);
    });

    it.each(Object.entries(writes))('%s: rejects a key taken before the request with the exists error', async (_name, write) =>
    {
        endpoint = await startConditionalWriteEndpoint(GCS_DIALECT, [key]);

        await expect(write(providerAt(endpoint.url))).rejects.toMatchObject({ name: 'StorageObjectExistsError', key });
        expect(endpoint.writes).toEqual([key]);
    });
});

// 실제 SDK와 HTTP로 — redirect는 SDK 안(node-fetch)에서 따라가 파일 스텁으로는 보이지 않는다. node-fetch는
// 303은 언제나, 307은 다시 보낼 수 있는 본문일 때만 따라간다: upload의 multipart 본문은 스트림, rewrite는 JSON 문자열이다.
describe('GcsStorageProvider create-only writes whose redirected connection fails', () =>
{
    const writes = {
        upload: [303, (provider: GcsStorageProvider) => provider.upload('log/000001.json', '{}', 'application/json', { ifAbsent: true })],
        copy: [307, (provider: GcsStorageProvider) => provider.copy('staging/a.json', 'log/000001.json', { ifAbsent: true })],
    } as const;
    let endpoint: Server | undefined;
    let previousEmulatorHost: string | undefined;

    beforeEach(() =>
    {
        previousEmulatorHost = process.env.STORAGE_EMULATOR_HOST;
    });

    afterEach(async () =>
    {
        restoreEnv('STORAGE_EMULATOR_HOST', previousEmulatorHost);
        await new Promise(resolve => endpoint?.close(resolve) ?? resolve(undefined));
    });

    it.each(Object.entries(writes))('%s: a refused connection after a redirect is an unknown outcome', async (_name, [status, write]) =>
    {
        const received: string[] = [];
        endpoint = await startRedirectingEndpoint(status, received);

        await expect(write(providerAt(urlOf(endpoint)))).rejects.toMatchObject({ name: 'StorageWriteOutcomeUnknownError' });
        expect(received).toHaveLength(1);
    });
});

describe('GcsStorageProvider streaming download', () =>
{
    it('returns a stream for an existing object', async () =>
    {
        const createReadStream = vi.fn().mockImplementation(() => Readable.from(['chunk']));
        const { provider } = providerWithFiles({ createReadStream });

        const stream = await provider.getStream('gen/a.png');

        expect((await collect(stream)).toString()).toBe('chunk');
    });

    it('turns a 404 stream error into the not-found contract error', async () =>
    {
        const createReadStream = vi.fn().mockImplementation(() => failingStream(notFoundError()));
        const { provider } = providerWithFiles({ createReadStream });

        await expect(provider.getStream('gen/missing.png')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('propagates a non-404 stream error unchanged', async () =>
    {
        const createReadStream = vi.fn().mockImplementation(() => failingStream(new Error('connection reset')));
        const { provider } = providerWithFiles({ createReadStream });

        await expect(provider.getStream('gen/a.png')).rejects.toThrow('connection reset');
    });

    it('normalizes a 404 on buffered download too', async () =>
    {
        const download = vi.fn().mockRejectedValue(notFoundError());
        const { provider } = providerWithFiles({ download });

        await expect(provider.download('gen/missing.png')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });
});

describe('GcsStorageProvider prefix listing and cleanup', () =>
{
    it('lists on the path boundary and maps the page token to a cursor', async () =>
    {
        const getFiles = vi.fn().mockResolvedValue([
            [{ name: 'gen/req-1/a.png', metadata: { size: '3', updated: '2026-07-27T00:00:00.000Z' } }],
            { pageToken: 'token-2' },
        ]);
        const provider = providerWithGetFiles(getFiles);

        const listed = await provider.list('gen/req-1', { maxKeys: 1, cursor: 'token-1' });

        expect(getFiles).toHaveBeenCalledWith({
            prefix: 'gen/req-1/',
            maxResults: 1,
            autoPaginate: false,
            pageToken: 'token-1',
        });
        expect(listed).toEqual({
            objects: [{ key: 'gen/req-1/a.png', size: 3, lastModified: new Date('2026-07-27T00:00:00.000Z') }],
            cursor: 'token-2',
        });
    });

    it('drops the cursor on the last page', async () =>
    {
        const getFiles = vi.fn().mockResolvedValue([[{ name: 'gen/req-1/a.png', metadata: {} }], null]);
        const provider = providerWithGetFiles(getFiles);

        expect(await provider.list('gen/req-1')).toEqual({ objects: [{ key: 'gen/req-1/a.png', size: 0 }] });
    });

    it('deletes a prefix key by key across pages', async () =>
    {
        const pages = [
            [[{ name: 'gen/req-1/a.png', metadata: {} }], { pageToken: 'token-2' }],
            [[{ name: 'gen/req-1/b.png', metadata: {} }], null],
        ];
        const deleteObject = vi.fn().mockResolvedValue([]);
        const file = vi.fn().mockReturnValue({ delete: deleteObject });
        const provider = new GcsStorageProvider({ publicBucket: 'public-test', privateBucket: 'private-test' });
        const bucket = { file, getFiles: vi.fn().mockImplementation(() => Promise.resolve(pages.shift())) };
        Object.assign(provider as unknown as Record<string, unknown>, { publicBucket: bucket, privateBucket: bucket });

        expect(await provider.deletePrefix('gen/req-1')).toEqual({ deleted: 2, failed: [] });
        expect(file.mock.calls.map(call => call[0])).toEqual(['gen/req-1/a.png', 'gen/req-1/b.png']);
    });

    it('rejects an empty prefix before calling GCS', async () =>
    {
        const getFiles = vi.fn();
        const provider = providerWithGetFiles(getFiles);

        await expect(provider.deletePrefix('')).rejects.toThrow('Invalid storage prefix');
        expect(getFiles).not.toHaveBeenCalled();
    });
});

describe('GcsStorageProvider stat and version metadata', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('normalizes a numeric generation to a string versionId and md5Hash to hex', async () =>
    {
        const getMetadata = vi.fn().mockResolvedValue([{
            size: '3',
            updated: '2026-07-27T00:00:00.000Z',
            etag: 'CJm',
            generation: 1758153600000001,
            md5Hash: 'mgNkuemftIDdJeHwKEyFVQ==',
        }]);
        const { provider } = providerWithFiles({ getMetadata });

        expect(await provider.stat('gen/req-1/a.png')).toEqual({
            key: 'gen/req-1/a.png',
            size: 3,
            lastModified: new Date('2026-07-27T00:00:00.000Z'),
            etag: 'CJm',
            versionId: '1758153600000001',
            contentHash: '9a0364b9e99fb480dd25e1f0284c8555',
        });
    });

    it('leaves contentHash undefined for a composite object (5a: GCS composite 객체)', async () =>
    {
        const getMetadata = vi.fn().mockResolvedValue([{ size: '9', generation: '17', componentCount: 2 }]);
        const { provider } = providerWithFiles({ getMetadata });

        const stat = await provider.stat('gen/req-1/composite.bin');

        expect(stat.contentHash).toBeUndefined();
        expect(stat).toMatchObject({ size: 9, versionId: '17' });
    });

    it('rejects a missing object with the not-found contract error (5a: 없는 객체)', async () =>
    {
        const getMetadata = vi.fn().mockRejectedValue(notFoundError());
        const { provider } = providerWithFiles({ getMetadata });

        await expect(provider.stat('gen/missing.png')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('carries generation, etag and md5Hash through list', async () =>
    {
        const getFiles = vi.fn().mockResolvedValue([
            [{
                name: 'gen/req-1/a.png',
                metadata: { size: '3', generation: 17, etag: 'CJm', md5Hash: 'mgNkuemftIDdJeHwKEyFVQ==' },
            }],
            null,
        ]);
        const provider = providerWithGetFiles(getFiles);

        expect((await provider.list('gen/req-1')).objects).toEqual([{
            key: 'gen/req-1/a.png',
            size: 3,
            etag: 'CJm',
            versionId: '17',
            contentHash: '9a0364b9e99fb480dd25e1f0284c8555',
        }]);
    });

    it('asks getFiles for neither versions nor softDeleted (5c: noncurrent 존재 — getFiles query 단언)', async () =>
    {
        const getFiles = vi.fn().mockResolvedValue([[], null]);
        const provider = providerWithGetFiles(getFiles);

        await provider.list('gen/req-1', { maxKeys: 10 });

        const query = getFiles.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(query).toEqual({ prefix: 'gen/req-1/', maxResults: 10, autoPaginate: false });
        expect(query).not.toHaveProperty('versions');
        expect(query).not.toHaveProperty('softDeleted');
    });

    it('scopes a versioned copy to the generation and folds a 404 into the version error', async () =>
    {
        const copy = vi.fn().mockResolvedValue([]);
        const { provider, file } = providerWithFiles({ copy });

        await provider.copy('gen/req-1/a.png', 'confirmed/a.png', { sourceVersionId: '17' });

        expect(file).toHaveBeenNthCalledWith(1, 'gen/req-1/a.png', { generation: '17' });

        const missing = providerWithFiles({ copy: vi.fn().mockRejectedValue(notFoundError()) });
        await expect(missing.provider.copy('gen/req-1/a.png', 'confirmed/a.png', { sourceVersionId: '17' }))
            .rejects.toBeInstanceOf(StorageVersionNotFoundError);
    });
});

function notFoundError(): Error & { code: number }
{
    return Object.assign(new Error('No such object'), { code: 404 });
}

function failingStream(error: Error): Readable
{
    return new Readable({
        read()
        {
            this.destroy(error);
        },
    });
}

async function collect(stream: Readable): Promise<Buffer>
{
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
    {
        chunks.push(Buffer.from(chunk as Buffer));
    }

    return Buffer.concat(chunks);
}

/** 단순 업로드는 `name` 쿼리, rewrite는 경로의 대상 key — 둘 다 `ifGenerationMatch=0`일 때만 조건부 쓰기다. */
const GCS_DIALECT: ConditionalWriteDialect = {
    targetOf: (_request, url) =>
        (url.searchParams.get('ifGenerationMatch') === '0'
            ? url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/').pop() ?? '')
            : null),
    answerTaken: response => response
        .writeHead(412, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: 412, message: 'At least one of the pre-conditions you specified did not hold.' } })),
};

/** 받은 요청을 기록하고, 서버에 닿은 뒤 `status` redirect로 닫힌 포트를 가리킨다 — 다음 연결은 `connect`에서 실패한다. */
async function startRedirectingEndpoint(status: number, received: string[]): Promise<Server>
{
    const server = createServer((request, response) =>
    {
        received.push(request.url ?? '');
        request.resume();
        request.on('end', () => response.writeHead(status, { location: 'http://127.0.0.1:1/after-first-request' }).end());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    return server;
}

function urlOf(server: Server): string
{
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** 에뮬레이터 호스트를 쓰면 SDK가 인증 없이 그 주소로 보낸다. */
function providerAt(endpoint: string): GcsStorageProvider
{
    process.env.STORAGE_EMULATOR_HOST = endpoint;

    return new GcsStorageProvider({ projectId: 'test', publicBucket: 'public-test', privateBucket: 'records' });
}

function providerWithGetFiles(getFiles: ReturnType<typeof vi.fn>): GcsStorageProvider
{
    const provider = new GcsStorageProvider({ publicBucket: 'public-test', privateBucket: 'private-test' });
    const bucket = { file: vi.fn().mockReturnValue({}), getFiles };
    Object.assign(provider as unknown as Record<string, unknown>, { publicBucket: bucket, privateBucket: bucket });

    return provider;
}

function providerWithBuckets(
    privateHandlers: Record<string, unknown>,
    publicHandlers: Record<string, unknown>,
): { provider: GcsStorageProvider; publicFile: ReturnType<typeof vi.fn>; privateFile: ReturnType<typeof vi.fn> }
{
    const provider = new GcsStorageProvider({ publicBucket: 'public-test', privateBucket: 'private-test' });
    const publicFile = vi.fn().mockReturnValue(publicHandlers);
    const privateFile = vi.fn().mockReturnValue(privateHandlers);
    Object.assign(provider as unknown as Record<string, unknown>, {
        publicBucket: { file: publicFile },
        privateBucket: { file: privateFile },
    });

    return { provider, publicFile, privateFile };
}

function providerWithFiles(handlers: Record<string, unknown>): { provider: GcsStorageProvider; file: ReturnType<typeof vi.fn> }
{
    const provider = new GcsStorageProvider({ publicBucket: 'public-test-bucket', privateBucket: 'private-test-bucket' });
    const file = vi.fn().mockReturnValue(handlers);
    const internals = provider as unknown as { publicBucket: unknown; privateBucket: unknown };
    internals.publicBucket = { file };
    internals.privateBucket = { file };

    return { provider, file };
}

function providerWithSignedUrl(getSignedUrl: (options: unknown) => Promise<string[]>): GcsStorageProvider
{
    return providerWithFiles({ getSignedUrl }).provider;
}

function providerWithDelete(deleteObject: (options: { ignoreNotFound: boolean }) => Promise<unknown>): GcsStorageProvider
{
    const provider = new GcsStorageProvider();
    const bucket = { file: (_key: string) => ({ delete: deleteObject }) };
    const internals = provider as unknown as TestProviderInternals;
    internals.publicBucket = bucket;
    internals.privateBucket = bucket;

    return provider;
}

function restoreEnv(key: string, value: string | undefined): void
{
    if (value === undefined)
    {
        delete process.env[key];
    }
    else
    {
        process.env[key] = value;
    }
}
