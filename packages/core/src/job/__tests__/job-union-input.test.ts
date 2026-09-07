/**
 * Union input typing
 *
 * `JobHandler`, `send`, `run` and `sendBatch` are conditional on the input
 * type, and a bare `TInput extends void` check distributes that conditional
 * over a union: `A | B | C` becomes three function types whose parameters
 * intersect to `never`, so no caller can pass any member. The tuple wrap in
 * `types.ts` stops the distribution, and these are the cases that prove it —
 * plus the `void`, single-object and inference cases the wrap must not change.
 *
 * The type assertions are checked by `pnpm --filter @spfn/core type-check`
 * (`tsc --noEmit` covers `src/**`), so the `@ts-expect-error` lines fail the
 * build if the rejection they claim ever stops happening. The runtime `it`s
 * below call through a fake pg-boss so the same calls are exercised for real.
 */

import { describe, it, expect, vi, beforeEach, expectTypeOf } from 'vitest';
import { Type } from '@sinclair/typebox';
import { job } from '../job-builder';
import type { InferJobInput, InferJobOutput, JobSendOptions } from '../types';

const { mockBoss } = vi.hoisted(() => ({ mockBoss: { send: vi.fn(), insert: vi.fn() } }));

vi.mock('../boss', () => ({ getBoss: () => mockBoss }));

const payloadSchema = Type.Union([
    Type.Object({ kind: Type.Literal('signup-link'), rowId: Type.Integer() }),
    Type.Object({ kind: Type.Literal('password-reset'), rowId: Type.Integer() }),
    Type.Object({ kind: Type.Literal('account-exists'), target: Type.String() }),
]);

type Payload =
    | { kind: 'signup-link'; rowId: number }
    | { kind: 'password-reset'; rowId: number }
    | { kind: 'account-exists'; target: string };

const seen: Payload[] = [];

// One handler taking the whole union — not three overloads.
const unionJob = job('union-input')
    .input(payloadSchema)
    .output(Type.Object({ kind: Type.String() }))
    .handler(async (payload) =>
    {
        expectTypeOf(payload).toEqualTypeOf<Payload>();
        seen.push(payload);

        return { kind: payload.kind };
    });

const objectJob = job('object-input')
    .input(Type.Object({ userId: Type.String() }))
    .handler(async (input) =>
    {
        expectTypeOf(input).toEqualTypeOf<{ userId: string }>();
    });

const voidJob = job('void-input')
    .handler(async () =>
    {
        // no-op
    });

const MEMBERS: Payload[] = [
    { kind: 'signup-link', rowId: 1 },
    { kind: 'password-reset', rowId: 2 },
    { kind: 'account-exists', target: 'a@example.com' },
];

describe('job types with a union input', () =>
{
    beforeEach(() =>
    {
        mockBoss.send.mockReset().mockResolvedValue('job-id');
        mockBoss.insert.mockReset().mockResolvedValue(undefined);
        seen.length = 0;
    });

    describe('compile-time signatures', () =>
    {
        it('types send, run and sendBatch on the whole union, not per member', () =>
        {
            expectTypeOf(unionJob.send).toEqualTypeOf<
                (input: Payload, options?: JobSendOptions) => Promise<string | null>
            >();
            expectTypeOf(unionJob.run).toEqualTypeOf<(input: Payload) => Promise<{ kind: string }>>();
            expectTypeOf(unionJob.sendBatch).toEqualTypeOf<
                (inputs: Payload[], options?: JobSendOptions) => Promise<void>
            >();
        });

        it('accepts each union member and rejects a non-member', () =>
        {
            // Type-position only: nothing is awaited, so no boss call is made.
            const accepted = [
                () => unionJob.send({ kind: 'signup-link', rowId: 1 }),
                () => unionJob.send({ kind: 'password-reset', rowId: 2 }),
                () => unionJob.send({ kind: 'account-exists', target: 'a@example.com' }),
                () => unionJob.run({ kind: 'signup-link', rowId: 1 }),
                () => unionJob.run({ kind: 'account-exists', target: 'a@example.com' }),
                () => unionJob.sendBatch(MEMBERS),
                () => unionJob.sendBatch([{ kind: 'password-reset', rowId: 3 }]),

                // @ts-expect-error 'welcome' is not one of the three kinds
                () => unionJob.send({ kind: 'welcome' }),
                // @ts-expect-error a signup-link payload carries a rowId
                () => unionJob.run({ kind: 'signup-link' }),
                // @ts-expect-error a non-member is rejected inside the batch too
                () => unionJob.sendBatch([{ kind: 'welcome' }]),
            ];

            expect(accepted).toHaveLength(10);
        });

        it('leaves the void and single-object signatures alone', () =>
        {
            expectTypeOf(voidJob.send).toEqualTypeOf<
                (options?: JobSendOptions) => Promise<string | null>
            >();
            expectTypeOf(voidJob.run).toEqualTypeOf<() => Promise<void>>();
            expectTypeOf(voidJob.sendBatch).toEqualTypeOf<(options?: JobSendOptions) => Promise<void>>();
            expectTypeOf(objectJob.send).toEqualTypeOf<
                (input: { userId: string }, options?: JobSendOptions) => Promise<string | null>
            >();
            expectTypeOf(objectJob.run).toEqualTypeOf<(input: { userId: string }) => Promise<void>>();

            const calls = [
                () => voidJob.send(),
                () => voidJob.send({ priority: 1 }),
                () => voidJob.run(),
                () => objectJob.run({ userId: 'u1' }),

                // @ts-expect-error a void job takes no input
                () => voidJob.run({ userId: 'u1' }),
                // @ts-expect-error a single-object input still has to match
                () => objectJob.run({ userId: 1 }),
            ];

            expect(calls).toHaveLength(6);
        });

        it('infers input and output for void, object and union jobs', () =>
        {
            expectTypeOf<InferJobInput<typeof unionJob>>().toEqualTypeOf<Payload>();
            expectTypeOf<InferJobOutput<typeof unionJob>>().toEqualTypeOf<{ kind: string }>();
            expectTypeOf<InferJobInput<typeof objectJob>>().toEqualTypeOf<{ userId: string }>();
            expectTypeOf<InferJobOutput<typeof objectJob>>().toEqualTypeOf<void>();
            expectTypeOf<InferJobInput<typeof voidJob>>().toEqualTypeOf<void>();
            expectTypeOf<InferJobOutput<typeof voidJob>>().toEqualTypeOf<void>();
        });
    });

    describe('at runtime, through a fake boss', () =>
    {
        it('sends every member and batches them together', async () =>
        {
            for (const member of MEMBERS)
            {
                await unionJob.send(member);
            }
            await unionJob.sendBatch(MEMBERS);

            expect(mockBoss.send.mock.calls.map(([, data]) => data)).toEqual(MEMBERS);
            expect(mockBoss.insert.mock.calls[0][1].map((entry: { data: Payload }) => entry.data))
                .toEqual(MEMBERS);
        });

        it('runs every member through the single handler', async () =>
        {
            const outputs = [];
            for (const member of MEMBERS)
            {
                outputs.push(await unionJob.run(member));
            }

            expect(outputs).toEqual([
                { kind: 'signup-link' },
                { kind: 'password-reset' },
                { kind: 'account-exists' },
            ]);
            expect(seen).toEqual(MEMBERS);
        });
    });
});
