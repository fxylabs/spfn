/**
 * No caught error is pre-stringified into a log line or a persisted field (#382)
 *
 * The logger describes any error it is handed (`describeError`): a database
 * error's bound values never reach a transport. It cannot see where a string
 * came from, though — `{ error: err.message }` hands it drizzle's `params:`
 * line as plain text. This row scans the production sources of every package
 * for that shape, so a new site cannot bring the leak back.
 *
 * What the scan reads as a caught error: a `catch (x)` binding, the first
 * parameter of a `.catch()` callback and the second of `.then()`, and any
 * function parameter named like one (`e`, `err`, `error`, `reason`, `cause`,
 * `failure`) — hooks and event handlers receive their errors that way.
 * Its text is `x.message`, `x.stack`, `String(x)`, `${x}`, `x.toString()` or
 * `JSON.stringify(x)`.
 *
 * Aliases, followed in the block that declares them and the blocks inside
 * it: a `const`/`let` initialised from a caught value — directly, through
 * `as`, `!`, `satisfies` or parentheses, or as either branch of a ternary
 * (`x instanceof Error ? x : new Error(String(x))`) — is the caught value
 * too; one initialised from its text — a text form, a ternary branch, a
 * template or `+` / `??` / `||` operand, or the argument of `new` (an Error
 * made from the text) — is that text, wherever the name is read. An alias of
 * an alias is followed.
 *
 * Where it may not go: the arguments of a logger call — `<receiver>.debug|info|
 * warn|error|fatal|log(…)` or `<receiver>[level](…)`, where the receiver is
 * named like a logger, is `log` or is `console` — or a persisted write —
 * pg-boss's `fail`, a repository's `create|insert|update|upsert`, drizzle's
 * `insert(…).values` / `update(…).set`.
 *
 * Not followed (each needs reading the code, or would flag legitimate code):
 * destructuring (`const { message } = err`), a value or text passed to
 * another function and returned (`summarize(err)`, `hash(err.message)`),
 * one stored in an object or array and read back (`{ error }` then
 * `result.error`), a reassignment after the declaration (`x = err`), an error
 * received under another parameter name, a receiver named otherwise
 * (`this.output.error(…)` — matching every `.error(…)` call would flag result
 * objects and event emitters), and a raw error object handed to a sink that
 * serialises it (pg-boss `fail(…, error)` — boss-workers row R8 pins that one).
 *
 * R13b: in core, a caught value — or an alias of one — never reaches a logger
 * as the lone second argument. `logger.error(message, value)` reads an object
 * that is not an Error as the context and walks it — a thrown `{ code, params }`
 * printed its params — so a catch site passes `{ error }` or
 * `(message, error, context)`, which describe the value whatever its shape.
 *
 * R13c runs both scans on a fixture: the aliased offenders are found, and
 * destructuring and a call's result are not — the limits above, pinned.
 *
 * | #    | goes unnoticed without the row                                       |
 * | ---- | -------------------------------------------------------------------- |
 * | R13  | a new log or persist site reintroducing the cause of #382            |
 * | R13b | a core catch site whose non-Error value is walked as the context     |
 * | R13c | the scan losing a caught value copied into a local (H1)              |
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packagesRoot = fileURLToPath(new URL('../../../..', import.meta.url));

const ERROR_NAME = /^(e|err|error|reason|cause|failure)$/;
const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'log']);
const REPOSITORY_WRITES = new Set(['create', 'insert', 'update', 'upsert']);

/**
 * Not scanned: these print to the terminal of the operator who ran the
 * command — the operator's own data, not a retained log
 */
const OPERATOR_TERMINALS = ['cli/src/', 'pages-next/src/cli.ts'];

/**
 * Known sites outside core, fixed by #382's second PR, which empties this
 * list. `<file> <expression>` → how many times the file has that expression
 * in a sink. The list is exact: an entry whose count differs from the file's
 * — a site fixed, or one added — or whose file does not exist fails the row.
 */
