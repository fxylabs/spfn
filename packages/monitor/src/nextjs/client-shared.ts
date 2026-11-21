/**
 * What `@spfn/monitor/nextjs/client` takes from the rest of the package
 *
 * `nextjs/client` is a build of its own (`tsup.client.config.ts`), for its
 * `'use client'` banner, so it cannot share the main build's chunks: a module it
 * reached by a relative path would be a second copy. It imports these through
 * the package's private `#nextjs/client-shared` instead (`imports` in
 * `package.json`), which is this entry of the main build. Not exported.
 */

export { summarizeError, type Description } from '../error-summary';
