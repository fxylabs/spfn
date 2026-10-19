/**
 * The `next/*` import specifiers a source file names without their file.
 *
 * `next` ships no `exports` map: `server.js`, `headers.js` and `navigation.js`
 * are plain files at the package root. Next's bundler resolves the bare
 * `next/server`; Node's ESM loader does not, so a published dist entry that
 * says `import … from 'next/server'` throws `ERR_MODULE_NOT_FOUND` the moment
 * it runs outside Next — a vitest suite that externalizes node_modules, a
 * plain `node` import. The file form `next/server.js` resolves in both.
 *
 * One pure function, so the test needs no file system to exercise it. The
 * repository-wide scan lives in the test.
 */

/**
 * A quoted `next/…` specifier in import position: after `from` (static and
 * type-only imports, re-exports), after `import` (side-effect imports) or
 * inside `import(…)` (dynamic imports).
 *
 * The quote has to come straight before `next/`, which is what keeps
 * `@scope/next/server` and `next-intl/server` out; the slash is what keeps the
 * package root `next` out. Text in a comment is only caught when it reads like
 * an import itself — a regex cannot tell more than that, and does not try.
 */
const NEXT_SPECIFIER = /\b(?:from|import)\s*\(?\s*(["'])(next\/[^"']+)\1/g;

/** A specifier that already names a JavaScript file. */
const NAMES_ITS_FILE = /\.[cm]?js$/;

/**
 * The bare `next/<name>` specifiers in `text`, in source order.
 */
export function bareNextSpecifiers(text)
{
    return [...text.matchAll(NEXT_SPECIFIER)]
        .map((match) => match[2])
        .filter((specifier) => !NAMES_ITS_FILE.test(specifier));
}
