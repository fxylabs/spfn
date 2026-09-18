# File Upload

SPFN provides `FileSchema()` and `FileArraySchema()` for type-safe file uploads within [route definitions](../src/route/README.md). Files are received as standard `File` objects through `formData` input.

> **They are functions — always call them.** `file: FileSchema()` is correct;
> `file: FileSchema` passes the function reference and produces an invalid schema. The
> same goes for `FileArraySchema()` and `OptionalFileSchema()`.
>
> `body` and `formData` are also mutually exclusive at runtime: the request's
> `Content-Type` decides which one is parsed. A multipart request never populates `body`.

## Basic Usage

### Single File Upload

```typescript
import { route, FileSchema } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

export const uploadAvatar = route.post('/users/:id/avatar')
    .input({
        params: Type.Object({ id: Type.String() }),
        formData: Type.Object({
            file: FileSchema(),
            description: Type.Optional(Type.String()),
        }),
    })
    .handler(async (c) =>
    {
        const { params, formData } = await c.data();
        const file = formData.file as File;

        // File properties
        console.log(file.name);  // original filename
        console.log(file.size);  // size in bytes
        console.log(file.type);  // MIME type

        // Read file content
        const buffer = await file.arrayBuffer();

        return c.created({ filename: file.name, size: file.size });
    });
```

### Multiple Files

```typescript
import { route, FileArraySchema } from '@spfn/core/route';

export const uploadDocuments = route.post('/documents')
    .input({
        formData: Type.Object({
            files: FileArraySchema(),
            category: Type.String(),
        }),
    })
    .handler(async (c) =>
    {
        const { formData } = await c.data();
        const files = formData.files as File[];

        const results = await Promise.all(
            files.map(async (file) =>
            {
                const buffer = await file.arrayBuffer();
                return { name: file.name, size: file.size };
            })
        );

        return { uploaded: results.length, files: results };
    });
```

### Mixed Fields (File + Text)

```typescript
import { route, FileSchema } from '@spfn/core/route';

export const createPost = route.post('/posts')
    .input({
        formData: Type.Object({
            title: Type.String(),
            content: Type.String(),
            image: FileSchema(),
            tags: Type.Optional(Type.String()),  // JSON string
        }),
    })
    .handler(async (c) =>
    {
        const { formData } = await c.data();
        const image = formData.image as File;

        const post = await postRepo.create({
            title: formData.title,
            content: formData.content,
            tags: formData.tags ? JSON.parse(formData.tags) : [],
            imageUrl: await saveFile(image),
        });

        return c.created(post);
    });
```

## Validation

### Declarative Validation (Recommended)

Pass validation options directly to the schema for automatic enforcement:

```typescript
import { route, FileSchema, FileArraySchema } from '@spfn/core/route';

// Single file with size and type constraints
export const uploadAvatar = route.post('/avatars')
    .input({
        formData: Type.Object({
            avatar: FileSchema({
                maxSize: 5 * 1024 * 1024,  // 5MB
                allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
            }),
        }),
    })
    .handler(async (c) =>
    {
        const { formData } = await c.data();
        const file = formData.avatar as File;
        // File is already validated - safe to use
        return { name: file.name, size: file.size };
    });

// Multiple files with count and size limits
export const uploadDocuments = route.post('/documents')
    .input({
        formData: Type.Object({
            files: FileArraySchema({
                maxFiles: 5,
                minFiles: 1,
                maxSize: 10 * 1024 * 1024,  // 10MB per file
                allowedTypes: ['application/pdf', 'application/msword'],
            }),
        }),
    })
    .handler(async (c) =>
    {
        const { formData } = await c.data();
        const files = formData.files as File[];
        return { count: files.length };
    });
```

Validation errors are thrown automatically with a 400 status:

```json
{
    "__type": "ValidationError",
    "message": "Invalid form data",
    "fields": [
        {
            "path": "/avatar",
            "message": "File size 15.0MB exceeds maximum 5.0MB",
            "value": 15728640
        }
    ],
    "error": {
        "code": "ValidationError",
        "message": "Invalid form data",
        "requestId": "req_1754380000000_9f2c1ab4e7d0"
    }
}
```

Every error body carries `__type` (what the web client restores an error class from) and
an `error` envelope with `code` / `message` / `requestId` (what a client in another
language classifies on). For a file-array field the `path` includes the index —
`/files/2` for the third file, `/files` for a count violation (`maxFiles` / `minFiles`).

> **A missing file field is not a validation error.** Validation walks the fields the
> request actually sent, so a `FileSchema()` field the client omitted produces no error —
> the handler just receives `undefined`. `formData.avatar as File` is a cast, not a
> guarantee. Check for the file yourself before using it.

### Validation Options