const PENDING_OUTSIDE_CORE = new Map<string, number>([
    // auth — log lines
    ['auth/src/nextjs/oauth-handlers.ts error.message', 1],
    ['auth/src/nextjs/session-helpers.ts error.message', 2],
    ['auth/src/nextjs/session-helpers.ts String(error)', 2],
    ['auth/src/server/lib/config.ts (error as Error).message', 1],
    ['auth/src/server/lib/oauth/jwks-verify.ts err.message', 1],
    ['auth/src/server/lib/oauth/kakao-provider.ts err.message', 1],
    ['auth/src/server/lib/oauth/naver-provider.ts err.message', 1],
    ['auth/src/server/lib/session.ts err.message', 1],
    ['auth/src/server/services/account-deletion.service.ts error.message', 2],
    ['auth/src/server/services/account-deletion.service.ts String(error)', 2],
    ['auth/src/server/services/oauth.service.ts cause.message', 1],
    ['auth/src/server/services/oauth.service.ts String(cause)', 1],
    // cms — an Error made from a thrown non-Error's text, then logged
    ['cms/src/server/generators/label-sync-generator.ts err (String(error))', 4],
    // monitor — error_groups.message, error_events.stack_trace
    ['monitor/src/server/services/error-tracking.service.ts err.message', 1],
    ['monitor/src/server/services/error-tracking.service.ts err.stack', 1],
]);

const TEXT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
    ts.SyntaxKind.PlusToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.BarBarToken,
]);

const EMPTY_SCOPE: Scope = { values: new Set(), texts: new Map() };

interface Offence
{
    file: string;
    line: number;
    text: string;
    sink: string;
}

/**
 * Every production source under `packages/<name>/src`
 */
function productionSources(): string[]
{
    return readdirSync(packagesRoot)
        .map(name => join(packagesRoot, name, 'src'))
        .filter(src => statSync(src, { throwIfNoEntry: false })?.isDirectory())
        .flatMap(walk)
        .filter(file => !OPERATOR_TERMINALS.some(prefix => relative(packagesRoot, file).startsWith(prefix)));
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
 * The names a node binds to a caught error, for the subtree under it
 */
function caughtNames(node: ts.Node): string[]
{
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name))
    {
        return [node.variableDeclaration.name.text];
    }

    if (!ts.isFunctionLike(node))
    {
        return [];
    }

    const parameters = node.parameters.filter((parameter, index) =>
        ts.isIdentifier(parameter.name) && (ERROR_NAME.test(parameter.name.text) || isRejectionCallback(node, index)));

    return parameters.map(parameter => (parameter.name as ts.Identifier).text);
}

/**
 * Whether the function is a `.catch(fn)` callback and `index` its first
 * parameter, or a `.then(_, fn)` callback and `index` its first parameter
 */
function isRejectionCallback(fn: ts.SignatureDeclaration, index: number): boolean
{
    const call = fn.parent;

    if (index !== 0 || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression))
    {
        return false;
    }

    const position = call.arguments.indexOf(fn as unknown as ts.Expression);
    const method = call.expression.name.text;

    return (method === 'catch' && position === 0) || (method === 'then' && position === 1);
}

function unwrap(expression: ts.Expression): ts.Expression
{
    let current = expression;

    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
        || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current))
    {
        current = current.expression;
    }

    return current;
}

/**
 * What a subtree knows as caught: the names bound to a caught value, and the
 * names bound to a caught value's text (`const message = err.message`, or an
 * Error made from it, `new Error(String(err))`) → that text
 */
interface Scope
{
    values: ReadonlySet<string>;
    texts: ReadonlyMap<string, string>;
}

/**
 * The scope under a node: the caught names it binds (a catch clause, a
 * callback's parameter) and, if it holds statements (a block, a case, the
 * file), the `const`/`let` declarations among them that copy a caught value
 * or its text — in order, so an alias of an alias is one too
 */
function scopeUnder(node: ts.Node, outer: Scope): Scope
{
    const values = new Set([...outer.values, ...caughtNames(node)]);
    const texts = new Map(outer.texts);
    const statements: readonly ts.Statement[] = (node as { statements?: ts.NodeArray<ts.Statement> }).statements ?? [];

    const declarations = statements
        .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement))
        .flatMap(statement => [...statement.declarationList.declarations]);

    for (const declaration of declarations)
    {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
        {
            continue;
        }

        const scope = { values, texts };
        const text = carriedText(declaration.initializer, scope);

        if (isCaughtValue(declaration.initializer, scope))
        {
            values.add(declaration.name.text);
        }

        if (text !== undefined)
        {
            texts.set(declaration.name.text, `${declaration.name.text} (${text})`);
        }
    }

    return { values, texts };
}

/**
 * Whether the expression is the caught value: its name, through `as`, `!`,
 * `satisfies` or parentheses, or either branch of a ternary (`err instanceof
 * Error ? err : new Error(String(err))`)
 */
