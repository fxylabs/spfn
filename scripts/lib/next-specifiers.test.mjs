/**
 * `node --test scripts/lib/` — `next/*` specifiers are spelled the way their
 * subpath needs: the file form (#147), except a bare `next/navigation` (#151).
 *
 * | #  | target                 | expected                                                          |
 * |----|------------------------|-------------------------------------------------------------------|
 * | N2 | src of every package   | zero misspelled `next/*` specifiers                               |
 * | N3 | the scanner            | each bare fixture and each `next/navigation` file form reported   |
 * | N4 | the scanner            | `.js` form, bare navigation, root `next`, other packages, comment: none |
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { misspelledNextSpecifiers } from "./next-specifiers.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const packagesDirectory = join(repositoryRoot, "packages");

/** Shipped TypeScript sources — tests run under Next's resolution or vitest's, never from dist. */
function isShippedSource(path)
{
    return /\.tsx?$/.test(path)
        && !/\.test\.[^/]+$/.test(path)
        && !path.split("/").includes("__tests__");
}

/** Every shipped source under `packages/<name>/src`, as paths relative to the repository root. */
function shippedSources()
{
    return readdirSync(packagesDirectory)
        .flatMap((name) =>
        {
            const source = join(packagesDirectory, name, "src");

            return readdirSync(source, { recursive: true })
                .map((path) => join(source, path));
        })
        .filter(isShippedSource)
        .map((path) => relative(repositoryRoot, path));
}

test("N2: no package source misspells a next/* specifier", () =>
{
    const found = shippedSources().flatMap((path) =>
        misspelledNextSpecifiers(readFileSync(join(repositoryRoot, path), "utf8"))
            .map((specifier) => `${path}: ${specifier}`));

    assert.deepEqual(found, []);
});

test("N3: each bare next/* specifier and each next/navigation file form is reported", () =>
{
    assert.deepEqual(misspelledNextSpecifiers("import { NextResponse } from 'next/server';"), ["next/server"]);
    assert.deepEqual(misspelledNextSpecifiers("const { headers } = await import('next/headers');"), ["next/headers"]);
    assert.deepEqual(misspelledNextSpecifiers("import type { NextRequest } from 'next/server';"), ["next/server"]);
    assert.deepEqual(misspelledNextSpecifiers("import { redirect } from \"next/navigation.js\";"), ["next/navigation.js"]);
    assert.deepEqual(misspelledNextSpecifiers("const { notFound } = await import('next/navigation.mjs');"), ["next/navigation.mjs"]);
});

test("N4: file-form, bare navigation, root, other-package and comment mentions are not reported", () =>
{
    const fixtures = [
        "import { NextResponse } from 'next/server.js';",
        "const { headers } = await import('next/headers.js');",
        "import { redirect } from 'next/navigation';",
        "import type { NextConfig } from 'next';",
        "import { getTranslations } from 'next-intl/server';",
        "import { thing } from '@scope/next/server';",
        "// NextResponse comes from next/server",
        "/* 'next/server' has no exports map */",
    ];

    for (const fixture of fixtures)
    {
        assert.deepEqual(misspelledNextSpecifiers(fixture), [], fixture);
    }
});
