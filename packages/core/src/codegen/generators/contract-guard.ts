/**
 * Router registration guard
 *
 * A route registered only behind a feature flag or an environment check makes
 * generated output depend on how the generator happened to run. The contract
 * then describes a promise nobody made, and the route map leaves out a name
 * `registerRoutes` registers in production — so `api.admin.call()` typechecks
 * and 404s wherever the flag differs.
 *
 * What it reads is the router the generator was pointed at: the export the
 * loader found the router under, and the routers that export mounts by name
 * from the same file, since a nested router's routes land in the same flat map.
 * A `defineRouter(` the file writes but the app router never reaches — a second
 * router a test harness mounts, say — registers nothing in production and is
 * not scanned.
 *
 * Reading is done with TypeScript's parser rather than a regular expression
 * over the text. A spread is a syntax node there, so a JSDoc that spells
 * `defineRouter({ ... })` in prose, a brace inside a route path, and a comment
 * holding an old router are not router source. Only a spread whose expression
 * reads a condition is refused — a ternary, `&&`, `||`, `??`. A call is
 * allowed: `...metadataRoutes(config, resource)` is how `@spfn/mcp` composes
 * its router, and loading yields exactly the routes it returns.
 *
 * Past it, by construction: a conditional spread inside an imported route
 * module, a router built by a factory, a condition hoisted to a variable
 * (`const extra = flag ? { admin } : {}` spread afterwards), and a
 * `.packages()` list assembled conditionally. `NODE_ENV` is pinned before the
 * router loads, which is the real defence for those — the generator then reads
 * the router production gets, whatever the shell was.
 */

import type * as ts from 'typescript';
import { typescript } from './typescript';

/** Thrown when the router registers routes conditionally. */
export class ConditionalRegistrationError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'ConditionalRegistrationError';
    }
}

export interface RegistrationScan
{
    /** Path named in the error message. */
    routerPath: string;

    /** Contents of the router file. */
    source: string;

    /** The export the loader found the router under: `appRouter`, `default`, … */
    exportName: string;

    /** What is being generated, named in the message: `route map`, `contract`. */
    subject: string;
}

/**
 * Refuse a router whose route set depends on a condition.
 */
export function assertUnconditionalRegistration(scan: RegistrationScan): void
{
    const compiler = typescript();
    const file = compiler.createSourceFile(
        scan.routerPath,
        scan.source,
        compiler.ScriptTarget.Latest,
        /* setParentNodes */ false,
    );

    const declarations = topLevelInitialisers(compiler, file);
    const routes = routesLiteral(compiler, declarations.get(scan.exportName), declarations, new Set());

    // No literal means the router is not written as `defineRouter({...})` in
    // this file — a factory, or an import. Documented as past the guard.
    if (routes)
    {
        assertLiteral(compiler, file, routes, declarations, new Set(), scan);
    }
}

/**
 * What each name the loader could have found the router under is initialised
 * with: every top-level `const <name> = <expression>`, `export default
 * <expression>` under the name `default`, and a renaming export
 * (`export { r as default }`) under the name it exports.
 *
 * Top level only, because that is where a router is declared and where the
 * loader reads it from. A router built inside a function is past the guard for
 * the same reason a factory is.
 */
function topLevelInitialisers(compiler: typeof ts, file: ts.SourceFile): Map<string, ts.Expression>
{
    const found = new Map<string, ts.Expression>();

    for (const statement of file.statements)
    {
        if (compiler.isExportAssignment(statement) && !statement.isExportEquals)
        {
            found.set('default', statement.expression);
        }

        if (compiler.isVariableStatement(statement))
        {
            collectDeclarations(compiler, statement, found);
        }
    }

    // After the declarations, so a renamed export resolves through the name it
    // renames. `export { appRouter }` needs nothing: the declaration is the entry.
    for (const statement of file.statements)
    {
        collectRenamedExports(compiler, statement, found);
    }

    return found;
}

function collectDeclarations(
    compiler: typeof ts,
    statement: ts.VariableStatement,
    found: Map<string, ts.Expression>,
): void
{
    for (const declaration of statement.declarationList.declarations)
    {
        if (compiler.isIdentifier(declaration.name) && declaration.initializer)
        {
            found.set(declaration.name.text, declaration.initializer);
        }
    }
}

function collectRenamedExports(compiler: typeof ts, statement: ts.Statement, found: Map<string, ts.Expression>): void
{
    if (!compiler.isExportDeclaration(statement)
        || !statement.exportClause
        || !compiler.isNamedExports(statement.exportClause))
    {
        return;
    }

    for (const specifier of statement.exportClause.elements)
    {
        // The local name as an expression: `routesLiteral` follows it through
        // this same map. Only a rename is recorded — mapping `x` to `x` would
        // shadow the declaration it is supposed to lead to.
        if (specifier.propertyName && !found.has(specifier.name.text))
        {
            found.set(specifier.name.text, specifier.propertyName);
        }
    }
}

