/**
 * Probes on the built entries, run by scripts/check-bundle-identity.mjs at the repository root
 * after the build.
 *
 * Identity: a refusal `authApi` restores is an instance of the class an app imports from
 * `@spfn/auth/errors`. Not a vitest row — vitest resolves `@spfn/auth` to source and
 * `@spfn/auth/errors` to dist, so it would compare the wrong things.
 *
 * Private imports: every `#…` specifier a `dist` file imports resolves through the package's
 * `imports` map to an existing file that exports the names imported. `nextjs/client` is a
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

/** Every `#…` import of a `dist` file: the file, the specifier and the names it imports. */
function privateImports()
{
    return readdirSync(DIST, { recursive: true })
        .filter(file => /\.[cm]?js$/.test(file))
        .flatMap(file => ts.createSourceFile(file, readFileSync(join(DIST, file), 'utf-8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
            .statements
            .filter(statement => (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
                && statement.moduleSpecifier !== undefined
                && statement.moduleSpecifier.text.startsWith('#'))
            .map(statement => ({ file: `dist/${file}`, specifier: statement.moduleSpecifier.text, names: importedNames(statement) })));
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

async function checkPrivateImports()
{
    const imports = privateImports();
    const problems = (await Promise.all(imports.map(privateImportProblem))).filter(problem => problem !== undefined);
    if (problems.length > 0)
    {
        console.error(`Private import check failed:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
        process.exit(1);
    }
    console.log(`Private import check passed: ${imports.length} \`#…\` imports in dist resolve to files that export what they import.`);
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
