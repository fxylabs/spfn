/**
 * The scan behind "no log line names the request path except through
 * loggedPath" (spfn/spfn#164, #489). One scanner, run by each package's own
 * test suite over its own production sources — core's
 * `src/middleware/__tests__/request-path-in-logs.test.ts` and auth's
 * `src/__tests__/unit/request-path-in-logs.test.ts` — each with its own exact
 * lists. It is repository tooling, not a published export.
 *
 * What the scan reads as the request path: `path`, `url` and `param` of a
 * request object, `url` of its raw Request, `path` of a Next.js proxy
 * interceptor's context, and any `.pathname`. A path parameter is a segment of
 * the path, so `c.req.param()` is a read like `c.req.path`. A request object
 * is `<x>.req` or a Node `req`; its raw Request is `.raw` of one (or a
 * `clone()` of that); an interceptor context is `ctx`, as the proxy's
 * interceptors name it, and its `request` is a raw Request. Element access
 * counts as member access (`c.req['path']`), and a computed key on a request
 * object (`c.req[name]`) as a read, since it could be any of them. A
 * `const`/`let` bound to a request object or to a path — by initialiser or by
 * destructuring (`const { path } = c.req`, `const { req } = c`,
 * `const { raw } = c.req`) — holds one too, in the block that declares it and
 * the blocks inside it.
 *
 * `logged`: the reads that are an argument of a logger call —
 * `<receiver>.debug|info|warn|error|fatal|log(…)` or `<receiver>[level](…)`
 * with a receiver named like a logger, `log` or `console` — at any depth up to
 * the function they sit in. `reads`: every read, logged or not.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'log']);

/**
 * The members of a request object that read the path. A path parameter is a
 * segment of the path, so `param()` is a read; `*` stands for a computed key
 * (`c.req[name]`), which could be any of them.
 */
const READ_MEMBERS = {
    req: ['path', 'url', 'param', '*'],
    raw: ['url', '*'],
    ctx: ['path', '*'],
};

/**
 * Every production source under a package's `src`: `.ts`/`.tsx`, without
 * `__tests__`, tests, specs and declarations.
 *
 * @param {string} directory
 * @returns {string[]}
 */
export function productionSources(directory)
{
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const full = join(directory, entry.name);

        if (entry.isDirectory())
        {
            return entry.name === '__tests__' ? [] : productionSources(full);
        }

        return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(entry.name) ? [full] : [];
    });
}

/** A member access's name — `.name`, `['name']` — `*` for a computed one, undefined for anything else */
function memberName(node)
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

/** The request object a name is when nothing in scope rebinds it: a Node `req`, an interceptor's `ctx` */
function namedKind(node)
{
    if (!isReference(node))
    {
        return undefined;
    }

    return node.text === 'req' ? 'req' : (node.text === 'ctx' ? 'ctx' : undefined);
}

/** The request object a member access reaches: `.req`, `.raw` of a request, `.request` of a context */
function memberKind(name, receiver)
{
    if (name === 'req')
    {
        return 'req';
    }

    return (name === 'raw' && receiver === 'req') || (name === 'request' && receiver === 'ctx') ? 'raw' : undefined;
}

/**
 * Which request object an expression is: a Hono request (`<x>.req`,
 * `<x>['req']`, a Node `req`), its raw Request (`.raw` of one, or a clone of
 * that), an interceptor context and its request, a name bound to any of them,
 * or none
 */
function requestKind(node, aliases)
{
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
    {
        return requestKind(node.expression, aliases);
    }

    if (ts.isIdentifier(node))
    {
        const alias = isReference(node) ? aliases.get(node.text) : undefined;

        return alias === undefined ? namedKind(node) : (alias.kind === 'path' ? undefined : alias.kind);
    }

    if (ts.isCallExpression(node) && memberName(node.expression) === 'clone')
    {
        return requestKind(node.expression.expression, aliases) === 'raw' ? 'raw' : undefined;
    }

    const name = memberName(node);

    return name === undefined ? undefined : memberKind(name, requestKind(node.expression, aliases));
}

/**
 * A read of the request path: a member `READ_MEMBERS` names on a request
 * object, however the object was reached
 */
function isRequestRead(node, aliases)
{
    const name = memberName(node);
    const kind = name === undefined ? undefined : requestKind(node.expression, aliases);

    return kind !== undefined && READ_MEMBERS[kind].includes(name);
}

