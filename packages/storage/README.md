# @spfn/storage

> **File uploads that never pass through your server**

The moment your product accepts a profile photo, an attachment or a generated image,
you need somewhere to put it — and the naive version, where the bytes travel through
your API process, falls over on the first large file. The correct version is a
presigned URL the browser uploads to directly, and getting that right means size
limits that actually bind, orphan cleanup when a user abandons an upload, and keys a
caller cannot escape.

`@spfn/storage` is provider-agnostic object storage for S3-compatible services, Google
Cloud Storage and the local filesystem. It exposes presigned upload, direct upload and
download, streaming download, server-side copy, prefix listing and cleanup, public URL,
finalization and object deletion. It owns no database — the record of which object
belongs to what stays in your tables.

## Installation

```bash
pnpm add @spfn/storage
```

## How does a user upload a file?

The browser uploads to the provider; your server only signs the request and records
the result.

```ts
// 1. server — sign an upload for a key you choose
const { uploadUrl, requiredHeaders } = await storage.getUploadUrl({
    key: `private/attachments/${attachmentId}.webp`,
    contentType: 'image/webp',
    contentLength: exactSize,   // signed — a mismatched size fails
    temp: true,                 // unconfirmed until you say otherwise
});

// 2. browser — PUT the bytes straight to uploadUrl, sending requiredHeaders verbatim

// 3. server — the upload is confirmed only once your own flow completes
await storage.finalizeObject(`private/attachments/${attachmentId}.webp`);
```

Three details decide whether this holds up in production, and each has its own
section below:

