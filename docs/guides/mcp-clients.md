---
title: "MCP Clients"
description: "Let Claude Code and Codex connect to your app's /mcp endpoint as the signed-in user — OAuth 2.1 authorization server, consent screen, and the two CLIs"
order: 10
available: true
---

# MCP Clients

The goal of this guide is two commands in a terminal:

```console
$ claude mcp add --transport http acme https://api.acme.com/mcp
$ claude
> /mcp
```

and a tool list that belongs to the person who typed them. Nobody pastes a token,
nobody mints an API key, and the CLI holds an access token that "sign me out
everywhere" can take away.

Between those two lines the CLI reads
`https://api.acme.com/.well-known/oauth-authorization-server`, registers itself,
opens a browser at your consent screen, catches the redirect on a loopback port
and exchanges the code for a token. Everything in this guide exists to make that
sequence work.

## What you are wiring

Four things, in two places:

| Piece | Where it runs | What it is |
| --- | --- | --- |
| Authorization server | API origin | `@spfn/auth` — discovery, registration, token, revocation |
| Consent screen | Web app origin | `@spfn/auth/nextjs/server` — the page the browser opens |
| MCP endpoint | API origin | `@spfn/mcp` — `/mcp` and its resource metadata |
| Access token check | API origin | `verifyAccessToken`, handed to `@spfn/mcp` |

The split has one reason: `.well-known` documents are served from an origin's
root, so the authorization server is the API — but consent is a decision only the
signed-in person can make, and the session cookie is on the web app. RFC 8414
allows the `authorization_endpoint` to sit on a different origin than the issuer,
and that is the seam this uses.

## 1. Turn the authorization server on

It is off until you name the scopes, because the names are your application's
vocabulary and there is nothing to derive them from. Keep them in one module —
`@spfn/mcp` publishes the same list in its resource metadata:

```typescript
// src/server/auth-scopes.ts
export const scopes = {
    'mcp:read': 'Read your projects and tasks',
    'mcp:write': 'Create and edit your tasks',
};
```

```typescript
// src/server/server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { createAuthLifecycle } from '@spfn/auth/server';
import { appRouter } from '@/server/router';
import { scopes } from '@/server/auth-scopes';

export default defineServerConfig()
    .routes(appRouter)
    .lifecycle(createAuthLifecycle({
        authorizationServer: {
            scopes,
            defaultScopes: ['mcp:read'],   // what a request with no `scope` asks for
            // issuer: 'https://api.acme.com',   // default: SPFN_API_URL
            // authorizeUrl: 'https://acme.com/oauth/authorize',  // default: {app url}/oauth/authorize
            // allowedRedirectOrigins: [],       // https origins a client may register
        },
    }))
    .build();
```

Run the package's migrations once (`pnpm spfn db migrate`) — the server stores
clients, grants, codes and token hashes.

The issuer is checked at boot: an absolute URL with no path, `https`, or `http`
on `localhost` / `127.0.0.1` / `[::1]` for development. Anything else refuses to
start, naming the value it read.

## 2. Add the consent screen

A page in your app, at the path published as `authorization_endpoint`
(default `/oauth/authorize`). The package ships no HTML, so you build it with
your own components: a server component asks the API what the request is, and
a client component sends the decision.

```tsx
// app/oauth/authorize/page.tsx — a server component
import { redirect } from 'next/navigation';
import { authApi, type AuthRouter } from '@spfn/auth';
import type { RouterInput } from '@spfn/core/nextjs';
import { ConsentForm } from './consent-form';
import { refusalDestination } from './consent-refusal';

type SearchParams = Record<string, string | string[] | undefined>;

export type AuthorizeFields = RouterInput<AuthRouter, 'getOAuth2Authorize'>['query'];

const PARAMETERS = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource', 'scope', 'state'];

/** The authorize parameters the link carried, and nothing else it carried. */
function authorizeFields(params: SearchParams): AuthorizeFields
{
    return Object.fromEntries(
        PARAMETERS.flatMap(name => typeof params[name] === 'string' ? [[name, params[name]]] : []),
    ) as AuthorizeFields;
}

export default async function ConsentPage({ searchParams }: { searchParams: Promise<SearchParams> })
{
    const fields = authorizeFields(await searchParams);
    const described = await authApi.getOAuth2Authorize.call({ query: fields })
        .then(consent => ({ consent }), (refusal: unknown) => ({ refusal }));

    if ('refusal' in described)
    {
        const destination = refusalDestination(
            described.refusal,
            `/oauth/authorize?${new URLSearchParams(fields as Record<string, string>)}`,
        );

        if (destination)
        {
            redirect(destination);
        }

        return <p>This authorization request cannot be completed. Nothing was shared.</p>;
    }

    return <ConsentForm consent={described.consent} fields={fields} />;
}
```

