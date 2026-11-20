# @spfn/core/security

Helpers for making outbound requests safely. The headline export is **`safeFetch`**,
an SSRF-hardened drop-in for `fetch`.

## Why

Any time the backend fetches a URL that a user can influence — a webhook target, an
image URL, an OAuth callback, a `$ref` in stored data — an attacker can point it at an
internal address (`http://169.254.169.254/…` for cloud credentials, `http://127.0.0.1:…`
for internal services). That is **SSRF** (Server-Side Request Forgery).

A string allowlist or a "block these hostnames" check does **not** stop it: the attacker
controls DNS, so `evil.com` can resolve to `169.254.169.254` *after* your check passes
(**DNS rebinding**). The only robust defense is to resolve the host, validate the
resolved IP, and **pin the connection to that validated IP**.

## `safeFetch(input, init?)`

Same signature as `fetch`. It:

1. checks the protocol (default `http:`/`https:`) and any host allowlist;
2. resolves the hostname and rejects if it points at a private/reserved range;
3. **pins** the connection to a validated IP via a custom undici `lookup`, closing the
   rebinding window between check and connect;
4. follows redirects **manually** and re-validates **every hop** — including a hop whose
   target is a bare IP literal (which undici would otherwise connect to directly, skipping
   the pinning lookup). Capped at `maxRedirects` (default 5).

The original method, body, and headers are **not** replayed across a redirect: the next
hop may be attacker-chosen, so forwarding the payload or auth headers would leak them — the
redirected request is issued as a header-less `GET`.

Blocked targets throw `SsrfBlockedError`.

```typescript
import { safeFetch } from '@spfn/core/security';

const res = await safeFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});
```

## Policy

Private/reserved IPs are blocked by default. Configure the process-wide default once at
boot, or build a scoped fetch with `createSafeFetch(policy)`:

```typescript
// server.config.ts — sets the default safeFetch() policy
export default defineServerConfig()
    .outboundFetch({ allowHosts: ['hooks.slack.com'] })
    .build();

// or a one-off, scoped instance (reuse it — it owns a pooled dispatcher)
import { createSafeFetch } from '@spfn/core/security';
const fetchSlack = createSafeFetch({ allowHosts: ['hooks.slack.com'] });
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `allowedProtocols` | `string[]` | `['http:','https:']` | Permitted URL schemes. |
| `blockPrivateIps` | `boolean` | `true` | Block private/reserved ranges (loopback, link-local/metadata, RFC1918, CGNAT, ULA, multicast, NAT64/6to4). |
| `allowHosts` | `string[]` | — | Exact hostname allowlist (case-insensitive), enforced on every redirect hop. Strongest control for a known upstream set. |
| `maxRedirects` | `number` | `5` | Redirects to follow, each re-validated. |

Env: `SAFE_FETCH_BLOCK_PRIVATE_IPS` sets the boot default for `blockPrivateIps`
(keep `true` in production; `false` only for trusted internal-network calls in dev).

> **Compatibility note.** The Slack webhook sender (`@spfn/notification`) now routes
> through `safeFetch`, so a webhook pointed at a **private/internal address** (self-hosted
> Mattermost, an internal Slack-compatible endpoint on `10.x`/`192.168.x`, etc.) will now
> fail to send. Allow it explicitly with `outboundFetch({ allowHosts: ['your.host'] })`, or
> — if the target is a raw private IP — `outboundFetch({ blockPrivateIps: false })` (which
> relaxes the check for *all* outbound calls, so prefer `allowHosts`).

## `assertSafeUrl(url, policy?)`

When the actual request is made by code you **don't** control (e.g. an app-provided
storage `download(url)`), you can't pin the connection. Validate the URL first:

```typescript
import { assertSafeUrl } from '@spfn/core/security';

if (/^https?:\/\//i.test(ref)) await assertSafeUrl(ref); // throws SsrfBlockedError if internal
return storage.download(ref);
```

This runs the same protocol/allowlist/DNS-resolution checks but **cannot** prevent
rebinding between the check and that code's own connection — it raises the bar (blocks
the obvious metadata/loopback injection) rather than fully closing SSRF. Prefer
`safeFetch` whenever you own the request.

## Also here

- `isPrivateOrReservedIp(ip)` — the IP classifier, exported for reuse/testing.
- `proxy-signature` — HMAC signing/verification for the proxy→backend trust path
  (see `@spfn/core/middleware` proxy-guard).
- `forwarded-client` — the assertion a server-side `createApi` call makes to the app's own
  proxy of the browser's address, keyed with the proxy key (see the Next.js README).
