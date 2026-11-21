/**
 * A package's private imports resolve in what it publishes (#398).
 *
 * A package whose `'use client'` entry is a tsup build of its own cannot share the main build's
 * chunks, so it reaches the main build's modules through a private `imports` name in
 * `package.json` (`#nextjs/client-shared`), which points at an entry of the main build. Nothing
 * else notices when that entry goes missing: the builds, `tsc` and the unit tests (which alias
 * the name to source) stay green, and only an app's `next build` fails.
 *
 * `checkPrivateImports`, called from a package's `scripts/check-bundle.mjs`: every `#…`
 * specifier a `dist` file imports — statically or through an `import('…')` with a literal
 * specifier — resolves through the package's `imports` map to an existing file that exports
 * the names imported; every one in a `dist` declaration file resolves, under the `types`
 * condition, to an existing declaration file, as a consumer's type-check resolves it.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** What an import or re-export statement takes by name from its module; `*` takes none. */
function importedNames(statement)
{
    if (ts.isImportDeclaration(statement))
    {
        const clause = statement.importClause;
        const named = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements
            : [];

        return [...(clause?.name !== undefined ? ['default'] : []), ...named.map(element => (element.propertyName ?? element.name).text)];
    }
    const clause = statement.exportClause;

    return clause !== undefined && ts.isNamedExports(clause)
        ? clause.elements.map(element => (element.propertyName ?? element.name).text)
        : [];
}

/**
 * The module a node imports from, with the names it takes, or undefined for any other node:
 * an import or re-export statement, an `import('…')` expression with a literal specifier, or
 * an `import('…')` type. The expression and the type take no name a reader can see.
 */
function importOf(node)
{
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined)
    {
        return { specifier: node.moduleSpecifier.text, names: importedNames(node) };
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]))
    {
        return { specifier: node.arguments[0].text, names: [] };
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
    {
        return { specifier: node.argument.literal.text, names: [] };
    }

    return undefined;
}

/** Every `#…` import anywhere in the files of `dist` matching `pattern`: the file, the specifier and the names. */
function privateImports(dist, pattern, scriptKind)
{
    return readdirSync(dist, { recursive: true })
        .filter(file => pattern.test(file))
        .flatMap((file) =>
        {
            const found = [];
            const visit = (node) =>
            {
                const imported = importOf(node);
                if (imported?.specifier.startsWith('#'))
                {
                    found.push({ file: `dist/${file}`, ...imported });
                }
                ts.forEachChild(node, visit);
            };
            visit(ts.createSourceFile(file, readFileSync(join(dist, file), 'utf-8'), ts.ScriptTarget.Latest, true, scriptKind));

            return found;
        });
}

/** Why `specifier`, resolved by `resolveSpecifier`, does not give `file` the names it imports, or undefined when it does. */
async function privateImportProblem(resolveSpecifier, { file, specifier, names })
{
    const target = (() =>
    {
        try
        {
            return fileURLToPath(resolveSpecifier(specifier));
        }
        catch
        {
            return undefined;
        }
    })();
    if (target === undefined || !existsSync(target))
    {
        return `${file} imports ${specifier}, which \`imports\` in package.json does not resolve to an existing file`
            + (target === undefined ? '' : ` (${relative(process.cwd(), target)})`);
    }
    const exported = await import(target).then(Object.keys, error => error);
    if (exported instanceof Error)
    {
        return `${file} imports ${specifier} (${relative(process.cwd(), target)}), which fails to load: ${exported.message}`;
    }
    const missing = names.filter(name => !exported.includes(name));

    return missing.length === 0
        ? undefined
        : `${file} imports ${missing.join(', ')} from ${specifier} (${relative(process.cwd(), target)}), which does not export it`;
}

/**
 * Why `specifier` in a declaration file does not resolve, as a consumer's type-check would
 * resolve it (`imports` under the `types` condition), to an existing declaration file.
 */
function privateTypeImportProblem(dist, { file, specifier })
{
    const { resolvedModule } = ts.resolveModuleName(
        specifier,
        join(dist, '..', file),
        { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
        ts.sys,
        undefined,
        undefined,
        ts.ModuleKind.ESNext,
    );

    return resolvedModule?.extension.startsWith('.d.') && existsSync(resolvedModule.resolvedFileName)
        ? undefined
        : `${file} imports ${specifier}, which \`imports\` in package.json does not resolve under the \`types\` condition `
            + `to an existing declaration file${resolvedModule === undefined ? '' : ` (${relative(process.cwd(), resolvedModule.resolvedFileName)})`}`;
}

/**
 * Checks the private imports of the package whose `dist` directory is `dist` and prints the
 * outcome; true when it passed. `resolveSpecifier` is the package script's own
 * `import.meta.resolve`, which reads that package's `imports`, not this repository's.
 */
export async function checkPrivateImports(dist, resolveSpecifier)
{
    const imports = privateImports(dist, /\.[cm]?js$/, ts.ScriptKind.JS);
    const typeImports = privateImports(dist, /\.d\.[cm]?ts$/, ts.ScriptKind.TS);
    const problems = [
        ...(await Promise.all(imports.map(imported => privateImportProblem(resolveSpecifier, imported)))),
        ...typeImports.map(imported => privateTypeImportProblem(dist, imported)),
    ].filter(problem => problem !== undefined);
    if (problems.length > 0)
    {
        console.error(`Private import check failed:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
        return false;
    }
    console.log(`Private import check passed: ${imports.length} \`#…\` imports in dist's code resolve to files that export `
        + `what they import, and ${typeImports.length} in its declarations to declaration files.`);

    return true;
}