```tsx
// app/oauth/authorize/consent-form.tsx
'use client';
import { useState } from 'react';
import { authApi } from '@spfn/auth';
import type { AuthorizeFields } from './page';
import { refusalDestination } from './consent-refusal';

type Consent = Awaited<ReturnType<typeof authApi.getOAuth2Authorize.call>>;

export function ConsentForm({ consent, fields }: { consent: Consent; fields: AuthorizeFields })
{
    const [failed, setFailed] = useState(false);

    async function decide(approve: boolean)
    {
        try
        {
            const issued = await authApi.createOAuth2AuthorizationCode.call({ body: { ...fields, approve } });
            const url = new URL(issued.redirectUri);

            url.searchParams.set('code', issued.code);

            if (issued.state !== undefined)
            {
                url.searchParams.set('state', issued.state);
            }

            window.location.assign(url);
        }
        catch (refusal)
        {
            const destination = refusalDestination(refusal, `${location.pathname}${location.search}`);

            if (destination)
            {
                window.location.assign(destination);
            }
            else
            {
                setFailed(true);
            }
        }
    }

    return (
        <main>
            <h1>Authorize {consent.clientName}</h1>
            <p>
                <strong>{consent.clientName}</strong> is asking to act on your behalf at{' '}
                <code>{consent.resource}</code>. The authorization would be returned to{' '}
                <code>{consent.redirectHost}</code>.
            </p>
            <ul>
                {consent.scopes.map(scope => <li key={scope.name}><strong>{scope.name}</strong> — {scope.description}</li>)}
            </ul>
            {failed && <p>This request could not be completed. Nothing was shared — try again.</p>}
            <button onClick={() => decide(true)}>Allow</button>
            <button onClick={() => decide(false)}>Deny</button>
        </main>
    );
}
```

```typescript
// app/oauth/authorize/consent-refusal.ts
import { HttpError } from '@spfn/core/errors';

/** Refusals with no vetted URI to carry them: shown on the page, never redirected. */
const SHOWN = new Set(['unknown_client', 'redirect_uri_mismatch']);

/**
 * Where an API refusal sends the browser, or null when the page shows it.
 *
 * `redirectUri` is read from the refusal the API sent, never from the request:
 * it is the value that matched the registration.
 */
export function refusalDestination(refusal: unknown, returnPath: string): string | null
{
    if (!(refusal instanceof HttpError))
    {
        return null;
    }

    if (refusal.statusCode === 401)
    {
        return `/login?returnUrl=${encodeURIComponent(returnPath)}`;
    }

    const { error, redirectUri, state } = refusal.details ?? {};

    if (typeof error !== 'string' || SHOWN.has(error) || typeof redirectUri !== 'string')
    {
        return null;
    }

    const url = new URL(redirectUri);

    url.searchParams.set('error', error);

    if (typeof state === 'string')
    {
        url.searchParams.set('state', state);
    }

    return url.toString();
}
```

```typescript
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    async headers()
    {
        return [
            {
                source: '/oauth/authorize',
                headers: [
                    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
                    { key: 'Cache-Control', value: 'no-store' },
                ],
            },
        ];
    },
};

export default nextConfig;
```

The page owns these rules:

- **No session** — the API answers `401` — sends the visitor to your login page
  with `?returnUrl=` set to the consent request's own path and query, so signing
  in lands back on the screen with its parameters intact.
- **Redirect only to the `redirectUri` the API returned**, with `code` and
  `state` appended — never to the request's `redirect_uri`, which is the open
  redirect the registration check exists to close.
- **`unknown_client` and `redirect_uri_mismatch` are shown on the page**, never
  redirected. Every other refusal, a denial included, goes to the API-returned
  `redirectUri` with `error` and `state`.
- **`clientName` comes from unauthenticated dynamic registration.** Render it as
  text — React escapes it — and never through `dangerouslySetInnerHTML`.
- **`frame-ancestors 'none'` and `no-store`** on the consent path, as in the
  `next.config` snippet: a consent screen that can be framed can be clickjacked.

