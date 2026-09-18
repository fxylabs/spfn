# @spfn/mcp

> **Operate your app through an AI agent instead of an admin dashboard**

The day after you deploy, someone has to refund an order, look up a user, publish a
change, retry a failed job. The usual answer is an admin dashboard — a second application
with its own auth, its own screens and its own maintenance, growing for as long as the
product does. None of it is your product.

`@spfn/mcp` is the other answer. It serves one application-defined Model Context Protocol
(MCP) contract, so the operations an operator is allowed to perform become tools that
Claude Code — or any other MCP client — runs directly against your backend over
authenticated HTTP. The screens never get built.

What the package supplies: a transport-neutral dispatcher, an OAuth-protected SPFN route
adapter, and a local stdio bridge, each with application-facing tool, resource, prompt and
lifecycle hooks. The official MCP TypeScript SDK handles protocol negotiation, JSON-RPC,
schema validation and legacy compatibility. The public SPFN API exposes no SDK server or
transport objects, so the SDK can be upgraded without rewriting your routes.

Beta, and requires Node.js 20 or newer. It pins the MCP v2 beta while the `2026-07-28`
protocol release is being finalized.

## Install

```bash
pnpm add @spfn/mcp @spfn/core
```

`@spfn/core` is only required for the HTTP route. A stdio-only bridge does not import it.

## Which transport do I use?

Use **Streamable HTTP** when an MCP client connects over a network and needs OAuth, Host
and Origin validation. That is the operator case: your deployed app, an agent somewhere
else.

Use **stdio** when an Agent host starts a local child process and the authority to spawn
that process is the trust boundary. Keep such a bridge thin — inject a client for the
already-running local daemon rather than opening a second database connection or mutating
domain files itself.

## What should I expose as tools?

Operations, not tables. `orders.refund` and `content.publish` each carry an input schema
and an authorization rule; a generic `db.query` carries neither and hands an agent your
whole database.

```
customers.list
orders.refund
content.publish
workflow.retry
```

Each tool should call the same repositories and services your product routes call, so an
operation cannot drift from the rules the product enforces.

**Who is allowed to run which tool is a question `@spfn/auth` already answers.** This
package does not read its RBAC on its own — it asks you for `validateToken` and
`listTools`, and that is where the answers go:

```ts
import { hasPermission } from '@spfn/auth/server';

listTools: async (ctx) =>
{
    const allowed = await Promise.all(
        allTools.map(t => hasPermission(ctx.userId, t.permission)),
    );

    return allTools.filter((_, i) => allowed[i]);
},
```

Check the permission inside the handler as well. Omitting a tool from `listTools` controls
discovery, not authorization — a client that knows the name can still call it.

## Define a transport-neutral dispatcher

The dispatcher owns tool, resource, and prompt registration plus the shared validation and
error policy. It does not authenticate a network request or read process streams.

```ts
import { createMcpDispatcher } from '@spfn/mcp/dispatcher';

const dispatcher = createMcpDispatcher<Authority, Context>({
    serverInfo: { name: 'example-app', version: '1.0.0' },
    listTools: () => tools,
    resources: {
        list: ctx => listResources(ctx),
        read: (ctx, uri) => readResource(ctx, uri),
    },
    prompts: {
        list: ctx => listPrompts(ctx),
        get: (ctx, name, args) => renderPrompt(ctx, name, args),
    },
});
```

The same dispatcher can be passed to `createMcpHttpRoute` and `serveMcpStdio`. The older
`createMcpRoute` convenience API remains compatible and creates the dispatcher internally.

## Remote Streamable HTTP

The route takes two things from the authorization server: the function that verifies its
access tokens, and the scope names it issues. The scope names are the object the
application already hands `createAuthLifecycle`, so keep them in one place rather than
retyping them here:

```ts
// src/server/auth-scopes.ts — passed to createAuthLifecycle({ authorizationServer: { scopes } })
export const scopes = {
    'mcp:read': 'Read your data',
    'mcp:write': 'Act on your behalf',
};
```