| Concern | Where |
|---|---|
| A client that declares 1 byte and uploads gigabytes | [Presigned upload size limits](#presigned-upload-size-limits) |
| A user who starts an upload and never comes back | [Temp uploads and orphan cleanup](#temp-uploads-and-orphan-cleanup) |
| A key built from user input escaping its prefix | [Key validation](#key-validation) |

Local filesystem storage does not support presigned upload at all — `getUploadUrl`
throws — so a dev setup on `local` needs the direct upload path instead.

## Server-side object operations

Generation and staging pipelines need to move objects around without pulling bytes
through the application. Five operations cover that, and every bundled provider
implements all five:

```ts
import { getStorageService, StorageObjectNotFoundError } from '@spfn/storage/server';

const storage = await getStorageService();

// Promote a chosen candidate to its confirmed key. The source is left in place.
await storage.copy('gen/req-1/2.png', 'house-assets/house-id/asset-id.png');

// Serve a large private object without buffering it in memory.
const stream = await storage.getStream('house-assets/house-id/asset-id.png');

// Enumerate one page at a time.
const { objects, cursor } = await storage.list('gen/req-1', { maxKeys: 100 });

// Read one object's metadata — size, and the version id where the bucket has one.
const { size, versionId } = await storage.stat('house-assets/house-id/asset-id.png');

// Clean up the whole generation request.
const { deleted, failed } = await storage.deletePrefix('gen/req-1');
```

### Prefixes match on the path boundary

`list(prefix)` and `deletePrefix(prefix)` match `<prefix>/` — never a raw string
prefix. `deletePrefix('gen/req-1')` therefore cannot touch `gen/req-10/...`, which is
the failure mode a naive string-prefix sweep produces. Two consequences worth knowing:

- An object stored at *exactly* `gen/req-1` is **not** covered. Remove that with
  `delete('gen/req-1')`.
- An empty prefix is rejected, as are `/`, `//`, `.`, and `..`. There is no way to
  spell "the whole bucket", so a missing variable cannot erase everything.

Paginate by following `cursor` until it is `undefined` — **not** until `objects` is
empty. The cursor is an opaque provider value (an S3 continuation token, a GCS page
token, the last key on local); do not persist or parse it.

`deletePrefix` is not atomic. It lists and deletes page by page, holding only one
page in memory, so a very large prefix will not exhaust the heap — but objects
uploaded under the prefix while the sweep runs may survive. Repeat until `deleted`
is `0` if you need a hard guarantee. Partial failures are reported rather than
thrown; check `failed` and retry those keys.

### Streaming download

`getStream(key)` resolves once the object is confirmed to exist and the first bytes
(or EOF) are available, so a missing object rejects instead of failing halfway
through a response. The body is never buffered, so backpressure stays with the
consumer. **The caller owns the stream**: consume it or call `destroy()`, otherwise a
file descriptor or HTTP connection stays open. `download(key)` still returns a
`Buffer` and is unchanged apart from its error type.

### Provider notes

- **S3, R2, Wasabi, SeaweedFS:** `CopyObject` with a per-segment URL-encoded
  `CopySource` — the SDK does not encode it, and keys containing `?`, `#`, `+`, or a
  space fail with `NoSuchKey` otherwise. `deletePrefix` deletes **key by key** rather
  than with `DeleteObjects`, because the GCS interoperability endpoint does not
  support batch deletion and the two would otherwise diverge.
- **GCS:** server-side rewrite for `copy`, which crosses buckets correctly when the
  `public/` rule puts source and destination in different ones. Unfinalized temp
  objects live under `tmp/<key>` and are **not** covered by `deletePrefix(prefix)`;
  the `tmp/` lifecycle rule removes those.
- **GCS through the S3 interoperability endpoint:** the AWS SDK reads version ids
  from `x-amz-version-id` only, and the interoperability endpoint returns
  `x-goog-generation` instead, so `stat().versionId` is always `undefined` there even
  on a bucket with Object Versioning on. Snapshots taken over interop carry no
  versions and restore reports `no-version` for every entry — use the native GCS
  provider when you need versioned snapshots.
- **Local:** a filesystem cannot hold a file and a directory under the same name, so
  `a/b` and `a/b/c.png` cannot both exist — object stores allow both. Keep keys
  non-overlapping if you plan to switch providers. `deletePrefix` may leave empty
  directories behind; they are invisible to `list`, which reports files only.
  Symlinks are neither listed nor followed, so a link cannot escape the storage root.

## Key validation

Every object operation — `upload`, `download`, `getStream`, `copy`, `stat`, `delete`,
`list`, `deletePrefix` — validates its key before it reaches the provider and throws
`StorageKeyError` on a bad one. Rejected: empty strings, URLs, a leading `/`,
backslashes, control characters, `.` or `..` segments, empty segments (`a//b`,
`a/b/`), and anything over 1,024 UTF-8 bytes.

Everything else is allowed. Segment counts, character whitelists, and naming schemes
are application policy, not storage policy — use `randomKey()` or your own convention
on top. `assertObjectKey` and `assertKeyPrefix` are exported if you want to validate
before writing a key to your database.

The presigned URL methods (`getUploadUrl`, `getPublicUploadUrl`, `getDownloadUrl`,
`getPublicUrl`) and `finalizeObject` do not validate keys today.

## Missing objects

`download`, `getStream`, `stat`, and `copy` (on a missing source) all reject with
`StorageObjectNotFoundError` on every provider, so one check covers all four:

```ts
catch (error)
{
    if (error instanceof StorageObjectNotFoundError)
    {
        return notFound();
    }
    throw error;
}
```

The error carries the offending `key` and sets `code = 'ENOENT'`, so Node-style
`error.code === 'ENOENT'` checks work uniformly across S3, GCS, and local.

`delete` is the deliberate exception: it stays idempotent and treats a missing key as
success. A failed `copy` does not create the destination.

`StorageVersionNotFoundError` is a **separate** error and does not extend
`StorageObjectNotFoundError`: the object is there, only the requested version is not,
so a 404 handler should not swallow it.

## Presigned upload size limits

Server-side checks of a client-declared file size do not bind the upload itself —
a client can declare 1 byte and PUT gigabytes to the presigned URL. To enforce size
at the storage layer, pass a limit when presigning:

```ts
const { uploadUrl, requiredHeaders } = await storage.getUploadUrl({
    key: 'private/attachments/id.webp',
    contentType: 'image/webp',
    maxBytes: 10 * 1024 * 1024,   // upper bound
    // or contentLength: exactSize — exact size, strictest
});
```

When `requiredHeaders` is returned, the client must send those headers verbatim on
the PUT request; the signature is invalid (or the provider rejects the upload) without
them. Enforcement by provider:

- **GCS:** both `maxBytes` (`x-goog-content-length-range: 0,max`) and `contentLength`
  (exact range) are signed. Uploads outside the range are rejected with HTTP 400.
- **S3, R2, Wasabi, SeaweedFS:** presigned PUT cannot sign a size *range*, so `maxBytes`
  is **not enforceable and is ignored**. `contentLength` is signed (`Content-Length`
  becomes a signed header) and a mismatched size fails the signature check. If you
  only know an upper bound and must enforce it on S3, use a presigned POST policy
  (not provided by this package) or verify size after upload.
- **Local:** presigned upload is not supported at all (`getUploadUrl` throws).

`getPublicUploadUrl` behaves the same and additionally always returns its signed
`cache-control` (and S3 `x-amz-tagging`) in `requiredHeaders`.

## Temp uploads and orphan cleanup

`getUploadUrl({ temp: true })` marks the upload as unconfirmed so that objects whose
owning flow never completes (the client uploads but the confirming API call never
arrives) do not accumulate forever. `finalizeObject(key)` confirms the upload.

- **S3, R2, Wasabi, SeaweedFS:** the object is tagged `lifecycle=temp`; `finalizeObject`
  removes the tag. Configure a bucket lifecycle rule that expires objects with that
  tag after e.g. 1 day. Temp objects are readable at their final key before
  finalization.
- **GCS:** the presigned URL targets `tmp/<key>`; `finalizeObject` moves it to the
  final key (server-side rewrite). **The object is not readable at its final key
  until finalized.** Configure a lifecycle rule on *both* buckets (public and
  private): `matchesPrefix: ["tmp/"]`, `age: 1` → Delete.
- **Local:** presigned upload is not supported.

`finalizeObject` is idempotent — finalizing an already-finalized key succeeds. If
neither the temp nor the final object exists (the client never finished the PUT),
it rejects so the caller can surface the failed upload.

`getPublicUploadUrl` has no orphan protection on GCS today: the upload lands directly
on the final key. On S3 it is always tagged `lifecycle=temp` and must be finalized.

## Deleting objects

Deletion accepts an object key, never an arbitrary URL:

```ts
import { getStorageService } from '@spfn/storage/server';

const storage = await getStorageService();

await storage.delete('public/question-cards/card-id.webp');
```

`delete(key)` is idempotent. Deleting a key that does not exist succeeds. Other
provider errors are not suppressed; the promise rejects so callers can retry or
leave the item in a deletion outbox.

All bundled providers also implement optional batch deletion:

```ts
const result = await storage.deleteMany?.(keys);

for (const failure of result?.failed ?? [])
{
    await scheduleRetry(failure.key, failure.error);
}
```

`deleteMany()` returns per-key partial results. GCS and Local execute idempotent
single-key deletions and collect failures. S3-compatible storage uses `DeleteObjects`
in batches of at most 1,000 keys. If an entire S3 batch request fails, every key in
that batch appears in `failed`; the batch method does not throw after work may have
partially completed. An empty input returns empty `deleted` and `failed` arrays.

Do not log object contents, signed URLs, or storage credentials when processing a
failure. Treat returned error text as operational data with the same log-scrubbing
policy used for provider exceptions.

## Snapshots and object versions

A generation pipeline that overwrites its own outputs needs a way back. Where the
bucket keeps object versions, `snapshotPrefix` writes down which version was live at
one moment and `restoreManifest` puts those versions back:

```ts
import {
    parseManifest,
    restoreManifest,
    serializeManifest,
    snapshotPrefix,
} from '@spfn/storage/server';

// Before a risky batch: record the live version of everything under the prefix.
const manifest = await snapshotPrefix(storage, 'gen/req-1');
await saveSomewhere(serializeManifest(manifest));   // storing it is your job

// Afterwards, put the recorded versions back.
const { restored, skipped, failed } = await restoreManifest(storage, parseManifest(json));
```

| API | Signature | Notes |
|---|---|---|
| `stat` | `(key) => Promise<StorageObjectStat>` | `{ key, size, lastModified?, etag?, contentHash?, versionId? }` |
| `copy` | `(from, to, { sourceVersionId? }) => Promise<void>` | Without the option, exactly the old behaviour |
| `snapshotPrefix` | `(storage, prefix, { concurrency?, maxKeys? }) => Promise<Manifest>` | `concurrency` defaults to 8; both must be positive integers |
| `restoreManifest` | `(storage, manifest, { onto?, concurrency? }) => Promise<RestoreResult>` | `onto` restores under a different prefix |
| `serializeManifest` / `parseManifest` | `Manifest` ↔ JSON | `parseManifest` keeps known fields only |

`versionId` is always a string (a GCS generation is stringified). `contentHash` is
informational on S3 and GCS — it is absent for composite and multipart objects, which
have no MD5 — and is what the local provider compares instead of a version. `etag` is
recorded but never compared: a GCS etag also moves on a metadata-only update.

### What restore reports

Restore does not stop at the first failure. Every entry lands in exactly one bucket of
`RestoreResult`:

- `restored` — the recorded version was copied back over the target key.
- `skipped: 'already-current'` — the recorded version is already live, so nothing was
  copied. Restoring an untouched snapshot copies nothing at all.
- `skipped: 'no-version'` — the entry carries no version id (local, a bucket without
  versioning, GCS over the S3 interoperability endpoint, or an S3 `"null"` version).
- `skipped: 'version-missing'` — the version is gone, usually retired by a lifecycle
  rule.
- `failed` — the provider failed for some other reason. A **missing** target key is not
  a failure: that is the case restore exists for.

Everything that can be checked before any copy runs is checked before the first one:
a manifest from a different provider, an `onto` that crosses the `public/` boundary,
and every target key (`onto + key.slice(prefix.length)` — never a `replace`) through
the same key validation as every other operation.

### Operational caveats

- **The bucket decides how far back you can go.** A manifest only names versions; it
  cannot protect them. Noncurrent retention (S3 lifecycle, GCS Object Versioning rules)
  is what keeps them alive, and nothing in this package extends it.
- For objects that must survive a long time, set generous noncurrent retention or use
  content-addressed keys — the key scheme is application policy.
- **Restore writes a new version** of each object it touches. CDN caches are not
  purged by it; issue your own purge.
- A `SetStorageClass` lifecycle rule or GCS Autoclass changes the live generation of
  every object it touches, so a restore after such a transition rewrites *everything*
  and lands the objects back in the old storage class.
- GCS through the S3 interoperability endpoint cannot snapshot versions at all — see
  the provider notes above. Use the native GCS provider.
- **Neither operation is atomic.** An object created while `snapshotPrefix` walks the
  prefix may be missing from the manifest; one overwritten mid-walk is recorded at
  whichever version its page saw. Restore copies entry by entry.
- **A manifest grows with the object count.** Listing is page by page, but the entries
  all stay in memory and then again in the serialized JSON. Split a very large prefix
  into sub-prefixes and take one manifest each.
- No API here enumerates, restores, or purges noncurrent or soft-deleted objects, and
  `delete`/`deletePrefix` are unchanged.

## Provider behavior

- **GCS:** `file.delete({ ignoreNotFound: true })`. Public keys (`public/*`) use the
  public bucket and all other keys use the private bucket.
- **S3, R2, Wasabi, SeaweedFS:** `DeleteObject` for one key and `DeleteObjects` for a
  batch. S3 delete markers make missing-key deletion idempotent. `deletePrefix` is
  the exception and never batches — see the provider notes above.
- **Local:** `unlink` below `LOCAL_STORAGE_DIR`. Lexical traversal, absolute paths,
  and parent-directory symlinks escaping the storage root are rejected. Missing
  files and missing parent directories succeed.

## The provider contract suite

One suite defines what every provider must do; `src/__tests__/provider.contract.ts`
holds the cases and each provider registers them. The local provider runs it on every
`pnpm test` with no environment gate, so the required coverage cannot silently
disappear.

Real backends are opt-in. Set every variable for a provider and the same suite runs
against it; set only some and the suite **fails** rather than skipping quietly, so a
typo cannot hide a whole backend:

```bash
# S3-compatible (SeaweedFS shown; the same variables cover R2, AWS S3, and GCS interop).
# Open-source MinIO is archived and its binaries are no longer served, so it is not
# a local option any more. `weed server -s3` speaks S3 on :8333 and supports bucket
# versioning; create the bucket with the AWS SDK or `aws s3api create-bucket`.
weed server -s3 -dir=/tmp/seaweedfs

STORAGE_CONTRACT_S3_ENDPOINT=http://127.0.0.1:8333 \
STORAGE_CONTRACT_S3_BUCKET=spfn-storage-contract \
STORAGE_CONTRACT_S3_ACCESS_KEY_ID=... \
STORAGE_CONTRACT_S3_SECRET_ACCESS_KEY=... \
pnpm test

# GCS (credentials fall back to ADC when the base64 variable is unset)
STORAGE_CONTRACT_GCS_PRIVATE_BUCKET=... STORAGE_CONTRACT_GCS_PUBLIC_BUCKET=... pnpm test
```

These tests write and delete real objects under `spfn-storage-contract/<uuid>/`.
Point them at a throwaway bucket, never a production one. Cleanup is best-effort; a
lifecycle rule on that prefix is the reliable backstop.

## CDN and versioning caveats

Deleting an origin object does not purge already cached public responses. A CDN or
browser may continue serving the object until its cache TTL expires unless the
application separately issues a CDN purge. Prefer immutable, content-addressed keys
for public assets and account for cache retention in privacy deletion procedures.

With S3 Versioning enabled, these APIs delete the current view by creating a delete
marker; older versions remain until lifecycle rules or a separate version-aware
purge removes them. With GCS Object Versioning enabled, deleting the live generation
makes it noncurrent; archived generations remain. These APIs intentionally do not
enumerate or permanently delete every version. Configure provider lifecycle policies
or implement an audited version-purge workflow when permanent erasure of all versions
is required.

## Consistency with database deletion

Database and object storage changes cannot share one transaction. A retryable flow is:

1. Record the rows and storage keys to delete, preferably in a `pending_deletion`
   state or deletion outbox.
2. Delete storage objects.
3. Delete or mark complete only the database records whose object deletion succeeded.
4. Retry failures. Repeated execution is safe because deletion is idempotent.

This ordering also works as compensation when an upload succeeds but the related
database write fails.