| Option | Type | Applies To | Description |
|--------|------|------------|-------------|
| `maxSize` | number | Both | Maximum file size in bytes |
| `minSize` | number | Both | Minimum file size in bytes |
| `allowedTypes` | string[] | Both | Allowed MIME types |
| `maxFiles` | number | FileArraySchema | Maximum file count |
| `minFiles` | number | FileArraySchema | Minimum file count |

### Manual Validation

For custom validation logic, validate in the handler:

```typescript
import { ValidationError } from '@spfn/core/errors';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const uploadImage = route.post('/images')
    .input({
        formData: Type.Object({
            image: FileSchema(),
        }),
    })
    .handler(async (c) =>
    {
        const { formData } = await c.data();
        const file = formData.image as File;

        if (!ALLOWED_IMAGE_TYPES.includes(file.type))
        {
            throw new ValidationError({
                message: 'Invalid file type',
                fields: [{
                    path: '/image',
                    message: `Allowed types: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
                    value: file.type,
                }],
            });
        }

        // Process valid image...
    });
```

## Storage Patterns

### `@spfn/storage` (recommended)

SPFN ships provider-agnostic object storage — S3-compatible services (S3, R2, Wasabi,
SeaweedFS), Google Cloud Storage, and the local filesystem behind one interface. Prefer it
over calling a provider SDK directly: every object operation validates its key before it
reaches the provider (rejecting `..` segments, leading `/`, backslashes, control
characters and URLs), so a key built from user input cannot escape its prefix.

```typescript
import { getStorageService, randomKey } from '@spfn/storage/server';

async function saveUpload(file: File): Promise<string>
{
    const storage = await getStorageService();
    const key = randomKey('public/uploads', file.name.split('.').pop() || 'bin');

    await storage.upload(key, Buffer.from(await file.arrayBuffer()), file.type);

    return storage.getPublicUrl(key);
}
```

The provider comes from `STORAGE_PROVIDER` (`local` / `s3` / `gcs`), defaulting to `local`
in development and `s3` in production. Private objects are read back with
`storage.getDownloadUrl(key)` (a presigned GET) or `storage.getStream(key)`.

A `public/` key prefix is meaningful **on GCS only**, where it routes the object to the
public bucket instead of the private one. On S3-compatible providers and local there is a
single bucket, and `getPublicUrl()` just prepends the configured public base URL to any
key — the prefix is a convention you must back with your own bucket policy.

### Presigned upload (large files)

For large files, don't route the bytes through your API process at all — sign an upload,
let the browser `PUT` straight to the returned `uploadUrl`, then confirm it:

```typescript
const { uploadUrl, requiredHeaders } = await storage.getUploadUrl({
    key,
    contentType: 'image/webp',
    contentLength: exactSize,   // signed on both S3 and GCS
    temp: true,                 // unconfirmed until finalized
});

// browser PUTs to uploadUrl, sending every requiredHeaders entry verbatim

await storage.finalizeObject(key);
```

Three constraints decide whether this is safe:

| Constraint | Behaviour |
|---|---|
| `contentLength` (exact size) | Signed on **both** S3-compatible and GCS. A mismatched size fails. |
| `maxBytes` (upper bound) | Enforced on **GCS only**. A presigned PUT cannot sign a size range, so S3, R2 and Wasabi **ignore it silently**. |
| Local filesystem provider | Presigned upload is **not supported** — `getUploadUrl()` throws. Use the direct `upload()` path in local dev. |

A client can declare one size and send another, so a server-side check of a
client-declared size binds nothing. If you only know an upper bound and must enforce it on
S3, verify the size after upload.

`temp: true` marks the upload unconfirmed so abandoned uploads don't accumulate, and
`finalizeObject(key)` confirms it (idempotent; it rejects if neither the temp nor the final
object exists). The package does **not** delete orphans itself — it tags them
(`lifecycle=temp` on S3) or stages them under `tmp/<key>` (GCS), and you configure the
bucket lifecycle rule that expires them. On GCS a temp object is not readable at its final
key until finalized; on S3 it is.

### Local File System

```typescript
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_DIR = './uploads';

async function saveToLocal(file: File, subdir: string = ''): Promise<string>
{
    const dir = join(UPLOAD_DIR, subdir);
    await mkdir(dir, { recursive: true });

    const ext = file.name.split('.').pop() || '';
    const filename = `${randomUUID()}.${ext}`;
    const filepath = join(dir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filepath, buffer);

    return filepath;
}
```

### AWS S3

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET!;

async function uploadToS3(file: File, prefix: string = ''): Promise<string>
{
    const ext = file.name.split('.').pop() || '';
    const key = `${prefix}${randomUUID()}.${ext}`;

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: Buffer.from(await file.arrayBuffer()),
        ContentType: file.type,
        Metadata: { originalName: file.name },
    }));

    return `https://${BUCKET}.s3.amazonaws.com/${key}`;
}
```

### Cloudflare R2

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
});

async function uploadToR2(file: File, prefix: string = ''): Promise<string>
{
    const key = `${prefix}${randomUUID()}.${file.name.split('.').pop()}`;

    await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: Buffer.from(await file.arrayBuffer()),
        ContentType: file.type,
    }));

    return `${process.env.R2_PUBLIC_URL}/${key}`;
}
```