function isCaughtValue(expression: ts.Expression, scope: Scope): boolean
{
    const inner = unwrap(expression);

    if (ts.isConditionalExpression(inner))
    {
        return isCaughtValue(inner.whenTrue, scope) || isCaughtValue(inner.whenFalse, scope);
    }

    return ts.isIdentifier(inner) && scope.values.has(inner.text);
}

/**
 * The caught text the expression is, or is made of: a text form, a text
 * alias, a ternary branch, a template or `+` / `??` / `||` operand, or the
 * argument of `new` (an Error made from it). A call's result is not
 * followed: `hash(err.message)` is not the text.
 */
function carriedText(expression: ts.Expression, scope: Scope): string | undefined
{
    const inner = unwrap(expression);

    if (ts.isConditionalExpression(inner))
    {
        return carriedText(inner.whenTrue, scope) ?? carriedText(inner.whenFalse, scope);
    }

    if (ts.isBinaryExpression(inner) && TEXT_OPERATORS.has(inner.operatorToken.kind))
    {
        return carriedText(inner.left, scope) ?? carriedText(inner.right, scope);
    }

    const parts = ts.isTemplateExpression(inner) ? inner.templateSpans.map(span => span.expression)
        : ts.isNewExpression(inner) ? [...inner.arguments ?? []] : [];

    return errorText(inner, scope) ?? firstDefined(parts, part => carriedText(part, scope));
}

function firstDefined<T, R>(items: T[], map: (item: T) => R | undefined): R | undefined
{
    for (const item of items)
    {
        const result = map(item);

        if (result !== undefined)
        {
            return result;
        }
    }

    return undefined;
}

/**
 * The text a caught error's name is turned into here, if this node does that
 */
function errorText(node: ts.Node, scope: Scope): string | undefined
{
    const isCaught = (expression: ts.Expression): boolean =>
    {
        const inner = unwrap(expression);

        return ts.isIdentifier(inner) && scope.values.has(inner.text);
    };

    if (ts.isIdentifier(node) && scope.texts.has(node.text) && isReference(node))
    {
        return scope.texts.get(node.text);
    }

    if (ts.isPropertyAccessExpression(node) && ['message', 'stack'].includes(node.name.text) && isCaught(node.expression))
    {
        return node.getText();
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String'
        && node.arguments.length === 1 && isCaught(node.arguments[0]))
    {
        return node.getText();
    }

    if (ts.isTemplateSpan(node) && isCaught(node.expression))
    {
        return `\${${unwrap(node.expression).getText()}}`;
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 0
        && node.expression.name.text === 'toString' && isCaught(node.expression.expression))
    {
        return node.getText();
    }

    if (ts.isCallExpression(node) && node.expression.getText() === 'JSON.stringify'
        && node.arguments.length > 0 && isCaught(node.arguments[0]))
    {
        return node.getText();
    }

    return undefined;
}

/**
 * Whether an identifier reads a variable: not a property name, an object
 * literal's key or a declaration's own name
 */
function isReference(node: ts.Identifier): boolean
{
    const parent = node.parent;

    return !((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)
        || ts.isBindingElement(parent) || ts.isParameter(parent)) && parent.name === node);
}

/**
 * The logger call or persisted write the node is an argument of — at any
 * depth, up to the function it sits in
 */
function enclosingSink(node: ts.Node): string | undefined
{
    for (let current = node; current.parent && !ts.isFunctionLike(current.parent); current = current.parent)
    {
        const parent = current.parent;

        if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression) && isSink(parent.expression))
        {
            return parent.expression.getText();
        }
    }

    return undefined;
}

/**
 * A call on a logger — `<receiver>.<level>(…)` or `<receiver>[level](…)` —
 * whose receiver is named like one, or is `log`; `console` too when asked
 */
function isLogCall(callee: ts.Expression, withConsole = false): boolean
{
    const isLogger = (receiver: string): boolean =>
        /logger/i.test(receiver) || receiver === 'log' || (withConsole && receiver === 'console');

    if (ts.isElementAccessExpression(callee))
    {
        return isLogger(callee.expression.getText());
    }

    return ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text)
        && isLogger(callee.expression.getText());
}

