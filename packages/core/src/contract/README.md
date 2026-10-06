# @spfn/core/contract — Route contracts and the backward-compatibility gate

A **contract** is what a route promises to a client the server cannot redeploy: a mobile app in the
store, an external API consumer. `.contract()` declares that promise on the route, a codegen plugin
writes every promise into `contracts/current.json`, and the build refuses a change that would break
an already-released client.

```
route.get(...).contract({...})  →  contracts/current.json  →  compared against contracts/released/<version>.json
```

## The failure this exists to stop

The server drops a response field. Every server test passes. The app in the store draws a blank
screen on its next launch. Today the only thing preventing that is somebody remembering.

The request half of a route already exists at runtime — method, path and the TypeBox input schema
live on `RouteDef`. The response half does not: `_response` on `RouteDef` is a type-inference slot
that disappears after compilation, so no check could ever be written against it. `.contract()`
supplies the missing runtime value.

**A web client does not need this.** `createApi<AppRouter>()` derives its types from the router in
the same build and the same deploy, so a removed response field breaks the TypeScript compile.
The clients that need a contract are the ones compiled and shipped separately.

## Import paths

| Path | Contents |
|------|----------|
| `@spfn/core/route` | `.contract()` on the route builder, `RouteContract`, `RouteAuthProfile` |
| `@spfn/core/event` | `.contract()` on `defineEvent` and `defineEventRouter`, `EventContract`, `EventRouterContract` |
| `@spfn/core/contract` | Everything below: collect, compare, snapshots, usage, the gate |
| `@spfn/core/codegen` | `@spfn/core:contract` generator, `ContractGeneratorConfig` |

## 1. Declare the promise

```ts
import { Type } from '@sinclair/typebox';
import { route } from '@spfn/core/route';

export const getUser = route.get('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .contract({
        since: '1.2.0',
        auth: 'clientProofV1',
        requiresSession: true,
        response: Type.Object({
            id: Type.String(),
            name: Type.String(),
            email: Type.Optional(Type.String()),
        }),
    })
    .handler(async (c) => { /* … */ });
```

| Field | Meaning |
|-------|---------|
| `response` | Response shape, as a TypeBox schema. **Declared, not inferred.** An operation with no body declares `Type.Null()`. |
| `since` | Contract version the operation first appeared in. |
| `auth` | `'none'` (called before any key exists — enrollment, login) or `'clientProofV1'`. Defaults to `'none'`. |
| `requiresSession` | Whether the call carries a session. Defaults to `false`. |
| `deprecatedIn` | Contract version the operation was announced for removal in. Optional. |
| `removedIn` | Contract version the operation was removed in. Optional — see below. |

A route without `.contract()` is untouched — it simply never appears in the contract.

**`removedIn` outlives the route it names.** A client generated before the removal still calls the
operation, and a route that simply disappears tells that client nothing — the call fails and no
record says the operation went, or when. Keeping the route alive with `removedIn` set is what turns
a disappearance into an announcement. The three markers are one deprecation path: mark
`deprecatedIn` and the build still passes; wait while deployed clients roll over; remove and record
`removedIn`. How long the middle step runs depends on how fast clients update, which is policy and
not something the contract decides.

## 1b. Declare the contract version

```ts
export const appRouter = defineRouter({ getUser, listItems })
    .contractVersion('1.2.0')
    .packages([authRouter]);
```

This is the version's **source**. A released snapshot is named from it — `writeSnapshot` reads
`document.contractVersion` and writes `contracts/released/1.2.0.json` — so the filename follows the
code rather than the code having to be told what the filename said. It is also what lets a running
server announce the version it serves, which a filename cannot do.

Without it the generator still writes `current.json` and still runs the compatibility gate. What it
cannot do is cut a release, and `writeSnapshot` refuses with a message saying so.

A value that is not `major.minor.patch` throws where it is declared, rather than much later in a
build step: releases are ordered by this string, and a version that cannot be ordered cannot gate
anything.

**Why response shape is declared and not inferred.** A TypeScript-type extractor was considered and
rejected: generics, conditional and utility types make it emit silently wrong types, and a wrong
contract is worse than none.

**Why there is no separate `.output()`.** An early design split the two, on the reasoning that
response validation helps every route while a public promise applies to a few. The first half is
false — web has a compile-time contract already — and the split needed a rule saying "`.contract()`
without `.output()` is a build error". Two things that must always appear together are one thing.

## 2. Register the generator

```ts
// .spfnrc.ts
import { defineConfig, defineGenerator } from '@spfn/core/codegen';
import type { ContractGeneratorConfig } from '@spfn/core/codegen';

export default defineConfig({
    generators: [
        defineGenerator<ContractGeneratorConfig>({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: './src/generated/route-map.ts',
        }),
        defineGenerator<ContractGeneratorConfig>({
            name: '@spfn/core:contract',
            routerPath: './src/server/router.ts',
            outputDir: './contracts',
        }),
    ],
});
```

