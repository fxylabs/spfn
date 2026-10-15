/**
 * State Module
 *
 * A server-owned state declared once derives its read route, its write route,
 * its entry in the snapshot route and its SSE event. See README.md.
 *
 * @example
 * ```typescript
 * import { defineState, defineStateRouter } from '@spfn/core/state';
 * import { Type } from '@sinclair/typebox';
 *
 * export const consent = defineState('consent')
 *     .value(Type.Union([Type.Literal('pending'), Type.Literal('agreed')]))
 *     .read(({ subject }) => consents.current(subject));
 *
 * export const states = defineStateRouter({ consent });
 *
 * // after a commit that changed it:
 * await consent.changed.emit({ subject: userId });
 * ```
 */

// Builder
export { defineState, StateBuilder } from './state-builder';

// Router
export { defineStateRouter } from './state-router';
export type {
    InferStateInput,
    InferStateKey,
    InferStateValue,
    StateEvents,
    StateRouter,
    StateRouterOptions,
    StateRoutes,
    StatesSnapshot,
} from './state-router';
export type { SubjectResolver } from './state-routes';

// Types
export type {
    ChangedPayload,
    GrantTarget,
    PermissionContext,
    ReadContext,
    RevokeTarget,
    RoutableState,
    StateContract,
    StateFrame,
    StateKey,
    StateResult,
    StateShape,
    StateSnapshot,
    StateValue,
    StateWriteOptions,
    WriteContext,
} from './types';