The decision needs no CSRF work from you. `POST /_auth/oauth2/authorize` is the
one route the proxy CSRF-checks in every mode, whatever `SPFN_AUTH_CSRF` says,
and the `authApi` client already mirrors the CSRF cookie into the header. The
full rules are in [The consent screen](../../packages/auth/README.md#the-consent-screen).

## 3. Serve `/mcp`

The MCP endpoint belongs to the API router, not to a Next.js route handler: it is
the resource the access token names, and the token is verified against the
database the API owns.

```typescript
// src/server/mcp.ts
import { createMcpRoute, McpError } from '@spfn/mcp/server';
import { verifyAccessToken } from '@spfn/auth/server';
import { scopes } from '@/server/auth-scopes';

export const mcpRouter = createMcpRoute({
    appUrl: 'https://api.acme.com',           // the API origin; the resource is `${appUrl}/mcp`
    serverInfo: { name: 'acme', version: '1.0.0' },
    scopesSupported: Object.keys(scopes),
    validateToken: verifyAccessToken,
    resolveContext: async auth =>
    {
        const user = await findUser(Number(auth.userId));

        if (!user)
        {
            throw new McpError(-32002, 'User not found', 403);
        }

        return { userId: user.id };
    },
    listTools: () => tools,
});
```

```typescript
// src/server/router.ts
export const appRouter = defineRouter({ /* your routes */ })
    .packages([authRouter, mcpRouter])
    .use([authenticate]);
```

`validateToken: verifyAccessToken` is the whole connection between the two
packages. It answers `{ clientId, scopes, expiresAt, userId }` or `null`, and
`null` is a refusal — expired, revoked, or issued for another resource.

An MCP access token is not a session. It authorizes the MCP surface for the
resource it names and is not accepted by ordinary API routes.

## 4. Connect a CLI

**Claude Code:**

```console
$ claude mcp add --transport http acme https://api.acme.com/mcp
$ claude
> /mcp
```

**Codex CLI:**

```console
$ codex mcp add acme --url https://api.acme.com/mcp
$ codex mcp login acme
```

which writes `~/.codex/config.toml`:

```toml
[mcp_servers.acme]
url = "https://api.acme.com/mcp"
```

Both point at `/mcp` and nothing else. Discovery does the rest: the 401 from
`/mcp` names the resource metadata document, that document names the
authorization server, and the authorization server's metadata names your consent
screen.

## What the browser shows

The CLI opens `https://acme.com/oauth/authorize?...`. If there is no session the
browser lands on `/login` first and comes back. Then:

- the client's registered name — the one it sent at registration, so read it as a
  claim and not as an identity;
- the host the authorization would be returned to, usually `127.0.0.1`;
- one line per scope, in the words you wrote in `auth-scopes.ts`;
- the resource the token would be good against;
- **Approve** and **Deny**.

Approve and the browser is sent to the loopback port the CLI is listening on,
carrying a code that is good for sixty seconds and one exchange. Deny and it is
sent to the same place carrying `error=access_denied`, which is the answer the
waiting CLI can actually read.

Two refusals never redirect anywhere: an unknown `client_id` and a `redirect_uri`
the client never registered. There is no vetted address to send those to, and
sending them to the one the request supplied is the open redirect the whole rule
exists to close — so they are shown on the screen instead.

A user revokes what they approved with `DELETE /_auth/oauth2/grants/:id`; a
password change, a completed reset, "sign me out everywhere" and a deletion
request each revoke every grant the account has.

## Troubleshooting

| Symptom | What it means | Fix |
| --- | --- | --- |
| `/mcp` answers 401 with `WWW-Authenticate: Bearer error="invalid_token"` | The token was presented and refused: expired, revoked, or issued for a different `resource` | Re-run the CLI's login. If it recurs immediately, check that `appUrl` in `createMcpRoute` is the API origin, so the `resource` the token names is the one being checked |
| `/mcp` answers 401 with no `error` parameter | No bearer token arrived at all | Expected on the first request — it is how discovery starts. A CLI stuck here is not reading `WWW-Authenticate`; check for a proxy stripping the header |
| `/.well-known/oauth-authorization-server` answers 404 | No `authorizationServer` block in `createAuthLifecycle` | Add it (step 1). Without it every endpoint in this guide answers 404 and the boot check does not run |
| `/.well-known/oauth-protected-resource` answers 404 | `mcpRouter` is not registered, or the app is served under a base path | Add it to `.packages([...])`. Under a base path the documents move with it, where clients will not look — terminate the base path at the proxy or set `resourceMetadataUrl` |
| The CLI reports an issuer mismatch | `authorization_servers` in the protected-resource document and `issuer` in the authorization-server document are not the same string | They are derived separately: `issuer` from `SPFN_API_URL` or `authorizationServer.issuer`, `authorization_servers` from `createMcpRoute`'s `appUrl`. Make them the same origin, with no trailing path |
| `createOAuth2AuthorizationCode` answers 403 `CSRF token missing or invalid` on Allow | The `x-spfn-csrf` header did not match the session's CSRF cookie — the proxy checks this route in every mode | The refusal carries a fresh CSRF cookie, so a second click passes. Every click refused means the call is not going through the `authApi` client (which mirrors the cookie) or the page's origin cannot read the cookie |
| The consent page shows a `redirect_uri_mismatch` refusal | The `redirect_uri` is not one the client registered | Loopback registrations vary only in **port**; `localhost`, `127.0.0.1` and `[::1]` are three separate registrations. An `https` URI must be on an origin in `allowedRedirectOrigins` |
| The API refuses to start, naming `SPFN_API_URL` | The issuer has a path, or is neither `https` nor loopback `http` | Set it to a bare origin |

## Related

- [`@spfn/auth` — Authorization server for MCP clients](../../packages/auth/README.md#authorization-server-for-mcp-clients)
  — every endpoint, and the security rules behind them.
- [`@spfn/mcp`](../../packages/mcp/README.md) — tools, resources, prompts, the
  stdio bridge, and the resource metadata documents.
- [Authentication](./authentication.md) — sessions, social login and RBAC, which
  is what `loginPath` leads to.
