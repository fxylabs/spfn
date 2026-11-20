/**
 * No core log line names the request path except through loggedPath (spfn/spfn#164)
 *
 * `logging.redactPaths` holds only while every line that names the request
 * path reads it through `loggedPath(c)`. About twenty sites used to read
 * `c.req.path` or the URL themselves, which is how proxy-guard came to log a
 * capability route's token. This row scans core's production sources so a new
 * site cannot bring that back.
 *
 * What the scan reads as the request path: `<x>.req.path`, `<x>.req.url`,
 * `<x>.req.raw.url` and `req.url` (a Node request), and any `.pathname`. A
 * `const`/`let` initialised from an expression holding one is the path too,
 * in the block that declares it and the blocks inside it.
 *
 * T13: none of them is an argument of a logger call — `<receiver>.debug|info|
 * warn|error|fatal|log(…)` or `<receiver>[level](…)` with a receiver named like
 * a logger, `log` or `console` — at any depth up to the function it sits in,
 * except the exact list below.
 *
 * T13b: every other read of the request itself (`.req.path`, `.req.url`,
 * `.req.raw.url`, `req.url`) is on an exact list too. A path handed to a
 * function and logged there (`selectStore(…, c.req.path)`), or folded into a
 * string a logger receives later (the transaction context), is not something
 * T13 can follow; a new read has to be listed here, and whoever lists it reads
 * where it goes.
 *
 * | #    | goes unnoticed without the row                                         |
 * | ---- | ---------------------------------------------------------------------- |
 * | T13  | a new log line that names the request path itself, bypassing redaction |
 * | T13b | a path that reaches a log line through a call or a context string      |
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
    // the helper itself
    ['middleware/logged-path.ts c.req.path', 1],
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

/**
 * A read of the request itself: `<x>.req.path`, `<x>.req.url`,
 * `<x>.req.raw.url`, `req.url`
 */
function isRequestRead(node: ts.Node): node is ts.PropertyAccessExpression
{
    if (!ts.isPropertyAccessExpression(node) || !['path', 'url'].includes(node.name.text))
    {
        return false;
    }

    const receiver = node.expression.getText();

    return /(^|\.)req$/.test(receiver) || (node.name.text === 'url' && /(^|\.)req\.raw$/.test(receiver));
}

function isPathExpression(node: ts.Node): boolean
{
    return isRequestRead(node) || (ts.isPropertyAccessExpression(node) && node.name.text === 'pathname');
}

/** The first path expression in the subtree, if any */
function pathIn(node: ts.Node): ts.Node | undefined
{
    return isPathExpression(node) ? node : ts.forEachChild(node, pathIn);
}

/**
 * The names under a node that hold a request path: the outer ones, and the
 * `const`/`let` declarations among its statements initialised from an
 * expression that holds one (or holds such a name) → that expression
 */
function aliasesUnder(node: ts.Node, outer: ReadonlyMap<string, string>): Map<string, string>
{
    const aliases = new Map(outer);
    const statements: readonly ts.Statement[] = (node as { statements?: ts.NodeArray<ts.Statement> }).statements ?? [];

    const declarations = statements
        .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement))
        .flatMap(statement => [...statement.declarationList.declarations]);

    for (const declaration of declarations)
    {
        const source = declaration.initializer && (pathIn(declaration.initializer) ?? aliasIn(declaration.initializer, aliases));

        if (ts.isIdentifier(declaration.name) && source)
        {
            aliases.set(declaration.name.text, `${declaration.name.text} (${typeof source === 'string' ? source : source.getText()})`);
        }
    }

    return aliases;
}

/** What an alias read in the subtree stands for, if any */
function aliasIn(node: ts.Node, aliases: ReadonlyMap<string, string>): string | undefined
{
    if (ts.isIdentifier(node) && aliases.has(node.text) && isReference(node))
    {
        return aliases.get(node.text);
    }

    return ts.forEachChild(node, child => aliasIn(child, aliases));
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

    const visit = (node: ts.Node, outer: ReadonlyMap<string, string>): void =>
    {
        const aliases = aliasesUnder(node, outer);
        const alias = ts.isIdentifier(node) && aliases.has(node.text) && isReference(node) ? aliases.get(node.text) : undefined;
        const path = isPathExpression(node) ? node.getText() : alias;

        if (path !== undefined && insideLogCall(node))
        {
            logged.push(found(node, path));
        }

        if (isRequestRead(node))
        {
            reads.push(found(node, node.getText()));
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
});