/** `as const`, `satisfies`, `!` and parentheses sit between a router and its call. */
function unwrap(compiler: typeof ts, expression: ts.Expression | undefined): ts.Expression | undefined
{
    if (!expression)
    {
        return undefined;
    }

    if (compiler.isParenthesizedExpression(expression)
        || compiler.isAsExpression(expression)
        || compiler.isSatisfiesExpression(expression)
        || compiler.isNonNullExpression(expression)
        || compiler.isTypeAssertionExpression(expression))
    {
        return unwrap(compiler, expression.expression);
    }

    return expression;
}

/**
 * The object literal `defineRouter()` receives, through however the router is
 * spelled: `defineRouter({…}).packages([…]).use([…])`, a name pointing at
 * another declaration (`export default appRouter`), or the call on its own.
 *
 * `seen` stops a file whose declarations refer to each other from recursing
 * forever, and stops a router mounted twice from being scanned twice.
 */
function routesLiteral(
    compiler: typeof ts,
    expression: ts.Expression | undefined,
    declarations: Map<string, ts.Expression>,
    seen: Set<string>,
): ts.ObjectLiteralExpression | undefined
{
    const node = unwrap(compiler, expression);

    if (!node)
    {
        return undefined;
    }

    if (compiler.isIdentifier(node))
    {
        if (seen.has(node.text))
        {
            return undefined;
        }

        seen.add(node.text);

        return routesLiteral(compiler, declarations.get(node.text), declarations, seen);
    }

    if (!compiler.isCallExpression(node))
    {
        return undefined;
    }

    const callee = unwrap(compiler, node.expression);

    if (callee && compiler.isIdentifier(callee) && callee.text === 'defineRouter')
    {
        const routes = unwrap(compiler, node.arguments[0]);

        return routes && compiler.isObjectLiteralExpression(routes) ? routes : undefined;
    }

    // A chained `.packages([...])` / `.use([...])` / `.contractVersion('1.0.0')`:
    // keep walking down to the defineRouter call the chain was built from. The
    // arguments are not followed — a package router registers its own routes,
    // which this generator neither emits nor completes.
    return callee && compiler.isPropertyAccessExpression(callee)
        ? routesLiteral(compiler, callee.expression, declarations, seen)
        : undefined;
}

/**
 * Check one router's routes, and the routers it mounts by name.
 *
 * A nested router registers under its own keys into the same flat map, so a
 * condition inside one leaves out a name exactly as a condition in the app
 * router does. Being mounted is what tells it apart from a router the file
 * declares and never registers.
 */
function assertLiteral(
    compiler: typeof ts,
    file: ts.SourceFile,
    literal: ts.ObjectLiteralExpression,
    declarations: Map<string, ts.Expression>,
    seen: Set<string>,
    scan: RegistrationScan,
): void
{
    for (const property of literal.properties)
    {
        if (compiler.isSpreadAssignment(property))
        {
            assertUnconditionalSpread(compiler, file, property.expression, scan);

            continue;
        }

        const nested = routesLiteral(compiler, mountedRouter(compiler, property), declarations, seen);

        if (nested)
        {
            assertLiteral(compiler, file, nested, declarations, seen, scan);
        }
    }
}

/** What a router entry holds: the value written, or the name a shorthand stands for. */
function mountedRouter(compiler: typeof ts, property: ts.ObjectLiteralElementLike): ts.Expression | undefined
{
    if (compiler.isPropertyAssignment(property))
    {
        return property.initializer;
    }

    return compiler.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function assertUnconditionalSpread(
    compiler: typeof ts,
    file: ts.SourceFile,
    expression: ts.Expression,
    scan: RegistrationScan,
): void
{
    const condition = conditionKind(compiler, expression);

    if (!condition)
    {
        return;
    }

    throw new ConditionalRegistrationError(
        `${scan.routerPath} registers routes conditionally: "...${spreadText(file, expression)}" (${condition}).\n\n`
        + `The ${scan.subject} is generated from the router as it loads, so a route set that depends on a flag or `
        + 'an environment describes whichever way the generator happened to run: a route production registers is '
        + 'left out, and the client that addresses it by name gets a 404.\n'
        + 'Register the route unconditionally and gate its behaviour inside the handler instead.',
    );
}

/** How the spread reads a condition, or `undefined` when it does not read one. */
function conditionKind(compiler: typeof ts, expression: ts.Expression): string | undefined
{
    const node = unwrap(compiler, expression);

    if (!node)
    {
        return undefined;
    }

    if (compiler.isConditionalExpression(node))
    {
        return 'a ternary';
    }

    if (!compiler.isBinaryExpression(node))
    {
        return undefined;
    }

    switch (node.operatorToken.kind)
    {
        case compiler.SyntaxKind.AmpersandAmpersandToken:
            return '&&';
        case compiler.SyntaxKind.BarBarToken:
            return '||';
        case compiler.SyntaxKind.QuestionQuestionToken:
            return '??';
        default:
            return undefined;
    }
}

/** The spread's source, on one line, so a multi-line ternary stays a readable message. */
function spreadText(file: ts.SourceFile, expression: ts.Expression): string
{
    return expression.getText(file).replace(/\s+/g, ' ');
}
