/**
 * TypeScript, loaded on first use
 *
 * Two things here read TypeScript's own parser: the `paths` a router's imports
 * resolve through, and the guard that reads `defineRouter({...})` out of the
 * router file. Both run only while a router is being read.
 *
 * `generators/index.ts` is re-exported from `@spfn/core/codegen`, so a
 * top-level `import ts from 'typescript'` loaded the whole compiler wherever
 * that entry is imported: `spfn dev` startup, the watcher child, every
 * `.spfnrc.ts` evaluation, and `spfn codegen list` — none of which resolve an
 * alias or parse a router. It cost ~0.3s and ~70MB to hand back a factory
 * function.
 *
 * `createRequire` rather than a dynamic `import()`: both callers are
 * synchronous, and the guard's whole job is to run before anything is written.
 */

import { createRequire } from 'module';

let compiler: typeof import('typescript') | undefined;

/** The compiler, loaded on the first call and kept for the rest of the process. */
export function typescript(): typeof import('typescript')
{
    compiler ??= createRequire(import.meta.url)('typescript') as typeof import('typescript');

    return compiler;
}
