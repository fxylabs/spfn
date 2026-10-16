# @spfn/core/db/transaction — Transaction management & AsyncLocalStorage propagation

Database transactions with `AsyncLocalStorage`-based context propagation. A transaction
started anywhere (the `Transactional` Hono middleware, or `runInTransaction` in a script)
is automatically picked up by every `BaseRepository` operation in the async call chain —
no need to thread a `tx` argument through your code.

## Import paths

All transaction symbols are re-exported from **`@spfn/core/db`**. There is **no**
`@spfn/core/db/transaction` package export subpath and **no** `@spfn/core` root export —
importing from those paths fails to resolve.

```typescript
import {
    Transactional,
    runInTransaction,
    onBeforeCommit,
    onAfterCommit,
    onAfterRollback,
    getTransaction,
    getTransactionContext,
    runWithTransaction,
} from '@spfn/core/db';

import type {
    TransactionDB,
    TransactionContext,
    TransactionalOptions,
    RunInTransactionOptions,
    BeforeCommitCallback,
    AfterCommitCallback,
    AfterRollbackCallback,
} from '@spfn/core/db';
```

---

## Public API (complete)

From `@spfn/core/db`:

- `Transactional(options?)` — Hono middleware; wraps a route handler in a transaction.
- `runInTransaction(callback, options?)` — run a callback in a transaction (scripts/CLI; no Hono).
- `onBeforeCommit(callback)` — run work inside the root transaction, just before it commits.
- `onAfterCommit(callback)` — defer a side effect until after the root transaction commits.
- `onAfterRollback(callback)` — compensate after the work it was registered with rolled back.
- `getTransaction()` — current transaction `TransactionDB`, or `null`.
- `getTransactionContext()` — current `TransactionContext` (`tx`, `txId`, `level`, callbacks), or `null`.
- `runWithTransaction(tx, txId, callback)` — bind a `tx` into `AsyncLocalStorage` for a callback.
- Types: `TransactionDB`, `TransactionContext`, `NestedFrameGate`, `TransactionalOptions`, `RunInTransactionOptions`, `BeforeCommitCallback`, `AfterCommitCallback`, `AfterRollbackCallback`.

> `getTransactionId()` and `asyncContext` exist in `context.ts` but are **not** exported
> from the module index — do not import them. Use `getTransactionContext()?.txId` if you
> need the ID.

> **`runWithTransaction` takes three arguments**: `(tx, txId, callback)`. Older docs that
> call it as `runWithTransaction(tx, callback)` are wrong and will mis-bind the callback as
> the `txId` string.

---

## How propagation works (read this first)

`Transactional` and `runInTransaction` both go through `runInTransaction`, which:

