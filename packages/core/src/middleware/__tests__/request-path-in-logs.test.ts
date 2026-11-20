/**
 * No core log line names the request path except through loggedPath (spfn/spfn#164)
 *
 * `logging.redactPaths` holds only while every line that names the request
 * path reads it through `loggedPath(c)`. About twenty sites used to read
 * `c.req.path` or the URL themselves, which is how proxy-guard came to log a
 * capability route's token. This row scans core's production sources so a new
 * site cannot bring that back.
 *
 * What the scan reads as the request path: `path`, `url` and `param` of a
 * request object, `url` of its raw Request, and any `.pathname`. A path
 * parameter is a segment of the path, so `c.req.param()` is a read like
 * `c.req.path`. A request object is `<x>.req` or a Node `req`; its raw Request
 * is `.raw` of one (or a `clone()` of that). Element access counts as member
 * access (`c.req['path']`), and a computed key on a request object
 * (`c.req[name]`) as a read, since it could be any of them. A `const`/`let`
 * bound to a request object or to a path — by initialiser or by
 * destructuring (`const { path } = c.req`, `const { req } = c`,
 * `const { raw } = c.req`) — holds one too, in the block that declares it and
 * the blocks inside it.
 *
 * T13: none of them is an argument of a logger call — `<receiver>.debug|info|
 * warn|error|fatal|log(…)` or `<receiver>[level](…)` with a receiver named like
 * a logger, `log` or `console` — at any depth up to the function it sits in,
 * except the exact list below.
 *
 * T13b: every other read of the request path, as above, is on an exact list
 * too. A path handed to a
 * function and logged there (`selectStore(…, c.req.path)`), or folded into a
 * string a logger receives later (the transaction context), is not something
 * T13 can follow; a new read has to be listed here, and whoever lists it reads
 * where it goes.
 *
 * | #    | goes unnoticed without the row                                         |
 * | ---- | ---------------------------------------------------------------------- |
 * | T13  | a new log line that names the request path itself, bypassing redaction |
 * | T13b | a path that reaches a log line through a call or a context string      |
 * | T13d | a read spelled through an alias, destructuring, element access or `param()` |
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const coreSource = fileURLToPath(new URL('../..', import.meta.url));

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'log']);

/**
 * Logged expressions that are not a request's path. `<file> <expression>` →
 * how many times the file logs it. The list is exact: a count that differs, or
 * a file that does not exist, fails the row.
 */
const LOGGED_NOT_A_REQUEST = new Map<string, number>([
    // SPFN_API_URL's base path, warned about once at proxy creation
    ['nextjs/proxy/rpc.ts basePath (new URL(apiUrl).pathname)', 1],
]);

/**
 * Reads of the request that are not logged. `<file> <expression>` → count;
 * exact, as above.
 */
const READS_NOT_LOGGED = new Map<string, number>([
    // the helpers themselves: loggedPath and isRedactedPath
    ['middleware/logged-path.ts c.req.path', 2],
    // the noise filter, matched against the path the router serves
    ['middleware/request-logger.ts c.req.path', 2],
    // the skip list, and the raw URL the proxy signed
    ['middleware/proxy-guard.ts c.req.path', 1],
    ['middleware/proxy-guard.ts c.req.url', 1],
    // the counter key's namespace when the route has no pattern
    ['middleware/rate-limit.ts c.req.path', 1],
    // query parsing
    ['route/validation.ts c.req.url', 1],
    // the WebSocket upgrade's token and event list
    ['event/ws/handler.ts req.url', 1],
    // the route's params, validated; a failure's 400 body quotes the value, and
    // the request logger leaves bodies out under a declared prefix
    ['route/register-routes.ts c.req.param', 1],
    // the tenant id; a refusal names the parameter, not its value
    ['db/tenant/tenancy.ts c.req.param', 1],
]);

interface Found
{
    file: string;
    line: number;
    text: string;
}

function walk(directory: string): string[]
{
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const full = join(directory, entry.name);

        if (entry.isDirectory())
        {
            return entry.name === '__tests__' ? [] : walk(full);
        }

        return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(entry.name) ? [full] : [];
    });
}

/** What a name in scope holds: a request path, or a request object (a Hono request, its raw Request) */
interface Alias
{
    kind: 'path' | RequestKind;
    text: string;
}

type RequestKind = 'req' | 'raw';

type Aliases = ReadonlyMap<string, Alias>;

