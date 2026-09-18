---
title: "File uploads in Next.js: presigned URLs by hand, UploadThing, or a package"
description: Uploading straight to S3 is a well-documented recipe with three things everyone gets wrong. This compares writing it yourself, using a hosted service, and installing a package over your own bucket.
order: 5
---

## The question

The first time a product accepts a profile photo, the naive version works: the bytes go
through your API process and out to storage. It falls over on the first large file, and on
Vercel it falls over sooner, because a serverless function has a request body limit
measured in single-digit megabytes.

The correct version is well known — the browser uploads directly to storage using a
presigned URL your server signs. Search for it and you will find a dozen good tutorials.

They all end with the same paragraph of warnings, and that paragraph is what this page is
about.

**SPFN is ours.** `@spfn/storage` is compared last. Unlike the rest of our packages it has
no dependency on the SPFN framework — its only dependencies are the AWS SDK, with the
Google Cloud client optional — so it is usable from any Node application.

## The three things the tutorials warn you about

**A declared size does not bind the upload.** Checking the file size your client claims
proves nothing: a client can declare one byte and PUT gigabytes to the presigned URL. The
size has to be part of what you signed, or it is not enforced.

**Abandoned uploads accumulate forever.** The browser uploads, the confirming API call
never arrives, and the object sits in the bucket with nothing pointing at it. Nothing
cleans it up unless you designed for it before the first upload.

**A key built from user input can escape its prefix.** `..` segments, a leading slash, a
backslash, control characters, an empty segment. If the key is assembled from anything a
user influenced, this is a path traversal with a storage bucket at the end.

None of these is hard. All three are decisions you have to know to make.

## Answer one: write it yourself

Perfectly reasonable, and for one upload path it is probably right. A presigned PUT is
maybe thirty lines.

The cost is not the thirty lines. It is that the three problems above are now yours to
notice, and you will notice the second one when the bucket bill arrives.

## Answer two: a hosted service — UploadThing

UploadThing is a hosted upload service with first-party adapters for Next.js, Astro,
SvelteKit and several backends. You create an application in its dashboard and take an API
key. Its documentation does not state where uploaded files physically live, so treat that
as a question to ask rather than an assumption to make.

For a team that does not want a bucket at all, this is the least work by a wide margin.
The trade is the usual one: an account, a bill that scales with your files, and your users'
uploads on someone else's infrastructure.

Supabase Storage sits in a similar place if you are already on Supabase.

## Answer three: a package over your own bucket — @spfn/storage

Provider-agnostic object storage for S3-compatible services, Google Cloud Storage and the
local filesystem. The bucket is yours, the credentials are yours, and the package owns no
database — which row points at which object stays in your tables.

```ts
// server — sign an upload for a key you choose
const { uploadUrl, requiredHeaders } = await storage.getUploadUrl({
    key: `private/attachments/${attachmentId}.webp`,
    contentType: 'image/webp',
    contentLength: exactSize,   // signed — a mismatched size fails
    temp: true,                 // unconfirmed until you say otherwise
});

// browser — PUT the bytes straight to uploadUrl with requiredHeaders verbatim

// server — confirm once your own flow completed
await storage.finalizeObject(`private/attachments/${attachmentId}.webp`);
```

**Size is signed, with an honest caveat per provider.** On GCS both an upper bound
(`maxBytes`) and an exact `contentLength` are signed, and an upload outside the range is
rejected with a 400. On S3, R2 and Wasabi a presigned PUT cannot sign a size
*range*, so `maxBytes` is not enforceable there and the package ignores it; `contentLength`
is signed and a mismatch fails the signature. If you only have an upper bound on S3, that
needs a presigned POST policy, which this package does not provide.

**Orphans have a designed answer.** `temp: true` marks the upload unconfirmed and
`finalizeObject` confirms it. On S3-family providers the object is tagged `lifecycle=temp`
and finalizing removes the tag; on GCS the upload lands under `tmp/` and finalizing moves
it. Either way you add one bucket lifecycle rule and abandoned uploads expire on their own.
`finalizeObject` is idempotent, and it rejects when neither object exists so a failed
upload surfaces instead of passing silently.

**Keys are validated before they reach the provider.** Empty strings, URLs, a leading
slash, backslashes, control characters, `.` and `..` segments, empty segments, and anything
over 1,024 UTF-8 bytes are rejected. Everything else is allowed, because segment counts and
naming schemes are application policy rather than storage policy.

## What it does not do

- **`maxBytes` is not enforceable on S3-family providers.** Stated above, repeated here
  because it is the one that could bite.
- **The local provider has no presigned upload at all** — `getUploadUrl` throws, so a
  local dev setup uses the direct upload path instead.
- **The presigned URL methods and `finalizeObject` do not validate keys today.** Only the
  object operations do.
- **`getPublicUploadUrl` has no orphan protection on GCS** — that upload lands on the
  final key directly.
- **You configure the bucket lifecycle rule.** The package tags and moves; expiry is a
  bucket setting you own.
- **It owns no database**, so the mapping from object to row, and deleting one when the
  other goes, is your code.

## Side by side

| | Write it yourself | UploadThing | @spfn/storage |
|---|---|---|---|
| Bucket | yours | theirs | yours |
| Account and API key | no | yes | no |
| Signed size limit | if you build it | managed | yes, with S3 caveat |
| Orphan cleanup | if you build it | managed | temp plus finalize plus lifecycle rule |
| Key validation | if you build it | managed | yes |
| Providers | whatever you wrote | theirs | S3-compatible, GCS, local |
| Needs the SPFN framework | — | no | no |

## The summary

If you do not want to own a bucket, use a hosted service and stop reading — that is a
legitimate answer and it is less work than either alternative.

If the bucket is going to be yours either way, the only question is whether the three
warnings at the top of this page get answered by you or by a package that already answered
them. Thirty lines of presigned URL code is not the expensive part. Knowing that a declared
size proves nothing is.

- [Adding a capability to a backend](./adding-a-capability-to-a-nextjs-backend.md)
- [@spfn/storage documentation](../docs/packages/storage.md)