## Streaming (Large Files)

For large files, use streaming to avoid memory issues:

```typescript
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';

export const uploadLargeFile = route.post('/large-files')
    .handler(async (c) =>
    {
        // Access raw request for streaming
        const formData = await c.raw.req.formData();
        const file = formData.get('file') as File;

        if (!file)
        {
            throw new ValidationError({ message: 'File required' });
        }

        const outputPath = `./uploads/${randomUUID()}.bin`;
        const writeStream = createWriteStream(outputPath);

        const reader = file.stream().getReader();
        const nodeStream = new Readable({
            async read()
            {
                const { done, value } = await reader.read();
                if (done)
                {
                    this.push(null);
                }
                else
                {
                    this.push(Buffer.from(value));
                }
            },
        });

        await pipeline(nodeStream, writeStream);

        return c.created({ path: outputPath, size: file.size });
    });
```

## Client Usage

### SPFN API Client (Recommended)

The generated API client handles `FormData` construction automatically:

```typescript
import { api } from '@/lib/api';

// Single file upload
const result = await api.uploadAvatar.call({
    params: { id: '123' },
    formData: {
        file: fileInput.files[0],
        description: 'Profile photo',
    },
});

// Multiple files
const docs = await api.uploadDocuments.call({
    formData: {
        files: Array.from(fileInput.files),
        category: 'reports',
    },
});
```

### Fetch API

For direct backend calls (bypassing RPC proxy):

```typescript
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('description', 'My file');

const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
    // Don't set Content-Type - browser sets it with boundary
});
```

### curl

```bash
# Single file
curl -X POST http://localhost:3000/upload \
  -F "file=@./document.pdf" \
  -F "description=Important document"

# Multiple files
curl -X POST http://localhost:3000/upload-multiple \
  -F "files=@./file1.txt" \
  -F "files=@./file2.txt"
```

## Security Best Practices

### 1. Always Validate MIME Types

```typescript
// Don't trust file extensions - check MIME type
// Consider using magic bytes for true type detection
import { fileTypeFromBuffer } from 'file-type';

const buffer = Buffer.from(await file.arrayBuffer());
const detected = await fileTypeFromBuffer(buffer);

if (!detected || !ALLOWED_TYPES.includes(detected.mime))
{
    throw new ValidationError({ message: 'Invalid file type' });
}
```

### 2. Generate New Filenames

```typescript
// Never use user-provided filenames directly
const safeFilename = `${randomUUID()}.${getExtension(file.type)}`;

function getExtension(mimeType: string): string
{
    const map: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'application/pdf': 'pdf',
    };
    return map[mimeType] || 'bin';
}
```

### 3. Store Outside Web Root

```typescript
// Files should not be directly accessible via URL
const UPLOAD_DIR = '/var/data/uploads';  // Outside public/

// Serve files through authenticated route
export const getFile = route.get('/files/:id')
    .use([authMiddleware])
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const file = await fileRepo.findById(params.id);

        if (!file || !canAccess(c.raw.get('user'), file))
        {
            throw new NotFoundError({ resource: 'File' });
        }

        const buffer = await readFile(file.path);
        return new Response(buffer, {
            headers: {
                'Content-Type': file.mimeType,
                'Content-Disposition': `attachment; filename="${file.originalName}"`,
            },
        });
    });
```

A handler that returns a raw `Response` has it passed through as-is, but the typed client
then infers the response as `Response` rather than a concrete shape. That trade-off is
fine for a file download and wrong for a JSON endpoint.

## Schema Reference

| Schema | Description |
|--------|-------------|
| `FileSchema()` | Single File object |
| `FileSchema(options)` | Single File with validation |
| `FileArraySchema()` | Array of File objects |
| `FileArraySchema(options)` | Array of Files with validation |
| `OptionalFileSchema()` | Optional single File |
| `OptionalFileSchema(options)` | Optional File with validation |

## File Properties

| Property | Type | Description |
|----------|------|-------------|
| `file.name` | string | Original filename |
| `file.size` | number | Size in bytes |
| `file.type` | string | MIME type |
| `file.arrayBuffer()` | Promise\<ArrayBuffer\> | File content as buffer |
| `file.text()` | Promise\<string\> | File content as text |
| `file.stream()` | ReadableStream | File as stream |

## Related

- `@spfn/storage` - object storage (S3 / GCS / local), presigned uploads, key validation
- [Route Definition](../src/route/README.md) - `formData` input type
- [Next.js Integration](../src/nextjs/README.md) - Upload files through RPC proxy
- [Error Handling](../src/errors/README.md) - `ValidationError` for file errors