/**
 * The members of a request object that read the path. A path parameter is a
 * segment of the path, so `param()` is a read; `*` stands for a computed key
 * (`c.req[name]`), which could be any of them.
 */
const READ_MEMBERS: Record<RequestKind, readonly string[]> = {
    req: ['path', 'url', 'param', '*'],
    raw: ['url', '*'],
};

/** A member access's name — `.name`, `['name']` — `*` for a computed one, undefined for anything else */
function memberName(node: ts.Node): string | undefined
{
    if (ts.isPropertyAccessExpression(node))
    {
        return node.name.text;
    }

    if (ts.isElementAccessExpression(node))
    {
        return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '*';
    }

    return undefined;
}

/**
 * Which request object an expression is: a Hono request (`<x>.req`,
 * `<x>['req']`, a Node `req`), its raw Request (`.raw` of one, or a clone of
 * that), a name bound to either, or neither
 */
function requestKind(node: ts.Node, aliases: Aliases): RequestKind | undefined
{
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
    {
        return requestKind(node.expression, aliases);
    }

    if (ts.isIdentifier(node))
    {
        const alias = isReference(node) ? aliases.get(node.text) : undefined;

        return alias === undefined ? (node.text === 'req' && isReference(node) ? 'req' : undefined) : (alias.kind === 'path' ? undefined : alias.kind);
    }

    if (ts.isCallExpression(node) && memberName(node.expression) === 'clone')
    {
        return requestKind((node.expression as ts.PropertyAccessExpression).expression, aliases) === 'raw' ? 'raw' : undefined;
    }

    const name = memberName(node);
    const receiver = name === undefined ? undefined : requestKind((node as ts.PropertyAccessExpression).expression, aliases);

    return name === 'req' ? 'req' : (name === 'raw' && receiver === 'req' ? 'raw' : undefined);
}

/**
 * A read of the request path: `path`, `url`, `param` or a computed key on a
 * request object, `url` or a computed key on its raw Request — however the
 * object was reached
 */
function isRequestRead(node: ts.Node, aliases: Aliases): boolean
{
    const name = memberName(node);
    const kind = name === undefined ? undefined : requestKind((node as ts.PropertyAccessExpression).expression, aliases);

    return kind !== undefined && READ_MEMBERS[kind].includes(name!);
}

function isPathExpression(node: ts.Node, aliases: Aliases): boolean
{
    return isRequestRead(node, aliases) || memberName(node) === 'pathname';
}

/** The first request path in the subtree — a path expression, or a name holding one — as text */
function pathIn(node: ts.Node, aliases: Aliases): string | undefined
{
    if (isPathExpression(node, aliases))
    {
        return node.getText();
    }

    const alias = ts.isIdentifier(node) && isReference(node) ? aliases.get(node.text) : undefined;

    return alias?.kind === 'path' ? alias.text : ts.forEachChild(node, child => pathIn(child, aliases));
}

/** The key a binding element reads: `{ path }`, `{ path: p }`, `{ ['path']: p }`; `*` for a computed one */
function bindingKey(element: ts.BindingElement): string
{
    const key = element.propertyName ?? element.name;

    if (ts.isComputedPropertyName(key))
    {
        return ts.isStringLiteralLike(key.expression) ? key.expression.text : '*';
    }

    return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '*';
}

/** The request object a destructuring pattern takes apart, if it is one */
function patternSource(pattern: ts.BindingPattern, aliases: Aliases): RequestKind | undefined
{
    const owner = pattern.parent;

    if (ts.isVariableDeclaration(owner))
    {
        return owner.initializer && requestKind(owner.initializer, aliases);
    }

    const kind = ts.isBindingElement(owner) ? bindingKind(owner, aliases) : undefined;

    return kind === 'path' ? undefined : kind;
}

/**
 * What a binding element takes out of a request object: the path
 * (`const { path } = c.req`), a request object (`const { req } = c`,
 * `const { raw } = c.req`, a rest element), or nothing
 */
function bindingKind(element: ts.BindingElement, aliases: Aliases): Alias['kind'] | undefined
{
    const source = patternSource(element.parent, aliases);
    const key = bindingKey(element);

    if (element.dotDotDotToken)
    {
        return source;
    }

    if (source !== undefined && READ_MEMBERS[source].includes(key))
    {
        return 'path';
    }

    return key === 'req' ? 'req' : (key === 'raw' && source === 'req' ? 'raw' : undefined);
}

