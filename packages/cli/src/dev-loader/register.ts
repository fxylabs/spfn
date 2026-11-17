/**
 * Registers the `spfn dev` resolve hook (`./hooks`) in the process it is
 * imported into. `spfn dev` hands this file to the server and watcher
 * processes with `--import`, by absolute path from the CLI's own location, and
 * the application root as its `root` query parameter: the directory `spfn dev`
 * was started in, stated by the runner rather than read from the child's cwd.
 *
 * `module.registerHooks` (Node 22.15+) runs the hook in this thread, inside
 * the asynchronous chain tsx registers with `module.register`: the hook's
 * `nextResolve` is tsx's resolve, and the format it states is what tsx's load
 * receives.
 */

import nodeModule from 'node:module';
import { createResolveHook, type ResolveHook } from './hooks';

/** `module.registerHooks`; the `@types/node` this package builds with predates it. */
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: { resolve: ResolveHook }): void };

const root = new URL(import.meta.url).searchParams.get('root');

if (root === null)
{
    throw new Error('spfn dev-loader: register.js must be imported with ?root=<application root>');
}

registerHooks({ resolve: createResolveHook(root) });
