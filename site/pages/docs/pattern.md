---
title: The SPFN Pattern
order: 3
description: One vertical slice per feature — entity, repository, route, router — so an AI coding agent fills in a known architecture instead of inventing one.
---

## Why the shape is fixed

An AI coding agent asked for "add orders" twice produces two different codebases. Nothing
in a plain Next.js project tells it where things go, so it decides again every time, and
each decision is reasonable in isolation.

SPFN removes the decision. Every feature is the same vertical slice with the same parts in
the same places. There is exactly one place for everything — which is what makes the
codebase navigable for agents and humans alike, and what makes a tenth feature cost the
same as the first.

```text
src/
├── server/
│   ├── entities/todo.ts       # Drizzle table — the data shape
│   ├── repositories/todo.ts   # extends BaseRepository — persistence
│   ├── routes/todos.ts        # route.get/post/… with TypeBox — the API contract
│   └── router.ts              # defineRouter — registration
└── generated/
    └── route-map.ts           # pnpm codegen output — never hand-edited
```

The generated file is output, not a layer. Generated files are never editing targets.

## Entity

The Drizzle table is the single source of truth for the shape of your data.
Migrations are generated from it (`pnpm spfn db generate`) — never written by hand.

```ts
import { pgTable, text, boolean } from 'drizzle-orm/pg-core';
import { id, timestamps } from '@spfn/core/db';

export const todos = pgTable('todos', {
    id: id(),
    title: text('title').notNull(),
    done: boolean('done').notNull().default(false),
    ...timestamps(),
});

export type Todo = typeof todos.$inferSelect;
```

## Repository

A repository extends `BaseRepository` and owns all data access for its entity. Routes and
services never touch the ORM directly. The protected `_findMany` / `_findOne` / `_create`
helpers take the table as their first argument.

```ts
import { BaseRepository } from '@spfn/core/db';
import { desc } from 'drizzle-orm';
import { todos } from '../entities/todo';

export class TodoRepository extends BaseRepository
{
    async findAll(limit = 10)
    {
        return await this._findMany(todos, { orderBy: desc(todos.createdAt), limit });
    }

    async createTodo(data: { title: string })
    {
        return await this._create(todos, data);
    }
}
```

## Route

Routes declare their contract with TypeBox. The schema validates at runtime and types the
client at compile time — one declaration, both jobs.

```ts
import { route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';
import { TodoRepository } from '../repositories/todo';

const todoRepo = new TodoRepository();

export const createTodo = route.post('/todos')
    .input({
        body: Type.Object({
            title: Type.String({ minLength: 1 }),
        }),
    })
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await todoRepo.createTodo(body);
    });
```

## Router

`defineRouter` registers the slice. This object is the API contract, and its type is what
the client reads.

```ts
import { defineRouter } from '@spfn/core/route';
import { createTodo } from './routes/todos';

export const appRouter = defineRouter({ createTodo });

export type AppRouter = typeof appRouter;
```

## Codegen closes the loop

The typed client infers everything from `AppRouter` — no generated client code. What does
need codegen is the RPC proxy's route map, which forwards browser calls to the SPFN server.
Run it after any route change and commit the output:

```bash
pnpm codegen          # spfn codegen run
```

```ts
const api = createApi<AppRouter>();

const todo = await api.createTodo.call({ body: { title: 'ship it' } });
```

Every call goes through the route's exported name, not its URL. Change the route's schema
and every consumer fails to compile until it catches up — the compiler catches what
integration tests used to.

## Guardrails around the slice

Type safety is one guardrail here, not the point. The others:

- **Runtime validation.** TypeBox rejects a bad request before your handler sees it.
- **Generated migrations.** The schema produces the SQL; nobody writes it by hand.
- **A build that fails on a broken contract.** A route can declare what separately
  deployed clients are promised with `.contract({ since, response, … })`, and
  `spfn contract check` compares the current routes against the last released snapshot.
  A breaking change stops the build instead of reaching a shipped mobile app.
- **Explicit module boundaries.** One import path per concern, so an agent editing
  persistence cannot quietly reach into routing.

## Where to go next

- [Get started](../docs.md) — create a project and run it.
- [Prototype to Production](./prototype-to-production.md) — the same slice, all the way
  through deploy and `spfn ops` operations.
- [Packages](./packages.md) — what ships beyond the core.
- [Runnable examples](https://github.com/fxylabs/spfn/tree/main/examples) — the
  pattern end to end, from minimal API to auth.