function isSink(callee: ts.Expression): boolean
{
    if (isLogCall(callee, true))
    {
        return true;
    }

    if (!ts.isPropertyAccessExpression(callee))
    {
        return false;
    }

    const method = callee.name.text;
    const receiver = callee.expression.getText();

    if (REPOSITORY_WRITES.has(method))
    {
        return /Repository$/.test(receiver);
    }

    return method === 'fail'
        || (['values', 'set'].includes(method) && /\.(insert|update)\(/.test(receiver));
}

function offencesIn(file: string, text = readFileSync(file, 'utf-8')): Offence[]
{
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const offences: Offence[] = [];

    const visit = (node: ts.Node, outer: Scope): void =>
    {
        const scope = scopeUnder(node, outer);
        const text = scope.values.size + scope.texts.size > 0 ? errorText(node, scope) : undefined;
        const sink = text === undefined ? undefined : enclosingSink(node);

        if (text !== undefined && sink !== undefined)
        {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            offences.push({ file: relative(packagesRoot, file), line, text, sink });
        }

        ts.forEachChild(node, child => visit(child, scope));
    };

    visit(source, EMPTY_SCOPE);

    return offences;
}

/**
 * Logger calls in the file whose only argument after the message is a caught value
 */
function loneCaughtArguments(file: string, text = readFileSync(file, 'utf-8')): Offence[]
{
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const offences: Offence[] = [];

    const visit = (node: ts.Node, outer: Scope): void =>
    {
        const scope = scopeUnder(node, outer);

        if (ts.isCallExpression(node) && node.arguments.length === 2 && isLogCall(node.expression)
            && isCaughtValue(node.arguments[1], scope))
        {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            offences.push({ file: relative(packagesRoot, file), line, text: node.arguments[1].getText(), sink: node.expression.getText() });
        }

        ts.forEachChild(node, child => visit(child, scope));
    };

    visit(source, EMPTY_SCOPE);

    return offences;
}

describe('caught error text', () =>
{
    it('R13: no production source logs or persists a caught error\'s message, stack or string form (#382)', () =>
    {
        const offences = productionSources().flatMap(file => offencesIn(file));
        const counts = new Map<string, number>();

        for (const offence of offences)
        {
            const key = `${offence.file} ${offence.text}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        const unlisted = offences
            .filter(offence => !PENDING_OUTSIDE_CORE.has(`${offence.file} ${offence.text}`))
            .map(offence => `${offence.file}:${offence.line} ${offence.text} in ${offence.sink}(…)`);
        const inexact = [...PENDING_OUTSIDE_CORE]
            .filter(([key, listed]) => counts.get(key) !== listed || !existsSync(join(packagesRoot, key.split(' ')[0])))
            .map(([key, listed]) => `${key}: listed ${listed}, found ${counts.get(key) ?? 0}`);

        expect(unlisted, 'pass the error object itself: the logger describes it (describeError)').toEqual([]);
        expect(inexact, 'the allowlist names each pending site exactly: drop fixed ones, count each expression').toEqual([]);
    });

    it('R13b: no core catch site hands its caught value to a logger as the lone second argument', () =>
    {
        const offences = productionSources()
            .filter(file => relative(packagesRoot, file).startsWith('core/src/'))
            .flatMap(file => loneCaughtArguments(file))
            .map(offence => `${offence.file}:${offence.line} ${offence.sink}(…, ${offence.text})`);

        expect(offences, 'pass { error } or (message, error, context): either describes the value whatever its shape').toEqual([]);
    });

    it('R13c: the scan follows a caught value through a const or let, and its text too; not through destructuring or a call', () =>
    {
        const fixture = [
            'try { work(); }',
            'catch (error)',
            '{',
            '    const err = error as Error;',
            "    logger.error('cast', err);",
            '    const again = err!;',
            "    logger.error('alias of an alias', again);",
            '    const made = error instanceof Error ? error : new Error(String(error));',
            "    logger.error('made', made, {});",
            "    logger.error('made, alone', made);",
            '    let message = err.message;',
            "    logger.warn('text', { error: message });",
            '    const { message: destructured } = error as Error;',
            "    logger.warn('destructured', { error: destructured });",
            "    logger.warn('call', { error: summarize(error) }, {});",
            '}',
        ].join('\n');
        const found = (offences: Offence[]): string[] => offences.map(offence => `${offence.line} ${offence.text}`);

        expect(found(offencesIn(join(packagesRoot, 'core/src/fixture.ts'), fixture))).toEqual([
            '9 made (String(error))',
            '10 made (String(error))',
            '12 message (err.message)',
        ]);
        expect(found(loneCaughtArguments(join(packagesRoot, 'core/src/fixture.ts'), fixture))).toEqual(['5 err', '7 again', '10 made']);
    });
});