```ts
import { createMcpRoute, McpError } from '@spfn/mcp/server';
import { verifyAccessToken } from '@spfn/auth/server';
import type { McpAuth, McpTool } from '@spfn/mcp';
import { scopes } from './auth-scopes';

type Auth = McpAuth & {
    userId: string;
};

type Context = {
    userId: number;
};

const tools: McpTool<Context>[] = [{
    name: 'greet',
    title: 'Greet user',
    description: 'Create a greeting for the current user.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string' },
        },
        required: ['name'],
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
    },
    handler: async (args, ctx) => ({
        greeting: `Hello ${String(args.name)}`,
        userId: ctx.userId,
    }),
}];

export const mcpRouter = createMcpRoute<Auth, Context>({
    appUrl: 'https://app.example.com',
    serverInfo: {
        name: 'example-app',
        version: '1.0.0',
    },
    validateToken: verifyAccessToken,
    scopesSupported: Object.keys(scopes),
    resolveContext: async auth => {
        const user = await findUser(Number(auth.userId));
        if (!user) {
            throw new McpError(-32002, 'User not found', 403);
        }
        return { userId: user.id };
    },
    listTools: () => tools,
});
```

Register the package router with the application router:

```ts
import { defineRouter } from '@spfn/core/route';
import { mcpRouter } from './mcp';

export const appRouter = defineRouter({
    // Application routes
}).packages([mcpRouter]);
```

`verifyAccessToken` returns `userId` as a **string** — it is the token's subject claim,
not your user table's column type — so `Auth` declares `userId: string` and
`resolveContext` converts it at the one place the application's own numeric id is needed.
An application whose user ids are already strings drops the `Number(...)` and keeps the id
a string end to end.

