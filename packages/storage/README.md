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

The AWS SDK comes with it, and the GCS provider's `@google-cloud/storage` `^8.3.0` is an
optional dependency your package manager installs alongside. 8.3.0 is a security floor: every
7.x release, and 8.0–8.2, reach a `uuid` with GHSA-w5hq-g745-h8pq. If your app depends on
`@google-cloud/storage` itself, raise it to `^8.3.0` too, or the GCS provider and your code
load two copies.

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

## The default service and other buckets

`getStorageService()` returns **the default service**: one per process, created by the first
call with that call's options. Later calls without options, or with options that configure the
same service, return it. A later call whose options configure a *different* service rejects
instead of quietly handing back the first one; the default service never reconfigures.

"The same service" is judged on the effective configuration, not on how the options are spelled:
each field after its environment fallback and default (`S3_*`, `GCS_*`, `LOCAL_STORAGE_*`), for
the provider that is selected only. A missing field and one set to `undefined`, a relative and an
absolute `local.dir`, an environment value left out or spelled out, and options for a provider the
service does not use all count as the same. Every option is a string, so the comparison is by
value. The environment is read at each call, so a variable changed between two calls with options
can make the second one differ.

The exact rule: each field of the selected provider is compared as a string after these steps and
no others — the provider selected (`provider`, else `STORAGE_PROVIDER`, else `s3` in production and
`local` otherwise) with every value other than `local` and `gcs` read as `s3` (`'S3'`, `''` and
`'r2'` all select `s3`), the environment fallback and default, `local.dir` made absolute, trailing `/` trimmed
from `local.baseUrl` and `s3.publicBaseUrl`, an empty `s3.endpoint` or `gcs.projectId` read as
absent, and `gcs.credentialsJsonBase64` decoded to JSON (so whitespace and key order do not
count). Nothing the SDK would derive later is derived here, so two spellings the SDK resolves
alike can still compare unequal and reject: a `gcs.projectId` left out (the SDK takes it from the
credentials' `project_id`, the environment or the metadata server, asynchronously) against one
written out, or an `s3.endpoint` with and without a trailing `/`. Write such a field the same way
at every call that passes options. The rejection is loud, never a silently different service.

For a second bucket — a record kept apart from users' files, with its own retention,
permissions or provider — create an independent service:

```ts
import { createStorageService, getStorageService } from '@spfn/storage/server';

const files = await getStorageService();
const records = await createStorageService({
    provider: 'gcs',
    gcs: { privateBucket: 'acme-records', publicBucket: 'acme-records' },
});
```

`createStorageService(options)` takes the same options as `getStorageService`, returns a new
service with the same surface on every call, and shares no client, bucket or root with any other
service. **A provider field you leave out falls back to the same environment variable the default
service reads** (`S3_BUCKET`, `GCS_PRIVATE_BUCKET`, `LOCAL_STORAGE_DIR`, …), so name the bucket
explicitly or the second service writes to the first one's bucket. Keys starting with `public/`
still go to `publicBucket` on GCS. Use this factory rather than constructing a provider class
from `@spfn/storage/server/*.provider` — it is the supported way to get a service.

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

### GCS credentials

With `GCS_CREDENTIALS_JSON_BASE64` (or `credentialsJsonBase64`) set, the provider hands the
decoded key to `new Storage({ credentials })`, the option `@google-cloud/storage` 8 documents.
Without it, the client uses Application Default Credentials.

With the base64 key set and google-auth-library 11.3.2 or later (what `@google-cloud/storage` 8
installs), the process prints one deprecation line at start: "The `credentials` option is
deprecated…". It is cosmetic: signed URLs and requests are correct. The replacement the warning
points to, `authClient`, cannot be used, because with it V4 signed URLs name the wrong account
(the compute default account on GCE) or fail elsewhere. An app that wants no warning sets
`GOOGLE_APPLICATION_CREDENTIALS` to the path of the key file and leaves the base64 variable
unset; that is silent and signs as the key's account.

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

A create-only write onto a taken key rejects with `StorageObjectExistsError`, and one whose
outcome is unknown with `StorageWriteOutcomeUnknownError` — see
[Create-only writes](#create-only-writes).

`StorageVersionNotFoundError` is a **separate** error and does not extend
`StorageObjectNotFoundError`: the object is there, only the requested version is not,
so a 404 handler should not swallow it.

## Create-only writes

`upload` and `copy` replace whatever is at the target key. With `ifAbsent: true` they create
the object only when the key is empty. The request is sent **once** — never retried — and a
failed call ends in one of two errors:

- **`StorageObjectExistsError`** — the store answered that single request with "already exists":
  the key was taken before the request arrived, by someone else, and nothing was written.
- **`StorageWriteOutcomeUnknownError`** — the provider cannot tell whether the write landed: the
  request may have gone out and the response was lost (connection dropped, timeout), or the store
  answered with a 5xx or S3's `409 ConditionalRequestConflict`. The object may be yours. Read the
  key to settle it; the original error is the `cause`.

Any other error is definite — nothing was written — and surfaces as it does without `ifAbsent`:
the store refusing the request (a 403, a missing copy source, …), or a request that never left.
A request is known not to have left only as far as the SDK says so:

| Provider | Known not sent (the SDK's error is raised) | Not known, so reported as unknown |
|---|---|---|
| S3-compatible | a failure before the SDK hands the request to its HTTP handler (region, bucket name, credentials, signing); a failed DNS lookup or TCP connect (`syscall` `getaddrinfo` / `connect`, e.g. `ECONNREFUSED`) | a TLS handshake failure; the SDK's own connection timeout |
| GCS | nothing — every create-only failure without a response from the store is reported as unknown | a failed DNS lookup or TCP connect too: the SDK's HTTP client (node-fetch) follows redirects itself and reports only the last connection's error, so a `connect` failure after the first request reached a server looks the same as one that never left; a local credential or signing failure — the SDK does not say whether the request left, and on `upload` it even replaces the cause with "Cannot call write after a stream was destroyed"; a TLS handshake failure |

An unknown outcome from a configuration error is safe — reading the key settles it — but a
service that cannot sign reports every create-only write that way; check the `cause`.

```ts
import { StorageObjectExistsError, StorageWriteOutcomeUnknownError } from '@spfn/storage/server';

try
{
    await records.upload(`log/${next}.json`, body, 'application/json', { ifAbsent: true });
}
catch (error)
{
    if (error instanceof StorageObjectExistsError)
    {
        return claimNextKey();   // another writer took this key first
    }
    if (error instanceof StorageWriteOutcomeUnknownError)
    {
        return settleByReading(`log/${next}.json`);   // the write may have landed
    }
    throw error;
}
```

How to settle an unknown outcome is the application's call: the bytes alone do not say who wrote
them (two writers can send equal bytes), so put something in the object that names the writer —
a claim id — and compare that.

The check and the write are one request — each backend's atomic conditional write, never
"check, then write" — so two writers racing for one key never both succeed (on an S3-compatible
store, only if it honours the header — below), and the stored bytes are those of the one write
that landed. This is what lets an application claim keys in order, in a bucket whose objects
cannot be replaced (GCS retention policy, S3 Object Lock).

| Provider | `upload(…, { ifAbsent: true })` | `copy(from, to, { ifAbsent: true })` |
|---|---|---|
| S3-compatible | `If-None-Match: *` on `PutObject` | `If-None-Match: *` on `CopyObject` |
| GCS | `ifGenerationMatch: 0` on the upload | `ifGenerationMatch: 0` on the rewrite destination |
| Local | write a temporary file, then `link` it to the key | copy to a temporary file, then `link` it to the key |

`StorageObjectExistsError` carries the target `key` (the **destination** for `copy`) and sets
`code = 'EEXIST'`. It is the counterpart of `StorageObjectNotFoundError` and does not extend it.
`StorageWriteOutcomeUnknownError` carries the same `key` and the SDK's error as `cause`; the local
provider never raises it (the filesystem answers every exclusive create).

Things to know:

- **The S3-compatible store has to honour the header — the provider cannot check that it did.**
  AWS S3 documents `If-None-Match: *` on `PutObject` and `CopyObject`, and SeaweedFS 4.54 was
  measured answering `412 Precondition Failed` on both. On a store that ignores the header, a
  create-only write **replaces** the object at the key and resolves as if it had created it: the
  response looks the same, so neither the provider nor the caller learns that the key was taken,
  and two writers can both "win". Telling the cases apart would take a second request on every
  write, which the provider does not make. Verify your store before relying on `ifAbsent`. R2,
  Wasabi and the GCS interoperability endpoint have not been tested here; use the native GCS
  provider on GCS. Uploads are a single `PutObject`, never multipart.
- **GCS behind a redirect: the outcome is not guaranteed to be known.** The SDK's HTTP client
  follows a redirect itself and the provider sees only the last request's result: when the
  redirected request fails without a response, the write rejects with
  `StorageWriteOutcomeUnknownError` — read the key before retrying. A status from the redirect
  target is read as if the first request had answered it: a 412 rejects with
  `StorageObjectExistsError`, and a `copy` redirected with a 303 can resolve although the redirect
  turned its `POST` into a `GET`.
- **Why no retry.** A conditional write is not safe to resend: if the first attempt landed and
  only its response was lost, the resend is refused because the key is taken — by that first
  attempt. The SDKs retry on their own, so the providers send create-only writes through a client
  with retries off (S3 `maxAttempts: 1`, GCS `retryOptions.autoRetry: false`). Plain writes keep
  the SDKs' retries.
- **Local:** the bytes go to a temporary file first, and `link` publishes it under the key —
  `link` fails if the key exists, so the check and the publish are one step, and a reader only
  ever sees complete bytes. A write that fails midway (disk full, file size limit) leaves nothing
  at the key, and the next create-only write can take it. Temporary files live in one directory
  at the storage root, `LOCAL_STORAGE_DIR/\partial`: its name has a backslash, which no key or
  prefix may contain, so `list`, `deletePrefix`, `snapshotPrefix` and every read never reach it —
  a write in progress is not visible, and nothing can delete its file under it. A temporary file
  is removed on success and on failure; one a killed process leaves behind stays in `\partial`,
  invisible, until you delete it. This holds on POSIX filesystems; on Windows the backslash is a
  separator. The filesystem needs hard links (ext4, APFS, tmpfs and the like): on one without
  them (FAT, exFAT) `link` fails, and the create-only write rejects with that error and writes
  nothing — it does not fall back to a write that can be seen half-done. A directory under the
  storage root that is a mount point of another filesystem fails the same way (`EXDEV`).
  A directory at the key (`a/b` while `a/b/c` exists) is not an object and fails with the
  filesystem error, not `StorageObjectExistsError`.
- **Presigned uploads and `finalizeObject` have no create-only form.** A presigned PUT replaces
  the key when the browser sends it (S3), and on GCS `finalizeObject` moves `tmp/<key>` over the
  final key. Making those create-only means signing the condition into the URL — a different
  change from this one.

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

## Download URLs with response headers

`getDownloadUrl(key, options)` signs the response's `Content-Disposition` and
`Content-Type` into the URL when you ask for them. This is the download side of a
content-addressed layout: an object stored under `<prefix>/<sha256>` has no file name
of its own, several rows may point at one object under different names, and the name
the browser saves the file under is only known per download.

```ts
const url = await storage.getDownloadUrl('artifacts/ws1/9f86d0…', {
    expiresIn: 900,
    responseContentDisposition: `attachment; filename*=UTF-8''report.md`,
    responseContentType: 'text/markdown',   // optional override of the stored type
});
```

- **S3-compatible:** `ResponseContentDisposition` / `ResponseContentType` on the
  signed `GetObject`; **GCS:** `responseDisposition` / `responseType` on the V4
  signed URL. Both are part of the signature, so a client cannot edit the query to
  change them.
- **Local:** the values are appended as `response-content-disposition` and
  `response-content-type` query parameters on the public URL. The local provider
  serves no HTTP itself; the app's local file route decides whether to honour them.
- The positional form `getDownloadUrl(key, 900)` still works and means `expiresIn`.

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
