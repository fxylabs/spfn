/**
 * Probes on the built entries, run by scripts/check-bundle-identity.mjs at the repository root
 * after the build.
 *
 * Identity: a refusal `authApi` restores is an instance of the class an app imports from
 * `@spfn/auth/errors`. Not a vitest row — vitest resolves `@spfn/auth` to source and
 * `@spfn/auth/errors` to dist, so it would compare the wrong things.
 *
 * Private imports: every `#…` specifier a `dist` file imports — statically or through an
 * `import('…')` with a literal specifier — resolves through the package's `imports` map to an
 * existing file that exports the names imported; every one in a `dist` declaration file
 * resolves, under the `types` condition, to an existing declaration file. `nextjs/client` is a
 * build of its own that reaches the main build only through `#nextjs/client-shared`; without
 * this, dropping that main-build entry leaves the build, `tsc` and the unit tests green, and
 * only an app's `next build` fails.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

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

/** Every `#…` import anywhere in the `dist` files matching `pattern`: the file, the specifier and the names. */
function privateImports(pattern, scriptKind)
{
    return readdirSync(DIST, { recursive: true })
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
            visit(ts.createSourceFile(file, readFileSync(join(DIST, file), 'utf-8'), ts.ScriptTarget.Latest, true, scriptKind));

            return found;
        });
}

/** Why `specifier` does not give `file` the names it imports, or undefined when it does. */
async function privateImportProblem({ file, specifier, names })
{
    const target = (() =>
    {
        try
        {
            return fileURLToPath(import.meta.resolve(specifier));
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
function privateTypeImportProblem({ file, specifier })
{
    const { resolvedModule } = ts.resolveModuleName(
        specifier,
        join(DIST, '..', file),
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

async function checkPrivateImports()
{
    const imports = privateImports(/\.[cm]?js$/, ts.ScriptKind.JS);
    const typeImports = privateImports(/\.d\.[cm]?ts$/, ts.ScriptKind.TS);
    const problems = [
        ...(await Promise.all(imports.map(privateImportProblem))),
        ...typeImports.map(privateTypeImportProblem),
    ].filter(problem => problem !== undefined);
    if (problems.length > 0)
    {
        console.error(`Private import check failed:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
        process.exit(1);
    }
    console.log(`Private import check passed: ${imports.length} \`#…\` imports in dist's code resolve to files that export `
        + `what they import, and ${typeImports.length} in its declarations to declaration files.`);
}

async function checkErrorIdentity()
{
    // `authApi` takes `fetch` when the module is evaluated, so the stand-in goes first.
    globalThis.fetch = async () => Response.json(
        { __type: 'RecentAuthenticationRequiredError', message: 'bundle identity probe' },
        { status: 403 },
    );
    process.env.SPFN_APP_URL ??= 'http://bundle-identity-probe.invalid';
    // Outside Next.js the client warns that it has no inbound request; expected here.
    process.env.SPFN_LOG_LEVEL ??= 'error';

    const { authApi } = await import('@spfn/auth');
    const { RecentAuthenticationRequiredError } = await import('@spfn/auth/errors');

    const thrown = await authApi.getAuthSession.call({}).then(() => null, error => error);

    if (!(thrown instanceof RecentAuthenticationRequiredError))
    {
        console.error('Identity probe failed:\n  - authApi restores RecentAuthenticationRequiredError as a class '
            + `other than the one @spfn/auth/errors exports (got ${thrown?.constructor?.name ?? thrown})`);
        process.exit(1);
    }
    console.log('Identity probe passed: authApi refusals are the classes @spfn/auth/errors exports.');
}

// First: `authApi` must not have been loaded, by a private import's target, before the stand-in.
await checkErrorIdentity();
await checkPrivateImports();