`verifyAccessToken` returns `null` when it refuses the token — expired, revoked, or
issued for another resource. `validateToken` may signal a refusal that way or by
throwing; the adapter treats `null`, `undefined`, and a thrown error identically.
`@spfn/auth` `0.3.0-beta.19` ships the authorization server that issues these tokens —
see its README section
[Authorization server for MCP clients](../auth/README.md#authorization-server-for-mcp-clients).

The adapter registers `POST`, `GET`, and `DELETE` handlers at `/mcp` and skips SPFN's
session middleware. `validateToken` is therefore the authentication boundary and must
validate the token audience against the supplied `resource` value.

### Discovery

The router also serves the RFC 9728 protected resource metadata document, unauthenticated,
at two paths:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp` — the path-aware form, whose suffix is
  the path of the resolved `resource`. A `resource` of `https://app.example.com/tools` is
  published at `/.well-known/oauth-protected-resource/tools` instead.

Both answer the same bytes:

```json
{
    "resource": "https://app.example.com/mcp",
    "authorization_servers": ["https://app.example.com"],
    "scopes_supported": ["mcp:read", "mcp:write"],
    "bearer_methods_supported": ["header"]
}
```

`scopes_supported` is the list a client picks the `scope` it asks the authorization server
for from (RFC 9728 §2), which is why the wiring above publishes `Object.keys(scopes)`
rather than leaving the field out.

`authorization_servers` defaults to the origin of `appUrl` — the issuer `@spfn/auth`
publishes on the API origin. Override it when the authorization server is deployed
separately:

```ts
authorizationServers: ['https://id.example.com'],
```

These are package routes like `/mcp` itself, so they are relative to wherever the router
is mounted. An application served under a base path publishes them under that base path,
where an MCP client looking at the origin root will not find them; terminate the base path
at the proxy, or set `resourceMetadataUrl` to the URL the client can actually reach.

### The 401 challenge

A request without a bearer token gets the plain challenge, pointing at the path-aware
metadata document:

```
WWW-Authenticate: Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"
```

A request whose bearer token `validateToken` refused gets `error="invalid_token"`
(RFC 6750 §3) as well:

```
WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"
```

The parameter is what lets a client tell the two apart: refresh the token it already has,
or go and authorize for one. `resourceMetadataUrl` overrides the URL in both.

To reuse an existing dispatcher, use the explicit HTTP adapter:

```ts
import { createMcpHttpRoute } from '@spfn/mcp/server';

export const mcpRouter = createMcpHttpRoute({
    dispatcher,
    appUrl: 'https://app.example.com',
    validateToken,
    resolveContext,
});
```

## Local stdio

```ts
import { createMcpDispatcher } from '@spfn/mcp/dispatcher';
import { serveMcpStdio } from '@spfn/mcp/stdio';

const daemonClient = createLocalDaemonClient();
const dispatcher = createMcpDispatcher<LocalAuthority, LocalDaemonClient>({
    serverInfo: { name: 'local-workspace', version: '1.0.0' },
    listTools: () => [{
        name: 'greet',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        },
        handler: (args, daemon) => daemon.greet(String(args.name)),
    }],
});

const bridge = serveMcpStdio({
    dispatcher,
    createSession: () => ({
        auth: { transport: 'stdio' },
        ctx: daemonClient,
    }),
});

await bridge.closed;
```

`serveMcpStdio` writes MCP frames only to stdout. Transport diagnostics use stderr and do
not include the rejected frame or handler exception. EOF, stdin/stdout disconnect,
`SIGINT`, `SIGTERM`, and an explicit `bridge.close()` all close the MCP server and transport
gracefully. Set `signals: false` only when an embedding process owns signal handling.

stdio does not run OAuth. The Agent host deciding which executable and arguments to spawn
is the authorization boundary, so protect the executable and its configuration as local
capabilities. See [`examples/stdio-bridge.ts`](./examples/stdio-bridge.ts) for a thin bridge
that delegates every domain operation to an injected daemon client.

## Package entry points

- `@spfn/mcp` — shared public types and `McpError`
- `@spfn/mcp/dispatcher` — transport-neutral dispatcher
- `@spfn/mcp/server` — OAuth Streamable HTTP adapters for SPFN
- `@spfn/mcp/stdio` — Node.js stdio bridge and lifecycle handle

## Request context

`resolveContext` receives the validated application auth value and request metadata:

```ts
resolveContext: async (auth, request) => ({
    userId: auth.userId,
    protocolEra: request.era,       // "legacy" or "modern"
    requestId: request.requestId,   // correlation ID, not a protocol session ID
});
```

The modern MCP protocol is request-scoped and does not use `Mcp-Session-Id`. Applications
that need durable conversational state should expose an explicit application session or
handle as a tool argument instead of relying on transport state. Legacy 2025 clients are
served through the official SDK's stateless compatibility path.

## Tool results and errors

Plain handler values are returned as text and, for objects, as structured content. A handler
may also return a valid MCP `CallToolResult`; the adapter recognizes it without changing it.

Only `McpError` messages are exposed to MCP clients. Other exceptions become
`Tool execution failed`. Use `onError` for internal reporting and keep secrets out of error
objects and logs.

```ts
onError: async event => {
    await reportMcpFailure(event.operation, event.name);
},
onToolCall: async event => {
    await recordUsage(event.toolName, event.ok, event.requestId);
},
```

## Host and Origin validation

Remote deployments should validate Host and Origin at the reverse proxy or configure
allowlists in the adapter:

```ts
security: {
    allowedHosts: ['app.example.com'],
    allowedOrigins: ['app.example.com'],
},
```

Allowlist values are hostnames without a scheme or port.

## Scope

This package intentionally does not provide an application catalog, grants, billing,
rate limits, a skill registry, or tool discovery policy. Resolve those in application code
and return only the tools the authenticated context may use from `listTools`.

## Migrating from 0.1

Version `0.2` is a deliberate breaking redesign of the hand-written protocol stack in
`0.1`. The SPFN router mount remains the same, but its configuration needs these changes:

- Remove `signer`, `session`, and `protocolVersion`. Protocol negotiation and legacy
  transport compatibility now belong to the official SDK.
- Extend `McpAuth` with application claims such as `userId` or `grantId`; those fields are
  no longer prescribed by the package.
- Change `resolveContext(auth, session)` to `resolveContext(auth, request)`. Use
  `request.requestId` for log and usage correlation. It is not a durable session ID.
- Change `onToolCall` consumers from `event.sessionId` to `event.requestId`.
- Move skill definitions and grant, catalog, billing, and rate-limit policy into the
  consuming application. The old `./skills`, `./server/*`, and `./shared/*` internals are
  not exported by `0.2`.

Applications can keep their existing `defineRouter(...).packages([mcpRouter])` mount and
their existing `listTools` filtering boundary. If application state must survive multiple
tool calls, pass an explicit application-owned handle as a tool argument.

## Related

- [`@spfn/auth`](../auth/README.md) — who your operators are and what each may do. Its
  `hasPermission` and `getUserRole` are what `listTools` and your handlers should ask.
- [`@spfn/core`](../core/README.md) — the route DSL this package mounts onto, and the
  repositories your tools should call.