/** A binding element as the scan lists it: `<what it destructures> { <key> }` */
function bindingText(element: ts.BindingElement): string
{
    const owner = element.parent.parent;
    const source = ts.isVariableDeclaration(owner) ? owner.initializer?.getText() ?? '' : ts.isBindingElement(owner) ? bindingText(owner) : '(parameter)';

    return `${source} { ${element.dotDotDotToken ? '...' : bindingKey(element)} }`;
}

/** The names a declaration binds that hold a request path or a request object */
function declaredAliases(declaration: ts.VariableDeclaration | ts.BindingElement, aliases: Aliases): [string, Alias][]
{
    if (!ts.isIdentifier(declaration.name))
    {
        const elements: readonly ts.ArrayBindingElement[] = declaration.name.elements;

        return elements
            .filter((element): element is ts.BindingElement => ts.isBindingElement(element))
            .flatMap(element => declaredAliases(element, aliases));
    }

    const name = declaration.name.text;

    if (ts.isBindingElement(declaration))
    {
        const kind = bindingKind(declaration, aliases);

        return kind === undefined ? [] : [[name, { kind, text: `${name} (${bindingText(declaration)})` }]];
    }

    const kind = declaration.initializer && requestKind(declaration.initializer, aliases);
    const path = declaration.initializer && pathIn(declaration.initializer, aliases);

    if (kind !== undefined)
    {
        return [[name, { kind, text: `${name} (${declaration.initializer!.getText()})` }]];
    }

    return path === undefined ? [] : [[name, { kind: 'path', text: `${name} (${path})` }]];
}

/**
 * The names under a node that hold a request path or a request object: the
 * outer ones, and those the `const`/`let` declarations among its statements
 * bind, each declaration seeing the ones before it
 */
function aliasesUnder(node: ts.Node, outer: Aliases): Map<string, Alias>
{
    const aliases = new Map(outer);
    const statements: readonly ts.Statement[] = (node as { statements?: ts.NodeArray<ts.Statement> }).statements ?? [];

    const declarations = statements
        .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement))
        .flatMap(statement => [...statement.declarationList.declarations]);

    for (const declaration of declarations)
    {
        for (const [name, alias] of declaredAliases(declaration, aliases))
        {
            aliases.set(name, alias);
        }
    }

    return aliases;
}

/**
 * Whether an identifier reads a variable: not a property name, an object
 * literal's key or a declaration's own name
 */
function isReference(node: ts.Identifier): boolean
{
    const parent = node.parent;

    if (ts.isShorthandPropertyAssignment(parent))
    {
        return true;
    }

    return !((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)
        || ts.isBindingElement(parent) || ts.isParameter(parent)) && parent.name === node);
}

/** A call on a logger — named like one, `log`, or `console` */
function isLogCall(callee: ts.Expression): boolean
{
    const isLogger = (receiver: string): boolean => /logger/i.test(receiver) || receiver === 'log' || receiver === 'console';

    if (ts.isElementAccessExpression(callee))
    {
        return isLogger(callee.expression.getText());
    }

    return ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text) && isLogger(callee.expression.getText());
}

/** Whether the node is an argument of a logger call, at any depth up to its function */
function insideLogCall(node: ts.Node): boolean
{
    for (let current = node; current.parent && !ts.isFunctionLike(current.parent); current = current.parent)
    {
        const parent = current.parent;

        if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression) && isLogCall(parent.expression))
        {
            return true;
        }
    }

    return false;
}

