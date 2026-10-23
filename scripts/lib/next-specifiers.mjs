/**
 * The `next/*` import specifiers a source file spells the wrong way.
 *
 * `next` ships no `exports` map: `server.js`, `headers.js` and `navigation.js`
 * are plain files at the package root. Next's bundler resolves the bare
 * `next/server`; Node's ESM loader does not, so a published dist entry that
 * says `import … from 'next/server'` throws `ERR_MODULE_NOT_FOUND` the moment
 * it runs outside Next — a vitest suite that externalizes node_modules, a
 * plain `node` import. The file form `next/server.js` resolves in both (#147).
 *
 * `next/navigation` is the exception, and it stays bare. Turbopack swaps the
 * exact request `next/navigation` for its server build in a route handler;
 * `next/navigation.js` is not swapped, so the client build is bundled there,
 * it reaches for the app router context the route module does not vendor, and
 * `next build` stops (#151). A Node loader that has to resolve it is told so
 * where it runs — a vitest alias or `server.deps.inline` — not in dist.
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

/** The file extension a specifier names, if it names one. */
const FILE_EXTENSION = /\.[cm]?js$/;

/** The subpaths Next's bundler only swaps when they are spelled bare. */
const SWAPPED_WHEN_BARE = new Set(["next/navigation"]);

/**
 * Whether `specifier` is spelled the way its subpath needs: bare for one Next
 * swaps, the file form for every other.
 */
function isSpelledRight(specifier)
{
    const bare = specifier.replace(FILE_EXTENSION, "");

    return SWAPPED_WHEN_BARE.has(bare) ? specifier === bare : specifier !== bare;
}

/**
 * The wrongly spelled `next/<name>` specifiers in `text`, in source order.
 */
export function misspelledNextSpecifiers(text)
{
    return [...text.matchAll(NEXT_SPECIFIER)]
        .map((match) => match[2])
        .filter((specifier) => !isSpelledRight(specifier));
}
