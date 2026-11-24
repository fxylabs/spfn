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
 * `clone()` of that). An interceptor context is known by its declared shape,
 * whatever its name: a parameter or `const` typed `RequestInterceptorContext`
 * or `ResponseInterceptorContext` (or a union, intersection, `Pick`-like
 * wrapper, or the file's own type alias of one), and the first parameter of
 * an interceptor rule's `request` or `response` — a member of an object
 * literal that has a `pathPattern`. A parameter or `const` named `ctx` whose
 * type is `any`, `unknown`, or has no annotation at all is a context too —
 * nothing else gives the scan a shape to go by, so the name is what the old,
 * shape-blind scanner read instead. Its `request` is a raw Request. Element
 * access counts as member access (`c.req['path']`), and a computed key on a
 * request object (`c.req[name]`) as a read, since it could be any of them. A
 * `const`/`let` bound to a request object or to a path — by initialiser or by
 * destructuring (`const { path } = c.req`, `const { req } = c`,
 * `const { raw } = c.req`) — holds one too, in the block that declares it and
 * the blocks inside it.
 *
 * `logged`: the reads that are an argument of a logger call —
 * `<receiver>.debug|info|warn|error|fatal|log(…)` or `<receiver>[level](…)`
 * with a receiver named like a logger, `log` or `console` — at any depth up to
 * the function they sit in; and a path handed as an argument of its own —
 * the read, or a name holding it — to a function this file declares (by
 * name: a function declaration, or a `const` bound to an arrow or function
 * expression) whose parameter reaches a logger call there, followed through
 * such calls in turn. `reads`: every read, logged or not.
 *
 * Not seen: a context reached by any other shape under any other name — a
 * helper parameter typed `any` or left untyped that is not named `ctx` — and
 * a path handed inside another value (`{ path }`, a template), to a function
 * from another file, to a method, or to a parameter that is destructured.
 * Those reads are still `reads`, and an exact list of them is what catches a
 * new one.
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

/** The request object a name is when nothing in scope rebinds it: a Node `req` */
function namedKind(node)
{
    return isReference(node) && node.text === 'req' ? 'req' : undefined;
}

/** The type names of an interceptor context, as core's proxy declares them */
const CONTEXT_TYPES = new Set(['RequestInterceptorContext', 'ResponseInterceptorContext']);

/** Wrappers whose result keeps the members of the type they are given */
const KEEPING_WRAPPERS = new Set(['Pick', 'Omit', 'Partial', 'Required', 'Readonly']);

/** The type aliases a source file declares, by name */
const typeAliasCache = new WeakMap();

function typeAliasesOf(source)
{
    if (!typeAliasCache.has(source))
    {
        const aliases = new Map();
        const collect = (node) =>
        {
            if (ts.isTypeAliasDeclaration(node))
            {
                aliases.set(node.name.text, node.type);
            }

            ts.forEachChild(node, collect);
        };

        collect(source);
        typeAliasCache.set(source, aliases);
    }

    return typeAliasCache.get(source);
}

/** Whether a type annotation declares an interceptor context, directly or through the file's own alias */
function isContextType(type, seen = new Set())
{
    if (type === undefined)
    {
        return false;
    }

    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type))
    {
        return type.types.some(member => isContextType(member, seen));
    }

    if (ts.isParenthesizedTypeNode(type))
    {
        return isContextType(type.type, seen);
    }

    if (!ts.isTypeReferenceNode(type))
    {
        return false;
    }

    const name = ts.isQualifiedName(type.typeName) ? type.typeName.right.text : type.typeName.text;
    const aliased = typeAliasesOf(type.getSourceFile()).get(name);

    if (CONTEXT_TYPES.has(name) || (KEEPING_WRAPPERS.has(name) && isContextType(type.typeArguments?.[0], seen)))
    {
        return true;
    }

    return aliased !== undefined && !seen.has(name) && isContextType(aliased, new Set([...seen, name]));
}

/** Whether a function is an interceptor rule's `request` or `response`: a member of an object literal with a `pathPattern` */
function isRuleHandler(fn)
{
    const member = ts.isMethodDeclaration(fn) ? fn : fn.parent;
    const literal = member?.parent;
    const named = (property, names) => property.name !== undefined
        && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && names.includes(property.name.text);

    return (ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member)) && named(member, ['request', 'response'])
        && ts.isObjectLiteralExpression(literal) && literal.properties.some(property => named(property, ['pathPattern']));
}

/** Whether a type annotation gives the scan nothing to go by: absent, `any`, or `unknown` */
function isUntypedAnnotation(type)
{
    return type === undefined || type.kind === ts.SyntaxKind.AnyKeyword || type.kind === ts.SyntaxKind.UnknownKeyword;
}

/** Whether a name is `ctx` with no shape of its own to go by, the one case the scan still knows by name */
function isNamedCtx(name, type)
{
    return name === 'ctx' && isUntypedAnnotation(type);
}