| Option | Default | Meaning |
|--------|---------|---------|
| `routerPath` | — | Router file, relative to the project root. Required. |
| `routerExport` | `appRouter`, then `default`, then `router` | Export holding the `defineRouter()` result. |
| `eventRouterPath` | — | Event router file, relative to the project root. Set it to publish contracted SSE events — see [Events](#events). |
| `eventRouterExport` | `eventRouter`, then `default` | Export holding the `defineEventRouter()` result. |
| `outputDir` | `./contracts` | Directory holding `current.json`, `released/` and `usage/`. |
| `additionalRouteDirs` | `[]` | Extra directories to watch, for routes outside `src/server/routes`. |

Hanging the contract off codegen is the point: `spfn build` and `spfn dev` run it, so "forgot to
regenerate the contract" stops being a failure mode — the same job route-map codegen already does
for web.

**`dev` generates; `build` also gates.** Refusing a half-finished route mid-edit would make the
feature unusable, so the gate runs on the `build` trigger only.

## 3. Cut a release

```bash
spfn contract check              # regenerate, compare against the newest snapshot
spfn contract release 1.3.0      # write contracts/released/1.3.0.json — commit it
spfn contract list               # what has been released
```

```
contracts/
  current.json          regenerated every build, committed
  released/
    1.2.0.json          the promise 1.2.0 made. Never edited.
    1.3.0.json
  usage/
    ios-2.4.1.json      what a released app actually calls
```

**Every release writes a snapshot.** The gate compares against the newest snapshot alone, which is
sound only because compatibility is transitive down an unbroken chain. A release that skipped its
snapshot puts a gap in the chain and silently widens what passes. `spfn contract release` therefore
refuses a version that is not newer than the newest one on disk, so a gap cannot be filled in later
behind the gate's back.

Each snapshot carries the SHA-256 of its own document. A hand-edited snapshot fails the gate rather
than quietly moving the baseline.

## The case table

Everything the gate does is this table. Tests derive from it one-to-one.

### Operations

| Change | Previous snapshot exists | No snapshot yet |
|--------|--------------------------|-----------------|
| operation added | pass | pass |
| operation removed | **usage check** (below) | pass |
| path changed | refuse | pass |
| method changed | refuse | pass |

An operation is identified by its **name** — the key it holds in the router — not by method and
path. That is what lets a moved path be reported as a broken promise instead of read as one
operation vanishing and another appearing. Names must therefore be unique across the whole router
tree; two contracted routes sharing a name is refused at generation time.

### Events

A native app subscribes to SSE events by name and decodes each payload itself. Without the events
in the contract both are hand-written, and both break at runtime — the stream answers 400 with
`validEvents`, or a decoder throws — instead of at build. Contracted events close that gap.

| Change | Previous snapshot exists | No snapshot yet |
|--------|--------------------------|-----------------|
| event added | pass | pass |
| event removed | **usage check**, against the usage file's `events` | pass |
| stream path changed | refuse (`events.stream-path-changed`) | pass |
| auth mode changed | refuse (`events.auth-changed`) | pass |
| payload field added | pass | pass |
| payload field removed | refuse (`event.payload.field-removed`) | pass |
| payload required → optional | refuse (`event.payload.field-became-optional`) | pass |
| payload optional → required | pass | pass |
| payload type or constraint changed | refuse (`event.payload.type-changed`) | pass |
| baseline has no `events` section | pass — nothing was promised | pass |
| current has no `events` section | every baseline event is **removed** | pass |

A payload flows server → client, so it is judged under the **response** rules — the same walk,
with the violation kinds renamed.

**Declaring.** Opt in per event, and once on the router:

```ts
// src/server/events.ts
import { defineEvent, defineEventRouter } from '@spfn/core/event';

const sessionActivity = defineEvent('session.activity', Type.Object({ sessionId: Type.String() }))
    .contract({ since: '1.0.0' });             // deprecatedIn?, removedIn? as on routes

export const eventRouter = defineEventRouter({ sessionActivity })
    .contract({ auth: 'tokenExchange' });      // streamPath?: string, default '/events/stream'
```

and point the generator at the file with `eventRouterPath: './src/server/events.ts'`. An event
without `.contract()` is untouched and never appears. A router with no contracted event produces no
`events` section at all, so an app that contracts none writes exactly the document it wrote before.

`.contract()` on an event may be called once — an event is defined once and shared, so a second call
throws instead of one declaration silently winning. A router `streamPath` that does not start with
`/` throws where it is declared.

**Refused at collection**, each with a message saying what to do:

- contracted events on a router with no `.contract()` of its own — the contract cannot say whether
  a client must exchange a token first;
- a contracted event without a payload schema (`defineEvent(name)`) — its frame carries no `data`;
  declare `Type.Object({})` and emit `{}` instead;
- a contracted event under the key `connected` or `ping` — those are the stream's own frames;
- a contracted event with no `since`.

**What a reader of the document needs.**

```json
"events": {
    "streamPath": "/events/stream",
    "tokenPath": "/events/token",
    "auth": "tokenExchange",
    "items": [{ "name": "sessionActivity", "since": "1.0.0", "payload": { "type": "object", "…": "…" } }]
}
```

- `name` is the **router key** — what a client lists in `?events=` and what the frame's `event:`
  field carries. `defineEvent`'s first argument never reaches the wire and is not published. The same
  `EventDef` registered under two keys is two items.
- A frame's `data` is the JSON `{ "event": name, "data": payload }`, with `payload` matching the
  item's schema.
- `connected` (once, when the stream opens) and `ping` (keep-alive) frames are the stream's own and
  are not items.
- With `auth: "tokenExchange"` the client first posts to `tokenPath`, then opens
  `streamPath?events=…&token=…`. `tokenPath` is derived from `streamPath` exactly as the server
  derives it.
- An `authorize` hook may narrow which contracted events a given connection receives. That is
  per-connection policy, not a promise the contract makes, and the document does not describe it.

**The boot check.** The generator reads the event router only, never the server config. So
`createServer` checks the router's contract against `.events()` before anything is served: the
contract's `streamPath` (default `/events/stream`) must equal the path `.events()` registers, and
`auth: 'tokenExchange'` must match `.events({ auth: { enabled: true } })`. A mismatch refuses to
boot:

```
SSE event router contract declares streamPath /sse but .events() registers /events/stream; the contract would describe a path the server does not serve
```

A router without `.contract()` is not checked.

**Conditional registration is refused here too.** `defineEventRouter({ ...(flag ? { x } : {}) })`
in the event router file stops the generator, for the same reason as a conditional route.

### Request — safe when the server grows more tolerant

| Change | Result | Why |
|--------|--------|-----|
| field added (optional) | pass | an old app need not send it |
| field added (required) | **refuse** | every old app's request is now rejected |
| field removed | pass | an old app may still send it; the server ignores it |
| required → optional | pass | the server accepts more |
| optional → required | **refuse** | apps that never sent it break |
| type changed | **refuse** | |

### Response — the direction is reversed

| Change | Result | Why |
|--------|--------|-----|
| field added | pass | an old app ignores what it does not know |
| field removed | **refuse** | an old app was reading it |
| required → optional | **refuse** | an app that counted on it always arriving breaks |
| optional → required | pass | it only becomes more certain |
| type changed | **refuse** | |

**Optional runs in opposite directions on the two sides.** A request is safe when the server grows
more tolerant; a response is safe when the server grows more certain. Collapsing both into one rule
necessarily gets one of them backwards.

A field is judged at its own level. A required field nested inside a newly added *optional* object
is fine: an app that never sends the object is never asked for it.

Interceptor fields are compared under the request rules. A web client never sends them — middleware
fills them in — but a client that talks to the route directly does, so they are part of the
published request shape.

### No snapshot yet

Everything passes, **with a warning**. "This is the first contract" and "the release forgot to write
a snapshot" produce the same empty directory, and only a person can tell them apart.

## Removing an operation

A removal is decided against `contracts/usage/<platform>-<appVersion>.json`, which each released
client writes:

```json
{ "platform": "ios", "appVersion": "2.4.1", "operations": ["getUser", "listItems"], "events": ["sessionActivity"] }
```

`events` lists the contracted events the client subscribes to. A file without the key subscribes
to none — an app released before events were contracted cannot be subscribed to one — and a value
that is not an array of names is refused like a bad `operations`. A removed event is judged by the
table below exactly as a removed operation, and a client still listing it is reported as
`usage.still-subscribed` with its platform and version.

| Situation | Verdict |
|-----------|---------|
| usage directory missing, or holds no file | **refuse** — undecidable, which is not a pass |
| any file unreadable or the wrong shape | **refuse**, naming the file |
| every file read, nobody calls it | pass — the only pass |
| some app calls it | refuse, naming **which platform and version** |

The rule this table exists for: **an unreadable file and "nobody calls it" are different answers.**
An empty scan result reading as a pass is how a removal check quietly stops checking anything.

Usage files are read only when something is actually removed. An app that removes nothing never
needs one to exist.

## What the gate does not check

Named here rather than left to be discovered:

- **`auth`, `requiresSession` and `since` changes.** Moving an operation from `none` to
  `clientProofV1` breaks every released client, and the gate does not stop it. It was outside the
  approved case table; adding it is a deliberate decision, not a quiet extension.
- **Runtime response validation.** Whether a handler actually returns what it declared is a separate
  feature from generating a contract, and integration tests already cover it for contracted routes.
- **WebSocket.** The contract covers REST operations and SSE events; a WebSocket router is not
  contracted.
- **`since` and `deprecatedIn` changes on an event**, and per-connection narrowing by `authorize`.
- **How a client produces its usage file.** That belongs to the client's toolchain.
- **Multipart routes are refused, not checked.** See below.

## Multipart is outside a contract

A contracted route that declares `formData` — on its `.input()` or its `.interceptor()` — is
refused at collection:

```
Contracted route "uploadAvatar" declares input.formData, which a contract cannot describe.
```

Multipart is a transport-format problem rather than a type problem: the contract describes JSON
values, and a file part has no spelling among them. The refusal is loud on purpose. Quietly
leaving the section out would produce a contract that still claimed to describe the operation,
and a client generated from it would look right until the request reached the server.

An uncontracted multipart route is untouched — `formData` is a normal part of `.input()` and only
`.contract()` on the same route is refused. Either drop `.contract()`, or move the operation to a
JSON body and upload the file through its own uncontracted route.

## Pitfalls

- **Route modules must be importable without side effects.** The contract is read from the loaded
  router, not parsed from source — real routes build schemas from imported values (`EmailSchema`,
  `FileSchema()`, constants) that no source parser can resolve. Loading costs a module import and no
  infrastructure: `@spfn/auth`'s 43 routes load in ~0.6s with no `DATABASE_URL` and no `CACHE_URL`.
  A module that opens a connection at import time would break that, and the generator refuses loudly
  rather than skipping the module.
- **Contracted routes are registered unconditionally.** A route behind a feature flag or an
  environment check makes the contract describe whichever way the generator happened to run. The
  generator refuses a `defineRouter({...})` containing a computed spread (`...(flag ? {x} : {})`);
  a spread of a plain identifier (`...baseRoutes`) is fine.
- **`NODE_ENV` is pinned when unset.** The generator sets it to `production` before loading, so a
  schema that reads the environment cannot make the contract depend on the shell it ran in. The pin
  is process-wide and shared with `@spfn/core:route-map`, so both generators in one run read the
  same environment whichever `.spfnrc.ts` lists first.
- **Path aliases come from the project root's `tsconfig.json`.** `compilerOptions.paths` is read
  (`extends` followed) and handed to jiti, so a router importing `@/server/routes/users` loads. A
  mapping held in any other tsconfig is not read, and the failure names the specifier that did not
  resolve.
- **A failed build still rewrites `current.json`.** That is deliberate — the regenerated file is
  what the gate compared, so `git diff` shows exactly what broke.
- **Constraint changes count as type changes.** Narrowing `maxLength`, an `enum` or a `format` is
  refused. That is stricter than the table's "type changed" row strictly requires and it refuses in
  the recoverable direction: a stopped build is fixed by cutting a version, a break that passes
  reaches a shipped app.

## Public API

```ts
// @spfn/core/route
route.get('/x').contract({ since, response, auth?, requiresSession?, deprecatedIn?, removedIn? })
defineRouter({...}).contractVersion('1.2.0')    // the version's source
type RouteContract, RouteAuthProfile

// @spfn/core/event
defineEvent(name, schema).contract({ since, deprecatedIn?, removedIn? })
defineEventRouter({...}).contract({ auth, streamPath? })
type EventContract, EventRouterContract

// @spfn/core/contract
collectContractDocument(router, eventRouter?)   // Router (+ event router) → ContractDocument
compareDocuments(before, after)                 // → { violations, removedOperations, removedEvents }
compareOperation(before, after)                 // → ContractViolation[]
checkContract(contractsDir, current)            // the gate → { baselineVersion, violations, warnings }
formatViolations(violations)                    // → the message a failing build prints

readCurrentDocument(dir) / writeCurrentDocument(dir, document)
listSnapshots(dir) / newestSnapshot(dir) / readSnapshot(file) / writeSnapshot(dir, document)
readUsageRecords(usageDir) / callersOf(operation, records) / subscribersOf(event, records)
compareVersions(a, b)
canonicalize / stableStringify / stableStringifyPretty / stableDigest

// @spfn/core/codegen
createContractGenerator(config)                 // registered as '@spfn/core:contract'
assertUnconditionalRegistration(path, source)
```

## Related

- [`../route/README.md`](../route/README.md) — the route DSL `.contract()` hangs off
- [`../codegen/README.md`](../codegen/README.md) — the generator system it plugs into
- [`../../../auth/README.md`](../../../auth/README.md) — the `clientProofV1` auth profile