/** Request paths in logger arguments, and request reads anywhere */
function scan(file: string, text = readFileSync(file, 'utf-8')): { logged: Found[]; reads: Found[] }
{
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const logged: Found[] = [];
    const reads: Found[] = [];
    const found = (node: ts.Node, what: string): Found =>
        ({ file: relative(coreSource, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: what });

    const visit = (node: ts.Node, outer: Aliases): void =>
    {
        const aliases = aliasesUnder(node, outer);
        const alias = ts.isIdentifier(node) && isReference(node) ? aliases.get(node.text) : undefined;
        const path = isPathExpression(node, aliases) ? node.getText() : (alias?.kind === 'path' ? alias.text : undefined);

        if (path !== undefined && insideLogCall(node))
        {
            logged.push(found(node, path));
        }

        if (isRequestRead(node, aliases))
        {
            reads.push(found(node, node.getText()));
        }

        if (ts.isBindingElement(node) && bindingKind(node, aliases) === 'path')
        {
            reads.push(found(node, bindingText(node)));
        }

        ts.forEachChild(node, child => visit(child, aliases));
    };

    visit(source, new Map());

    return { logged, reads };
}

/** The found sites not on the list, and the list entries whose count differs */
function againstList(found: Found[], list: ReadonlyMap<string, number>): { unlisted: string[]; inexact: string[] }
{
    const counts = new Map<string, number>();

    for (const site of found)
    {
        const key = `${site.file} ${site.text}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return {
        unlisted: found.filter(site => !list.has(`${site.file} ${site.text}`)).map(site => `${site.file}:${site.line} ${site.text}`),
        inexact: [...list]
            .filter(([key, listed]) => counts.get(key) !== listed || !existsSync(join(coreSource, key.split(' ')[0])))
            .map(([key, listed]) => `${key}: listed ${listed}, found ${counts.get(key) ?? 0}`),
    };
}

describe('request path in core log lines', () =>
{
    const results = walk(coreSource).map(file => scan(file));

    it('T13: no core log call names the request path itself (#164)', () =>
    {
        const { unlisted, inexact } = againstList(results.flatMap(result => result.logged), LOGGED_NOT_A_REQUEST);

        expect(unlisted, 'name the path with loggedPath(c): it applies logging.redactPaths').toEqual([]);
        expect(inexact, 'the list names each logged non-request path exactly').toEqual([]);
    });

    it('T13b: every other read of the request path or URL in core is listed', () =>
    {
        const { unlisted, inexact } = againstList(results.flatMap(result => result.reads), READS_NOT_LOGGED);

        expect(unlisted, 'a read that reaches a log line goes through loggedPath(c); one that does not is listed here').toEqual([]);
        expect(inexact, 'the list names each read exactly: drop removed ones, count each expression').toEqual([]);
    });

    it('T13c: the scan follows a path through a const and a template, and into a shorthand property', () =>
    {
        const fixture = [
            'function handler(c: Context)',
            '{',
            '    const path = c.req.path;',
            '    const route = `${c.req.method} ${path}`;',
            "    logger.warn('alias', { path });",
            "    logger.debug('derived', { context: route });",
            "    guardLogger.info('direct', { url: new URL(c.req.url).pathname });",
            "    logger.info('helper', { path: loggedPath(c) });",
            '}',
        ].join('\n');
        const { logged, reads } = scan(join(coreSource, 'fixture.ts'), fixture);

        expect(logged.map(site => `${site.line} ${site.text}`)).toEqual([
            '5 path (c.req.path)',
            '6 route (path (c.req.path))',
            '7 new URL(c.req.url).pathname',
            '7 c.req.url',
        ]);
        expect(reads.map(site => `${site.line} ${site.text}`)).toEqual(['3 c.req.path', '7 c.req.url']);
    });

    it('T13d: the scan sees a read through an alias, destructuring, element access and param()', () =>
    {
        const fixture = [
            'function handler(c: Context)',
            '{',
            '    const { path } = c.req;',
            '    const request = c.req;',
            '    const { raw } = request;',
            '    const { req: { url: href } } = c;',
            "    logger.info('destructured', { path, href });",
            "    logger.info('element', { at: c.req['path'], raw: raw.url, key: c.req[name] });",
            "    logger.warn('param', { token: c.req.param('token'), all: request.param() });",
            "    logger.debug('clone', { url: c.req.raw.clone().url });",
            '    const { ...rest } = c.req;',
            "    logger.info('rest', { url: rest.url });",
            "    logger.info('not a read', { method: request.method, headers: raw.headers });",
            '}',
        ].join('\n');
        const { logged, reads } = scan(join(coreSource, 'fixture.ts'), fixture);

        expect(logged.map(site => `${site.line} ${site.text}`)).toEqual([
            '7 path (c.req { path })',
            '7 href (c { req } { url })',
            "8 c.req['path']",
            '8 raw.url',
            '8 c.req[name]',
            '9 c.req.param',
            '9 request.param',
            '10 c.req.raw.clone().url',
            '12 rest.url',
        ]);
        expect(reads.map(site => `${site.line} ${site.text}`)).toEqual([
            '3 c.req { path }',
            '6 c { req } { url }',
            "8 c.req['path']",
            '8 raw.url',
            '8 c.req[name]',
            '9 c.req.param',
            '9 request.param',
            '10 c.req.raw.clone().url',
            '12 rest.url',
        ]);
    });
});
