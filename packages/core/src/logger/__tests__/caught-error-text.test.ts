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
 * Where it may not go: the arguments of a logger call — `<receiver>.debug|info|
 * warn|error|fatal|log(…)` or `<receiver>[level](…)`, where the receiver is
 * named like a logger, is `log` or is `console` — or a persisted write —
 * pg-boss's `fail`, a repository's `create|insert|update|upsert`, drizzle's
 * `insert(…).values` / `update(…).set`.
 *
 * Not seen, by design (each would flag legitimate code to catch): text copied
 * into a local first (`const message = err.message`, then logged), an error
 * received under another name, a receiver named otherwise (`this.output.
 * error(…)` — matching every `.error(…)` call would flag result objects and
 * event emitters), and a raw error object handed to a sink that serialises it
 * (pg-boss `fail(…, error)` — boss-workers row R8 pins that one).
 *
 * R13b: in core, a caught value never reaches a logger as the lone second
 * argument. `logger.error(message, value)` reads an object that is not an
 * Error as the context and walks it — a thrown `{ code, params }` printed its
 * params — so a catch site passes `{ error }` or `(message, error, context)`,
 * which describe the value whatever its shape.
 *
 * | #    | goes unnoticed without the row                                       |
 * | ---- | -------------------------------------------------------------------- |
 * | R13  | a new log or persist site reintroducing the cause of #382            |
 * | R13b | a core catch site whose non-Error value is walked as the context     |
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
    // monitor — error_groups.message, error_events.stack_trace
    ['monitor/src/server/services/error-tracking.service.ts err.message', 1],
    ['monitor/src/server/services/error-tracking.service.ts err.stack', 1],
]);

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

    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current))
    {
        current = current.expression;
    }

    return current;
}

/**
 * The text a caught error's name is turned into here, if this node does that
 */
function errorText(node: ts.Node, names: ReadonlySet<string>): string | undefined
{
    const isCaught = (expression: ts.Expression): boolean =>
    {
        const inner = unwrap(expression);

        return ts.isIdentifier(inner) && names.has(inner.text);
    };

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

function offencesIn(file: string): Offence[]
{
    const source = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const offences: Offence[] = [];

    const visit = (node: ts.Node, names: ReadonlySet<string>): void =>
    {
        const bound = new Set([...names, ...caughtNames(node)]);
        const text = bound.size > 0 ? errorText(node, bound) : undefined;
        const sink = text === undefined ? undefined : enclosingSink(node);

        if (text !== undefined && sink !== undefined)
        {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            offences.push({ file: relative(packagesRoot, file), line, text, sink });
        }

        ts.forEachChild(node, child => visit(child, bound));
    };

    visit(source, new Set());

    return offences;
}

/**
 * Logger calls in the file whose only argument after the message is a caught value
 */
function loneCaughtArguments(file: string): Offence[]
{
    const source = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const offences: Offence[] = [];

    const visit = (node: ts.Node, names: ReadonlySet<string>): void =>
    {
        const bound = new Set([...names, ...caughtNames(node)]);

        if (ts.isCallExpression(node) && node.arguments.length === 2 && isLogCall(node.expression))
        {
            const argument = unwrap(node.arguments[1]);

            if (ts.isIdentifier(argument) && bound.has(argument.text))
            {
                const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                offences.push({ file: relative(packagesRoot, file), line, text: argument.text, sink: node.expression.getText() });
            }
        }

        ts.forEachChild(node, child => visit(child, bound));
    };

    visit(source, new Set());

    return offences;
}

describe('caught error text', () =>
{
    it('R13: no production source logs or persists a caught error\'s message, stack or string form (#382)', () =>
    {
        const offences = productionSources().flatMap(offencesIn);
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
            .flatMap(loneCaughtArguments)
            .map(offence => `${offence.file}:${offence.line} ${offence.sink}(…, ${offence.text})`);

        expect(offences, 'pass { error } or (message, error, context): either describes the value whatever its shape').toEqual([]);
    });
});
