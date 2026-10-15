/**
 * State Binding
 *
 * What a state router fixes for each state it groups, keyed by the builder's
 * definition — one per builder instance, so an intermediate builder is never
 * bound: the router's path (a state belongs to one router) and the schema
 * every `read()` result is checked against, built once here rather than per
 * request.
 */

import { Type, type TObject } from '@sinclair/typebox';
import type { StateDefinition } from './types';

export interface StateBinding
{
    path: string;
    resultSchema: TObject;
}

const bindings = new WeakMap<Readonly<StateDefinition>, StateBinding>();

/** `{ value, data }` exactly as declared: `data` when `.data()` is, and nothing else. */
function resultSchema(def: StateDefinition): TObject
{
    return Type.Object(
        {
            value: def.value!,
            ...(def.data ? { data: def.data } : {}),
        },
        { additionalProperties: false },
    );
}

/** Bind a state to the router at `path`. */
export function bindState(def: Readonly<StateDefinition>, path: string): void
{
    bindings.set(def, { path, resultSchema: resultSchema(def) });
}

/** The binding of a state, `undefined` until a router groups that builder. */
export function stateBinding(def: Readonly<StateDefinition>): StateBinding | undefined
{
    return bindings.get(def);
}