/** Whether a parameter is an interceptor context: by its declared type, as a rule handler's first, or named `ctx` and untyped */
function isContextParameter(parameter)
{
    const fn = parameter.parent;

    return isContextType(parameter.type)
        || (parameter.type === undefined && fn.parameters[0] === parameter && isRuleHandler(fn))
        || (ts.isIdentifier(parameter.name) && isNamedCtx(parameter.name.text, parameter.type));
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

/** The request path an expression is — a path expression, or a name holding one — as text; not one it contains */
function pathItself(node, aliases)
{
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
    {
        return pathItself(node.expression, aliases);
    }

    const alias = ts.isIdentifier(node) && isReference(node) ? aliases.get(node.text) : undefined;

    return isPathExpression(node, aliases) ? node.getText() : (alias?.kind === 'path' ? alias.text : undefined);
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

    if (ts.isParameter(owner))
    {
        return isContextParameter(owner) ? 'ctx' : undefined;
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

    const kind = isContextType(declaration.type) ? 'ctx'
        : (declaration.initializer && requestKind(declaration.initializer, aliases)) ?? (isNamedCtx(name, declaration.type) ? 'ctx' : undefined);
    const path = declaration.initializer && pathIn(declaration.initializer, aliases);

    if (kind !== undefined)
    {
        return [[name, { kind, text: `${name} (${declaration.initializer?.getText() ?? kind})` }]];
    }

    return path === undefined ? [] : [[name, { kind: 'path', text: `${name} (${path})` }]];
}

/**
 * The names inside a function as its parameters leave them: a context
 * parameter is one, what a destructured parameter takes out of a context is
 * one, and any other parameter hides an outer name it shadows
 */
function parameterAliases(fn, outer)
{
    const aliases = new Map(outer);

    for (const parameter of fn.parameters)
    {
        if (ts.isIdentifier(parameter.name))
        {
            aliases.delete(parameter.name.text);

            if (isContextParameter(parameter))
            {
                aliases.set(parameter.name.text, { kind: 'ctx', text: parameter.name.text });
            }

            continue;
        }

        for (const [name, alias] of declaredAliases(parameter, aliases))
        {
            aliases.set(name, alias);
        }
    }

    return aliases;
}

/**
 * The names under a node that hold a request path or a request object: the
 * outer ones, a function's parameters, and those the `const`/`let`
 * declarations among its statements bind, each declaration seeing the ones
 * before it
 */
function aliasesUnder(node, outer)
{
    const aliases = ts.isFunctionLike(node) ? parameterAliases(node, outer) : new Map(outer);
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
 * The functions a file declares by name: function declarations, and `const`s
 * bound to an arrow function or a function expression. The first of a name wins.
 */
function namedFunctions(source)
{
    const functions = new Map();
    const collect = (node) =>
    {
        const named = ts.isFunctionDeclaration(node) && node.name ? [node.name.text, node]
            : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
                && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? [node.name.text, node.initializer]
                : undefined;

        if (named && !functions.has(named[0]))
        {
            functions.set(...named);
        }

        ts.forEachChild(node, collect);
    };

    collect(source);

    return functions;
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
    const functions = namedFunctions(source);
    const logged = [];
    const reads = [];
    const found = (node, what) =>
        ({ file: relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: what });

    /** Whether the parameter at `index` of a function this file names reaches a logger call there; memoised, cycles answer no */
    const reachesLog = new Map();
    const logsParameter = (fn, index) =>
    {
        const key = `${fn.pos} ${index}`;
        const parameter = fn.parameters[index];

        if (!reachesLog.has(key))
        {
            reachesLog.set(key, false);

            if (parameter && ts.isIdentifier(parameter.name) && fn.body)
            {
                const sink = { logged: () => reachesLog.set(key, true), read: () => undefined };
                walk(fn.body, new Map([[parameter.name.text, { kind: 'path', text: parameter.name.text }]]), sink);
            }
        }

        return reachesLog.get(key);
    };

    /** The paths a call hands, as an argument of their own, to a parameter its callee logs — each as `<path> → <callee>()` */
    const handedToLog = (node, aliases) =>
    {
        const fn = ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? functions.get(node.expression.text) : undefined;

        return fn === undefined ? [] : node.arguments.flatMap((argument, index) =>
        {
            const path = pathItself(argument, aliases);

            return path !== undefined && logsParameter(fn, index) ? [[argument, `${path} → ${node.expression.text}()`]] : [];
        });
    };

    const walk = (node, outer, sink) =>
    {
        const aliases = aliasesUnder(node, outer);
        const alias = ts.isIdentifier(node) && isReference(node) ? aliases.get(node.text) : undefined;
        const path = isPathExpression(node, aliases) ? node.getText() : (alias?.kind === 'path' ? alias.text : undefined);

        if (path !== undefined && insideLogCall(node))
        {
            sink.logged(node, path);
        }

        handedToLog(node, aliases).forEach(([argument, handed]) => sink.logged(argument, handed));

        if (isRequestRead(node, aliases))
        {
            sink.read(node, node.getText());
        }

        if (ts.isBindingElement(node) && bindingKind(node, aliases) === 'path')
        {
            sink.read(node, bindingText(node));
        }

        ts.forEachChild(node, child => walk(child, aliases, sink));
    };

    walk(source, new Map(), {
        logged: (node, what) => logged.push(found(node, what)),
        read: (node, what) => reads.push(found(node, what)),
    });

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