function isPathExpression(node, aliases)
{
    return isRequestRead(node, aliases) || memberName(node) === 'pathname';
}

/** The first request path in the subtree — a path expression, or a name holding one — as text */
function pathIn(node, aliases)
{
    if (isPathExpression(node, aliases))
    {
        return node.getText();
    }

    const alias = ts.isIdentifier(node) && isReference(node) ? aliases.get(node.text) : undefined;

    return alias?.kind === 'path' ? alias.text : ts.forEachChild(node, child => pathIn(child, aliases));
}

/** The key a binding element reads: `{ path }`, `{ path: p }`, `{ ['path']: p }`; `*` for a computed one */
function bindingKey(element)
{
    const key = element.propertyName ?? element.name;

    if (ts.isComputedPropertyName(key))
    {
        return ts.isStringLiteralLike(key.expression) ? key.expression.text : '*';
    }

    return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '*';
}

/** The request object a destructuring pattern takes apart, if it is one */
function patternSource(pattern, aliases)
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
function bindingKind(element, aliases)
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

    return memberKind(key, source);
}

/** A binding element as the scan lists it: `<what it destructures> { <key> }` */
function bindingText(element)
{
    const owner = element.parent.parent;
    const source = ts.isVariableDeclaration(owner) ? owner.initializer?.getText() ?? '' : ts.isBindingElement(owner) ? bindingText(owner) : '(parameter)';

    return `${source} { ${element.dotDotDotToken ? '...' : bindingKey(element)} }`;
}

/** The names a declaration binds that hold a request path or a request object */
function declaredAliases(declaration, aliases)
{
    if (!ts.isIdentifier(declaration.name))
    {
        return declaration.name.elements
            .filter(element => ts.isBindingElement(element))
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
        return [[name, { kind, text: `${name} (${declaration.initializer.getText()})` }]];
    }

    return path === undefined ? [] : [[name, { kind: 'path', text: `${name} (${path})` }]];
}

/**
 * The names under a node that hold a request path or a request object: the
 * outer ones, and those the `const`/`let` declarations among its statements
 * bind, each declaration seeing the ones before it
 */
function aliasesUnder(node, outer)
{
    const aliases = new Map(outer);
    const declarations = (node.statements ?? [])
        .filter(statement => ts.isVariableStatement(statement))
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
function isReference(node)
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
function isLogCall(callee)
{
    const isLogger = receiver => /logger/i.test(receiver) || receiver === 'log' || receiver === 'console';

    if (ts.isElementAccessExpression(callee))
    {
        return isLogger(callee.expression.getText());
    }

    return ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text) && isLogger(callee.expression.getText());
}

/** Whether the node is an argument of a logger call, at any depth up to its function */
function insideLogCall(node)
{
    for (let current = node; current.parent && !ts.isFunctionLike(current.parent); current = current.parent)
    {
        const parent = current.parent;

        if (ts.isCallExpression(parent) && parent.arguments.includes(current) && isLogCall(parent.expression))
        {
            return true;
        }
    }

    return false;
}

/**
 * Request paths in logger arguments, and request reads anywhere, of one file.
 * `file` is reported relative to `root`.
 *
 * @param {string} root
 * @param {string} file
 * @param {string} [text]
 */
export function scanFile(root, file, text = readFileSync(file, 'utf-8'))
{
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const logged = [];
    const reads = [];
    const found = (node, what) =>
        ({ file: relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: what });

    const visit = (node, outer) =>
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

/**
 * The found sites not on an exact list, and the list entries whose count
 * differs or whose file does not exist under `root`. A list maps
 * `<file> <expression>` to how many times the file has it.
 *
 * @param {string} root
 * @param {{ file: string, line: number, text: string }[]} found
 * @param {ReadonlyMap<string, number>} list
 */
export function againstList(root, found, list)
{
    const counts = new Map();

    for (const site of found)
    {
        const key = `${site.file} ${site.text}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return {
        unlisted: found.filter(site => !list.has(`${site.file} ${site.text}`)).map(site => `${site.file}:${site.line} ${site.text}`),
        inexact: [...list]
            .filter(([key, listed]) => counts.get(key) !== listed || !existsSync(join(root, key.split(' ')[0])))
            .map(([key, listed]) => `${key}: listed ${listed}, found ${counts.get(key) ?? 0}`),
    };
}