1. Resolves the **write** DB (`getDatabase('write')`).
2. Opens a transaction. With no ambient transaction on the call chain that is
   `writeDb.transaction(...)` — a real `BEGIN` on a pooled connection. With one, it is
   `ambientTx.transaction(...)` instead: a **SAVEPOINT on the connection the outer
   transaction already holds**. (`requiresNew: true` forces the first shape — see
   [Nested transactions](#nested-transactions-savepoints).)
3. Calls `runWithTransaction(tx, txId, callback)` to store `{ tx, txId, level, beforeCommitCallbacks, afterCommitCallbacks, afterRollbackCallbacks, nestedFrames }` in a global `AsyncLocalStorage`.

Inside that callback, any code that calls `getTransaction()` gets the live `tx`. The key
consumer is **`BaseRepository`**: its `db` and `readDb` getters call `getTransaction()`
first and use the transaction if present, otherwise fall back to the global write/read
instance:

```typescript
// BaseRepository (simplified)
protected get db()      { return getTransaction() ?? getDatabase('write'); }
protected get readDb()  { return getTransaction() ?? getDatabase('read');  }
```

Consequence: **inside a transaction you write normal repository code** — `userRepo.create(...)`,
`postRepo.findById(...)` — and they all join the same transaction automatically. You almost
never call `getTransaction()` yourself.

> Inside a transaction, `readDb` also resolves to the transaction connection (not the read
> replica). Reads within a tx see its own uncommitted writes and run on the primary.

---

## Quick Start

### Route middleware

```typescript
import { route } from '@spfn/core/route';
import { Transactional } from '@spfn/core/db';
import { Type } from '@sinclair/typebox';

export const createUser = route.post('/users')
    .input({ body: Type.Object({ email: Type.String(), name: Type.String() }) })
    .use([Transactional()])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        // Both repo calls automatically join the same transaction.
        const user = await userRepo.create(body);
        await profileRepo.create({ userId: user.id, bio: 'New user' });

        return user;            // success → commit
        // any throw         → rollback
    });
```

### Script / CLI

```typescript
import { runInTransaction } from '@spfn/core/db';

await runInTransaction(async (tx) =>
{
    // `tx` is passed in AND available via getTransaction() to nested repo calls.
    const [user] = await tx.insert(users).values({ name: 'John' }).returning();
    await profileRepo.create({ userId: user.id }); // also joins this tx
    return user;
}, { context: 'script:seed-user', timeout: 60000 });
```

---

## `Transactional(options?)` — Hono middleware

Wraps the downstream handler chain in a transaction. Commits when the handler resolves,
rolls back when it throws **or** when Hono stored an error on the context (`c.error`).

```typescript
.use([Transactional({
    slowThreshold: 2000,   // warn if the tx runs longer than 2s (default 1000)
    enableLogging: false,  // silence per-tx logs (default true)
    timeout: 60000,        // PG statement_timeout in ms (default 30000 / TRANSACTION_TIMEOUT)
})])
```

### Error conversion (rollback path)

On rollback the middleware re-throws, but normalizes the error first:

1. Reports the error to the DB reconnect-trigger (no-op for non-connection errors). This sees
   every error, whatever the steps below decide.
2. Any `SerializableError` is re-thrown unchanged — the whole framework family, `DatabaseError`
   and `TransactionError` included, plus every application error class that extends it. These
   already carry a `statusCode` and a `toJSON()` envelope, so converting them could only take
   those away. An application error is re-thrown here **even if it carries a `code` field**,
   which a coded refusal (`403` + `code: 'TENANT_SUSPENDED'`) typically does.
3. A genuine driver error is converted via `fromPostgresError(...)` → `DuplicateEntryError`,
   `ConstraintViolationError`, `DeadlockError`, `ConnectionError`, `TransactionError`, or
   `QueryError`. "Genuine" means one of two shapes. Either `code` is one of the names postgres.js
   invents for the errors it raises itself (`CONNECTION_CLOSED`, `CONNECTION_ENDED`,
   `CONNECTION_DESTROYED`, `CONNECT_TIMEOUT`, `CONNECTION_CONNECT_TIMEOUT` — the same list the
   reconnect-trigger uses), which carry no severity; or `code` is SQLSTATE-shaped
   (`/^[0-9A-Z]{5}$/`) **and** the error carries a `severity` or `severity_local` field, which is
   what postgres.js copies off the server's `ErrorResponse`. An arbitrary `code` is not enough —
   Stripe (`resource_missing`), jose (`ERR_JOSE_*`), the AWS SDK and Node (`ECONNRESET`) all set one.
4. Anything else (e.g. business-logic errors like `InvalidCredentialsError`) is re-thrown as-is.

The gate is deliberately narrow: a hand-rolled `{ code: '23505' }` with no severity field is
**not** converted. That trades a fake-driver edge case for the guarantee that no application
error is ever flattened into a `QueryError 500` (issue #82). The driver's own connection codes are
the one exception to the severity requirement — they name their origin unambiguously, so a socket
that dies mid-transaction still reaches the client as a `QueryError` envelope rather than a bare
`Error`.

Note that Drizzle wraps driver errors in a `DrizzleQueryError` that carries no `code` of its own,
so a query error raised inside the handler reaches the caller as that wrapper, with the driver's
`PostgresError` on `.cause`. Step 3 fires for errors that reach the middleware unwrapped. The
reconnect-trigger in step 1 walks the `cause` chain, so it sees the driver error either way.

### `TransactionalOptions`

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `slowThreshold` | `number` | `1000` | ms; logs a `warn` if commit/rollback exceeds it |
| `enableLogging` | `boolean` | `true` | start/commit/rollback debug logs |
| `timeout` | `number` | `30000` / `env.TRANSACTION_TIMEOUT` | PostgreSQL `statement_timeout` in ms |
| `idleTimeout` | `number` | `30000` / `env.TRANSACTION_IDLE_TIMEOUT` | PostgreSQL `idle_in_transaction_session_timeout` in ms |
| `requiresNew` | `boolean` | `false` | when the middleware runs nested, open an independent transaction instead of a SAVEPOINT — see [Nested transactions](#nested-transactions-savepoints) |

---

## `runInTransaction(callback, options?)`

The engine under both the middleware and standalone use. `callback` receives the Drizzle
`tx`; the same `tx` is also available via `getTransaction()` to anything it calls.

```typescript
function runInTransaction<T>(
    callback: (tx: TransactionDB) => Promise<T>,
    options?: RunInTransactionOptions,
): Promise<T>;
```

For an injected driver, supply its database type as the second generic. The callback then
receives that driver's matching Drizzle transaction type:

```typescript
import type { PgliteDatabase } from 'drizzle-orm/pglite';

type AppDatabase = PgliteDatabase<typeof schema>;

await runInTransaction<void, AppDatabase>(async (tx) =>
{
    await tx.insert(schema.users).values({ id: 'user-1' });
});
```

### `RunInTransactionOptions`

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `slowThreshold` | `number` | `1000` | ms; must be a non-negative integer or it throws `TransactionError` |
| `enableLogging` | `boolean` | `true` | |
| `timeout` | `number` | `env.TRANSACTION_TIMEOUT` (30000) | see timeout semantics below |
| `idleTimeout` | `number` | `env.TRANSACTION_IDLE_TIMEOUT` (30000) | see timeout semantics below |
| `context` | `string` | `'transaction'` | label in logs (the middleware passes `"METHOD /path"`) |
| `requiresNew` | `boolean` | `false` | run in an independent transaction instead of joining an ambient one — see [Nested transactions](#nested-transactions-savepoints) |

### Timeout semantics

`timeout` becomes a `SET LOCAL statement_timeout = <ms>` issued at the start of the **root**
transaction (via `sql.raw`, since `SET` can't be parameterized). Resolution order is
`options.timeout ?? env.TRANSACTION_TIMEOUT`:

- `timeout: 0` — disables the timeout (unlimited).
- `null` / `undefined` — falls back to `env.TRANSACTION_TIMEOUT` (default 30000).
- `N` — must be an integer in `0 … 2147483647` (PG max int4). Out-of-range / non-integer values throw `TransactionError` (status 400) before any DB access.

Timeout is applied **only to root transactions**. A nested call takes a SAVEPOINT on the
outer transaction's connection, where that transaction's `SET LOCAL statement_timeout` is
already in force — so the nested call **inherits** it, and its own `timeout` is ignored (a
`warn` is logged only when the caller passed one explicitly; inheriting the root's is the
normal case). Issuing `SET LOCAL` there would re-scope the entire outer transaction, not
just the savepoint. A `requiresNew: true` call is a root on its own connection and gets its
own timeouts.

`idleTimeout` is the companion knob: `SET LOCAL idle_in_transaction_session_timeout = <ms>`,
also root-only, resolved as `options.idleTimeout ?? env.TRANSACTION_IDLE_TIMEOUT` (default
30000). Where `statement_timeout` bounds a single query's run time, this bounds how long the
transaction may sit **idle** (no query running) — e.g. while the handler awaits external I/O.
On expiry Postgres terminates the session and rolls back, **reclaiming the pooled connection**
instead of letting one stuck request hold it (and its row locks) indefinitely. `0` disables it.
This is a backstop, not a license — see the anti-pattern below.

### Validation / errors

`runInTransaction` fails fast with a `TransactionError` (before opening a transaction) when:
`callback` is not a function; `slowThreshold` is negative/non-integer; `timeout` is
non-integer, negative, or above the max; or the write database is not initialized
(status 500). Errors thrown by `callback` itself propagate unchanged after rollback.

---

## Nested transactions (SAVEPOINTs)

Nesting **is** supported. When `runInTransaction` / `Transactional` runs while an
`AsyncLocalStorage` context already exists, the runner opens the inner transaction off the
ambient one (`ambientTx.transaction(...)`), so Drizzle issues a PostgreSQL `SAVEPOINT` on the
connection the outer transaction already holds, and `runWithTransaction` increments `level`
(root = 1).

```typescript
await runInTransaction(async () =>              // level 1 (root, real BEGIN)
{
    await userRepo.create(...);

    try
    {
        await runInTransaction(async () =>      // level 2 (SAVEPOINT, same connection)
        {
            await postRepo.create(...);
            throw new Error('inner');           // ROLLBACK TO the SAVEPOINT
        });
    }
    catch
    {
        // The catch is what makes this "the post was optional". Without it the
        // error keeps propagating out of the root callback and rolls the ROOT
        // back too — the savepoint limits what the ERROR undoes, never where it
        // travels.
    }

    await auditRepo.record(...);                // the root is healthy; keep going
});                                             // root commits the user + the audit row
```

Behavior to know:

- **One connection.** The nested call runs on the outer transaction's connection —
  `pg_backend_pid()` is equal at every level. It therefore sees the outer transaction's
  **uncommitted** writes, takes no second checkout from the pool, and cannot deadlock
  against a row the outer transaction locked.
- **One commit.** Nested writes are durable only when the **root** commits. There is no
  intermediate commit at a savepoint boundary.
- The inner level has **hook queues of its own**: a hook belongs to the savepoint that
  registered it. A savepoint that resolves hands its hooks to its parent; one that rolls
  back runs its `onAfterRollback` callbacks right there — inside the **parent's** context,
  the root still open — and drops its `onBeforeCommit` / `onAfterCommit` callbacks, even
  when the root goes on to commit. See
  [Hooks belong to the frame that registered them](#hooks-belong-to-the-frame-that-registered-them).
- **One at a time.** Nested calls made off the same transaction are serialized: a frame
  opens only after the previous frame on that connection has closed. See
  [Concurrent nested calls](#concurrent-nested-calls-are-serialized).
- `timeout` passed to a nested call is ignored; the root's timeout is already in force on
  the shared connection and governs. A `warn` is logged only if you passed a `timeout`
  explicitly — inheriting the root's is the normal case and says nothing worth logging.
- An inner rollback unwinds to its savepoint; the outer can catch and continue issuing
  statements. This holds for a failed *statement* too: inside a savepoint, PostgreSQL's
  aborted-transaction state (`25P02`) unwinds to the savepoint rather than poisoning the
  whole transaction.

> **⚠️ BREAKING (from the release that introduced this)**
>
> A nested call **used to open an independent transaction on a second pooled connection**,
> despite these docs. It committed on its own, could not see the outer transaction's
> uncommitted writes, and self-deadlocked on rows the outer transaction had locked. It is now
> a SAVEPOINT, as documented.
>
> **Code that relied on a nested call committing independently must now pass
> `requiresNew: true`.** The usual case is an audit or failed-attempt record that must
> survive the outer rollback. Everything else — the overwhelming majority of nesting, where
> the inner work is simply part of the outer unit — needs no change and silently gets
> correct behavior.
>
> **Second dimension: nested calls made off one transaction no longer run concurrently.**
> They used to hold a connection each, so `Promise.all` over them really did overlap. They
> now share the outer transaction's connection, where overlapping savepoints corrupt each
> other, so the runner serializes them — `Promise.all([nestedA(), nestedB()])` still
> resolves with both results, just one after the other, and a call chain that fanned out
> N nested calls for latency loses that parallelism. Give a branch `requiresNew: true` to
> get its own connection back, and read
> [Concurrent nested calls](#concurrent-nested-calls-are-serialized) for the one shape that
> deadlocks.

### `requiresNew: true` — opt back out into an independent transaction

Available on both `runInTransaction` and `Transactional()`. It opens a real `BEGIN` on a
second pooled connection, ignoring the ambient transaction entirely:

```typescript
await runInTransaction(async () =>
{
    await orderRepo.create(order);

    // Commits on its own — lands even though the outer transaction rolls back below.
    await runInTransaction(
        () => auditRepo.record('order.attempted', order.id),
        { requiresNew: true },
    );

    await inventoryRepo.reserve(order.items);   // throws → outer rolls back
});
```

Being a root transaction, it gets its own `statement_timeout`, its own
`idle_in_transaction_session_timeout`, and its **own** hook queues: `onBeforeCommit` /
`onAfterCommit` / `onAfterRollback` registered inside it fire on **its** outcome, not the
outer transaction's. `getTransactionContext()?.level` reads `1` inside it, however deeply it
sits lexically — `level` counts savepoint depth, and this call is a root.

Two costs, both consequences of the second connection — this is where the pool-starvation
caveat that used to apply to *every* nested call now lives:

- It holds a **second connection** for its whole duration, so the call chain counts twice
  against the pool. Keep it short, and don't fan it out.
- It cannot see the outer transaction's uncommitted writes, and it **blocks** on any row the
  outer transaction has locked. Since the outer transaction is waiting for this call to
  return, that block is a **self-deadlock** that only `statement_timeout` breaks. Never touch
  rows the outer transaction wrote.

### Concurrent nested calls are serialized

Two nested calls under `Promise.all` would be two savepoints on **one** connection, and
`ROLLBACK TO` unwinds the connection, not a branch of it — so a failing sibling would
discard everything written since its savepoint, including the other sibling's rows, while
that sibling reported success. The runner therefore **queues nested frames per transaction**:
a frame opens only after the frame before it on that connection has closed.

```typescript
// Still correct — and now genuinely atomic per branch. Just not parallel:
// stepB's SAVEPOINT is taken after stepA's frame has closed.
await Promise.all([
    runInTransaction(() => stepA()),
    runInTransaction(() => stepB()),
]);
```

The queue belongs to the transaction the frames are opened off, so it never blocks depth
(a nested call inside `stepA` waits on `stepA`'s own queue, which is empty) and never
touches `requiresNew`, which runs on a connection of its own.

- **You lose the parallelism, not the results.** Both branches still run and both results
  still come back. If the fan-out existed for latency, give each branch `requiresNew: true`
  — separate connections, genuinely concurrent, and each commits on its own instead of with
  the root.
- **⚠️ One shape deadlocks: a nested call whose callback awaits a sibling that was started
  after it.** The waiting frame holds the queue, so the sibling behind it can never open,
  and nothing breaks the cycle — `statement_timeout` does not fire, because no statement is
  running. This is misuse rather than a guarded case: the runner cannot see which promise a
  callback is blocked on, and a wait limit would have to guess how long a legitimate sibling
  may run — aborting slow-but-correct transactions. The first time frames contend, one `warn`
  ("Concurrent nested transactions are serialized") is logged per process, so the hazard is
  on the record before it can hang.

  ```typescript
  // ❌ Deadlock: A entered the queue first, so it holds it — and it is waiting for
  //    B, which is queued behind A and can never open. Frames open in the order the
  //    calls were made, so this needs the awaited sibling to be created AFTER the
  //    waiting one; the reverse (create B first, await it from A) is fine, because
  //    B has already run by the time A opens.
  const a = runInTransaction(async () => { await b; });
  const b = runInTransaction(() => stepB());

  await Promise.all([a, b]);
  ```

Statements issued **directly** on the outer transaction have the same hazard and no queue
to protect them: `Promise.all([tx.insert(...), runInTransaction(() => stepB())])` writes the
outer row after `stepB`'s savepoint was taken, so `stepB` failing discards it. Don't overlap
outer-transaction work with an open nested frame either.

### Operational caveats of the driver's savepoints

Verified against the pinned driver (`drizzle-orm` 1.0.0-rc.4 over `postgres` 3.4.7) by
logging the SQL it emits — worth knowing before nesting deeply or in a loop:

- **`RELEASE SAVEPOINT` is never issued.** The driver emits `savepoint "sN"` on entry and
  `rollback to "sN"` on failure, and nothing at all on success — the savepoint simply stays
  defined until the root transaction ends. Names are unique per transaction (`s0`, `s1`, …),
  so nothing shadows anything; they just accumulate.
- **A write inside a nested frame costs a subtransaction, and the backend caches 64.** Each
  savepoint that writes assigns a subtransaction id. PostgreSQL keeps 64 of them per backend
  (`PGPROC_MAX_CACHED_SUBXIDS`); beyond that the backend is marked *suboverflowed*, and other
  sessions' visibility checks stop being answerable from shared memory and go to `pg_subtrans`
  on disk instead — a cliff that slows the **whole cluster's** snapshot checks, not just this
  transaction. Measured on PostgreSQL 16.15: `subxact_count` climbs to 64 and
  `subxact_overflowed` flips to `true` on the 65th write-savepoint.
- **Practical rule:** don't put a nested `runInTransaction` inside a loop over more than a
  few dozen rows. Do the batch as one statement, or as plain repository calls in the outer
  transaction — nesting per row buys nothing unless you need per-row rollback.

---

## Transaction hooks

Three hooks attach work to a transaction's lifecycle. All three take
`() => void | Promise<void>`, are registered the same way from anywhere inside the async
call chain, and queue on the **frame** — root or savepoint — they were registered in
(`BeforeCommitCallback`, `AfterCommitCallback`, `AfterRollbackCallback` are the exported
type aliases). A frame's queues reach the root only through savepoints that resolved; see
[Hooks belong to the frame that registered them](#hooks-belong-to-the-frame-that-registered-them).

| Hook | Runs | Still inside the tx? | If the callback throws |
|------|------|----------------------|------------------------|
| `onBeforeCommit(cb)` | after the root callback resolves, **before** `COMMIT` | **yes** — may run statements | aborts: later callbacks skipped, transaction rolls back, error propagates, `afterRollback` fires |
| `onAfterCommit(cb)` | after the root transaction committed | no | logged, never thrown |
| `onAfterRollback(cb)` | after the root transaction rolled back — or, registered in a savepoint that rolled back, right after that savepoint did | no after a root rollback; after a savepoint rollback it runs inside the **parent's** still-open transaction | logged, never thrown; the **original** error keeps propagating unchanged |

Registration context:

| Context | `onBeforeCommit` | `onAfterCommit` | `onAfterRollback` |
|---------|------------------|-----------------|-------------------|
| Inside root transaction | Queued; runs before the root's commit | Queued; runs after the root commits | Queued; runs if the root rolls back |
| Inside a nested transaction | Queued on the savepoint; passed to the parent if it resolves, dropped if it rolls back | Queued on the savepoint; passed to the parent if it resolves, dropped if it rolls back | Queued on the savepoint; passed to the parent if it resolves, **run at once** if it rolls back |
| Outside any transaction | Runs immediately on a microtask **+ `warn` log** — nothing left to commit, so a throw aborts nothing | Runs immediately on a microtask (already "committed") | **No-op + `warn` log** — there is no rollback to wait for |

### `onBeforeCommit(callback)`

The last moment the transaction is still open. Use it for cross-cutting work that must be
part of the same commit — a final invariant check, an audit row, a denormalized counter —
without threading it through every call site.

```typescript
import { runInTransaction, onBeforeCommit } from '@spfn/core/db';

async function transfer(fromId: string, toId: string, amount: number)
{
    // The transaction is what gives the check teeth — see the warning below.
    await runInTransaction(async () =>
    {
        await accountRepo.debit(fromId, amount);
        await accountRepo.credit(toId, amount);

        // Runs inside the transaction: a throw rolls the whole transfer back.
        onBeforeCommit(() => assertNoNegativeBalance(fromId));
    });
}
```

- Runs **inside** the transaction context: `getTransaction()` returns the live `tx`, and
  repositories called from a callback join the same transaction, so their writes are part
  of the same commit.
- Runs in registration order, one at a time, and only after the user callback resolved
  successfully — the runner never starts this pass on a transaction that already failed.
  (If your own code *swallowed* a statement error, PostgreSQL has aborted the transaction
  and every statement here fails with `25P02` — but so would the `COMMIT`; the hook only
  surfaces that earlier.)
- A throw is not caught: later callbacks are skipped, the transaction rolls back, the error
  propagates to the caller, and `afterRollback` callbacks fire.
- **Registered outside a transaction, the hook keeps none of that.** The callback runs
  immediately on a microtask and a `warn` is logged: there is nothing to abort, so a
  throwing invariant check is swallowed into a log line while the write it meant to prevent
  has already committed. Always register it from inside `runInTransaction`/`Transactional`.
- The queue is **snapshot before the pass**: a callback registered *by* a beforeCommit
  callback does not run for this commit. Growing the queue mid-iteration would loop forever
  inside the open transaction (with `statement_timeout` powerless — no statement is
  running), so the snapshot is deliberate, not incidental.
- Calling `onAfterCommit` from a beforeCommit callback works — the queue is read after the
  beforeCommit pass.

### `onAfterCommit(callback)`

Defer a side effect (notifications, jobs, analytics, cache busting) until **after** the data
is durably committed.

```typescript
import { onAfterCommit } from '@spfn/core/db';

async function submit(spaceId: string, chatId: string)
{
    const publication = await publicationRepo.create({ spaceId, chatId });
    await requestRepo.updateStatusAtomically(requestId, 'submitted');

    onAfterCommit(() => generateArticle(spaceId, chatId, publication.id));

    return publication;
}
```

- Callbacks run **outside** the transaction context — a `getTransaction()` inside one
  returns `null`, so DB work uses a fresh connection (a new transaction, not this one).
- Fire-and-forget: each callback runs via `Promise.resolve().then(cb).catch(log)`. Errors
  are logged, never thrown, and never affect the (already committed) transaction.
- Execution is FIFO in registration order; multiple callbacks per transaction are fine.
- If the transaction **rolls back**, queued callbacks never run.

### `onAfterRollback(callback)`

Compensate for non-transactional work once the transaction is known to be gone — delete an
uploaded object, release a reserved external id, mark a cached intent as failed.

```typescript
import { runInTransaction, onAfterRollback } from '@spfn/core/db';

async function importAvatar(userId: string, file: Blob)
{
    // Upload first: external I/O never belongs inside the transaction.
    const key = await objectStore.put(file);

    await runInTransaction(async () =>
    {
        await userRepo.updateAvatar(userId, key);

        // The upload cannot roll back on its own — undo it if the write never lands.
        onAfterRollback(() => objectStore.delete(key));
    });
}
```

- Fires on **any** root rollback: a thrown handler error, a thrown `onBeforeCommit`
  callback, a statement timeout, a constraint violation.
- Registered inside a savepoint, it fires when **that savepoint** rolls back — at that
  moment, whatever the root does afterwards — and not again at the root.
- After a **root** rollback, callbacks run **outside** the transaction context
  (`getTransaction()` is `null`) — DB work in them uses a fresh connection, like
  `onAfterCommit`. After a **savepoint** rollback the root is still open and they run
  inside the **parent's** context: `getTransaction()` is the parent's `tx`, and DB work in
  them joins the parent transaction — it commits only if the parent does.
- They are **awaited**, in registration order, before the causing error leaves
  `runInTransaction` / the middleware (for a savepoint: the nested call). A callback that
  hangs delays that error, so keep them short.
- Errors are logged and swallowed: a failing callback never replaces the error that caused
  the rollback, never stops the remaining callbacks, and neither does a failure of the log
  call itself.
- The trigger is "the transaction did not report success", which is *almost* always a
  rollback. A connection lost at exactly the `COMMIT` leaves the outcome genuinely unknown
  to the client, and these callbacks fire — so a compensation should be idempotent and
  safe to run against data that did, in the end, land.

### Hooks belong to the frame that registered them

Every frame — the root and each savepoint — has queues of its own, and its **own** fate
decides what happens to the hooks registered in it:

- **A savepoint that resolves** appends its three queues to its parent's, after what the
  parent registered before the nested call and before what it registers after. Its hooks
  now share the parent's fate: `onBeforeCommit` still runs before the **root's** `COMMIT`
  (not at the savepoint — the driver never releases one), `onAfterCommit` after the root
  commits, `onAfterRollback` if the root rolls back. Promotion repeats level by level, so a
  hook fires exactly once, and only if every savepoint between it and the root resolved.
- **A savepoint that rolls back** drops its `onBeforeCommit` and `onAfterCommit`
  callbacks — the work they guard or announce is gone — and runs its `onAfterRollback`
  callbacks immediately, awaited before the error leaves the nested call, inside the
  parent's still-open transaction. Hooks promoted into it from savepoints nested inside it
  go the same way. A compensation may call `runInTransaction` itself: that opens a savepoint
  on the parent, and a hook the compensation registers belongs to the parent.
- **A statement that fails inside a savepoint's `onAfterRollback` aborts the parent.** The
  root-rollback pass runs outside any transaction, so a failing statement there touches
  nothing; the savepoint pass runs inside the parent's transaction, so a failing statement
  puts it into the aborted state (`25P02`). The callback's error is logged and swallowed as
  always, but the root's next statement then fails with `25P02` (current transaction is
  aborted). If the root runs none, its `COMMIT` fails with the callback's error. Either way,
  everything the root wrote rolls back. Wrap DB work in a compensation in its own
  `runInTransaction` (a savepoint) when it may fail.
- **The root** runs whatever reached it. A savepoint failure the root catches and survives
  fires none of the **root's** own `afterRollback` callbacks: the root did not roll back.
- A `requiresNew: true` call is a root on its own connection: hooks registered inside it
  belong to it and fire on its own commit or rollback, never handed to the outer
  transaction.
- **A hook registered after its frame has settled is dropped**, the same as one registered
  after a root has settled. A frame's queues are handed on (or discarded) once, at the
  moment it settles; detached work it started — a `setTimeout`, an un-awaited promise —
  that registers a hook later appends to a queue nobody reads again. Register hooks in the
  awaited call chain of the frame they belong to.

### Why there is no `onBeforeRollback`

The moment does not exist. A rollback is triggered by a statement error, which puts the
PostgreSQL session into the aborted-transaction state (`25P02`): every subsequent statement
except `ROLLBACK` fails with *"current transaction is aborted, commands ignored until end of
transaction block"*. A hook there could not read, write, or log to the database — the only
thing it could do is non-DB work, which belongs in `onAfterRollback`, where it runs on a
healthy connection.

---

## Low-level: `getTransaction` / `getTransactionContext` / `runWithTransaction`

You normally don't touch these — `BaseRepository` already resolves the transaction for you.
Reach for them only when writing a custom wrapper, or for a repository-less helper that must
manually honor an ambient transaction.

```typescript
import { getTransaction, getTransactionContext, runWithTransaction } from '@spfn/core/db';

getTransaction();          // TransactionDB | null
getTransactionContext();   // { tx, txId, level, ...hook queues, nestedFrames } | null

// Bind an existing Drizzle tx so nested code sees it via getTransaction().
// NOTE the 3-arg signature: (tx, txId, callback)
await db.transaction(async (tx) =>
{
    return await runWithTransaction(tx, `tx_${crypto.randomUUID()}`, async () =>
    {
        // getTransaction() === tx here and in everything this calls
        return doWork();
    });
});
```

> Prefer `runInTransaction` over hand-rolling `db.transaction()` + `runWithTransaction`:
> the runner adds the `txId`, timeout enforcement, slow-tx logging, and the hook-queue
> plumbing that raw `runWithTransaction` does not. `runWithTransaction` creates the queues,
> but only the runner ever fires them — hooks registered under a hand-rolled
> `runWithTransaction` never run.

---

## Pitfalls & anti-patterns

- **Never do external I/O inside a transaction.** A transaction holds a pooled connection
  (and any row locks taken) from `BEGIN` to `COMMIT`. If the handler awaits an external API,
  queue, or other non-DB work while the transaction is open, that connection sits idle but
  reserved — under load, in-flight requests cap out at the pool size and everything else
  queues. Route-level `Transactional()` wraps the **whole handler**, so it's especially easy
  to fall into; prefer scoping the transaction to the DB statements (call `runInTransaction`
  inside a service around just the writes). The `idle_in_transaction_session_timeout` backstop
  reaps the worst case, and a "Slow transaction" `warn` flags offenders — but the fix is to
  move the I/O out. If you have a write → external-call → write flow where the external call
  has a side effect (charge, send), don't span it with a transaction at all — commit intent,
  call outside the transaction, then commit the result (outbox / saga).
- **Import from `@spfn/core/db`, not `@spfn/core/db/transaction` or `@spfn/core`.** Neither
  of the latter is a real package export — they don't resolve.
- **`runWithTransaction` is `(tx, txId, callback)`.** Calling it with two args silently
  binds your callback into the `txId` slot. If you only have repositories, you don't need
  this function at all — start a transaction with `runInTransaction`/`Transactional`.
- **Don't pass `tx` around manually when using repositories.** Repositories read the
  ambient transaction via `getTransaction()`. Threading a `tx` parameter is redundant and
  invites bugs where one path forgets it.
- **Don't nest a raw `db.transaction()` without `runWithTransaction`.** A raw
  `db.transaction()` opens a Drizzle SAVEPOINT but does **not** update `AsyncLocalStorage`,
  so repositories inside it still use the *outer* tx, not the savepoint — your "inner"
  rollback won't isolate as expected. Use `runInTransaction` (which wires both) instead.
- **`timeout` on a nested call is ignored.** Set the timeout on the outermost
  transaction/middleware; an explicitly passed nested value is dropped with a warning, and
  the root's timeout governs the savepoint anyway.
- **Concurrent nested calls are serialized, and one shape of them deadlocks.** Sibling
  savepoints share the outer transaction's connection, so the runner queues them; `Promise.all`
  over nested calls is correct but no longer parallel. A nested call whose callback *awaits a
  sibling started after it* hangs forever — see
  [Concurrent nested calls](#concurrent-nested-calls-are-serialized).
- **Don't open a nested transaction per row in a loop.** Each writing savepoint burns one of
  the backend's 64 cached subtransaction ids and is never released before the root ends; past
  that the backend goes suboverflowed and every other session's visibility checks get slower.
- **`requiresNew: true` costs a second connection and can self-deadlock.** Use it only when
  the inner work must survive an outer rollback (an audit row, a failed-attempt record), keep
  it short, and never let it touch rows the outer transaction wrote.
- **Side effects belong in `onAfterCommit`, not the handler body.** Calling a notifier /
  job / external API directly in the handler runs it *before* commit and holds the
  transaction (and its pooled connection) open. If the tx later rolls back, you've already
  fired the side effect.
- **`onAfterCommit` DB work runs in a new connection, not this transaction.** It executes
  after the context is gone, so `getTransaction()` is `null` inside it — its writes are a
  separate transaction and won't roll back with the original.
- **No external I/O in `onBeforeCommit`.** It runs *inside* the transaction, so an API call
  there holds the connection open exactly like one in the handler body. Keep it to DB work
  and cheap invariant checks; anything else belongs in `onAfterCommit`.
- **`onAfterRollback` is not a "retry the write" hook.** It runs after the transaction is
  gone, on a fresh connection. Use it to undo work that was never transactional in the first
  place (an upload, an external reservation), not to re-attempt the failed statements.
- **Keep transactions short.** No network I/O / file uploads inside the tx — do that work
  first, then run only the DB writes in the transaction (see example below). Long
  transactions hold connections and can exhaust the pool.
- **`getTransaction()` returns `null` outside a transaction.** It is not a "get me a db"
  helper. For plain DB access use a `BaseRepository` or `getDatabase()`.

```typescript
// ❌ Long transaction: external work holds the tx + connection open
.use([Transactional()])
.handler(async (c) =>
{
    const data = await fetch('https://api.example.com').then(r => r.json()); // I/O in tx
    await userRepo.create(data);
    await uploadFile(file);                                                  // I/O in tx
    return { ok: true };
});

// ✅ External work first, DB writes only inside the transaction
.handler(async (c) =>
{
    const data = await fetch('https://api.example.com').then(r => r.json());
    await uploadFile(file);

    return runInTransaction(async () =>
    {
        const user = await userRepo.create(data);
        onAfterCommit(() => notify(user.id));   // side effect after commit
        return user;
    });
});
```

---

## Complete example

```typescript
// routes/publications.ts
import { route } from '@spfn/core/route';
import { Transactional, onAfterCommit } from '@spfn/core/db';
import { Type } from '@sinclair/typebox';

export const submit = route.post('/publications')
    .input({ body: Type.Object({ spaceId: Type.String(), chatId: Type.String() }) })
    .use([Transactional({ timeout: 15000, slowThreshold: 2000 })])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        // Repositories auto-join the middleware's transaction.
        const publication = await publicationRepo.create(body);
        await requestRepo.updateStatusAtomically(body.chatId, 'submitted');

        // Fires only after the transaction commits; runs on a fresh connection.
        onAfterCommit(() => generateArticle(body.spaceId, body.chatId, publication.id));

        return publication;     // commit; a throw here → rollback (PG errors normalized)
    });
```

```typescript
// scripts/backfill.ts — same propagation, no Hono
import { runInTransaction } from '@spfn/core/db';

await runInTransaction(async (tx) =>
{
    const rows = await tx.select().from(legacy);
    for (const row of rows)
    {
        await userRepo.create(mapLegacy(row)); // joins this tx via getTransaction()
    }
}, { context: 'script:backfill', timeout: 0 /* disable timeout for a long backfill */ });
```

---

## Types reference

```typescript
type TransactionDB<TDatabase = DefaultDatabase> = DatabaseTransaction<TDatabase>;

type BeforeCommitCallback = () => void | Promise<void>;
type AfterCommitCallback = () => void | Promise<void>;
type AfterRollbackCallback = () => void | Promise<void>;

type TransactionContext<TDatabase = DrizzleDatabase> = {
    tx: TransactionDB<TDatabase>;                     // live Drizzle transaction
    txId: string;                                     // "tx_<uuid>" — tracing id
    level: number;                                    // nesting depth, root = 1
    beforeCommitCallbacks: BeforeCommitCallback[];    // shared with the root
    afterCommitCallbacks: AfterCommitCallback[];      // shared with the root
    afterRollbackCallbacks: AfterRollbackCallback[];  // shared with the root
    nestedFrames: NestedFrameGate;                    // own — queues THIS context's frames
};

type NestedFrameGate = {
    run<T>(frame: () => Promise<T>): Promise<T>;      // internal; the runner calls it
};

interface TransactionalOptions {
    slowThreshold?: number;   // default 1000 (ms)
    enableLogging?: boolean;  // default true
    timeout?: number;         // default 30000 / env.TRANSACTION_TIMEOUT (ms)
    idleTimeout?: number;     // default 30000 / env.TRANSACTION_IDLE_TIMEOUT (ms)
    requiresNew?: boolean;    // default false — independent tx instead of a SAVEPOINT
}

interface RunInTransactionOptions {
    slowThreshold?: number;   // default 1000 (ms)
    enableLogging?: boolean;  // default true
    timeout?: number;         // default env.TRANSACTION_TIMEOUT (30000 ms)
    idleTimeout?: number;     // default env.TRANSACTION_IDLE_TIMEOUT (30000 ms)
    context?: string;         // default 'transaction'
    requiresNew?: boolean;    // default false — independent tx instead of a SAVEPOINT
}
```

## Related

- [@spfn/core/db](../README.md) — database connection, `BaseRepository`, `getDatabase`
- [@spfn/core/config](../../config/README.md) — `TRANSACTION_TIMEOUT` and other settings
- [@spfn/core/errors](../../errors/README.md) — `TransactionError`, `DatabaseError`, `fromPostgresError` results
