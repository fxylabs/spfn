/**
 * What `spfn env audit` reads out of one source file, through TypeScript's own
 * parser — a comment or a string that mentions `process.env.X` is not code, and
 * only a syntax tree can tell the two apart.
 *
 * TypeScript is loaded on first use from the app, then from the CLI's optional
 * peer, then from `@spfn/core`, which depends on it.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as TypeScript from 'typescript';
import { resolveFrom } from '../env-schema.js';

type Ts = typeof TypeScript;

/** A read of `process.env` outside the schema. */
export interface DirectRead
{
    line: number;

    /** The variable name, or the key expression in brackets when it is computed. */
    name: string;
    reason: string;
}

export interface SourceFacts
{
    directReads: DirectRead[];

    /** Every property name accessed or destructured, and every string literal. */
    names: Set<string>;
}

/** Read directly anywhere: bundlers and Node itself define it. */
const ALWAYS_ALLOWED = 'NODE_ENV';

/** Longest computed key shown in a finding. */
const MAX_KEY_TEXT = 40;

let compiler: Ts | undefined;

/**
 * The TypeScript compiler, or an error naming how to install it.
 */
export function loadTypeScript(cwd: string): Ts
{
    if (compiler)
    {
        return compiler;
    }

    const path = resolveFrom(join(cwd, 'noop.js'), 'typescript')
        ?? resolveFrom(import.meta.url, 'typescript')
        ?? resolveThroughCore();

    if (!path)
    {
        throw new Error('spfn env audit parses sources with TypeScript, which is not installed. Add it: pnpm add -D typescript');
    }

    compiler = createRequire(import.meta.url)(path) as Ts;

    return compiler;
}

function resolveThroughCore(): string | undefined
{
    const core = resolveFrom(import.meta.url, '@spfn/core/app-config');

    return core ? resolveFrom(core, 'typescript') : undefined;
}

/**
 * Parse one file and collect its direct reads and the names it mentions.
 */
export function readSourceFacts(ts: Ts, fileName: string, text: string): SourceFacts
{
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, fileName));
    const facts: SourceFacts = { directReads: [], names: new Set() };

    const visit = (node: TypeScript.Node): void =>
    {
        collectName(ts, node, facts.names);
        collectDirectRead(ts, source, node, facts.directReads);
        ts.forEachChild(node, visit);
    };

    visit(source);
    facts.directReads = facts.directReads.filter((read) => read.name !== ALWAYS_ALLOWED);

    return facts;
}

/**
 * The line each property name is first written on — where a finding about a
 * schema entry points.
 */
export function readPropertyLines(ts: Ts, fileName: string, text: string): Map<string, number>
{
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, fileName));
    const lines = new Map<string, number>();

    const visit = (node: TypeScript.Node): void =>
    {
        const name = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) ? propertyNameText(ts, node.name) : undefined;

        if (name && !lines.has(name))
        {
            lines.set(name, lineOf(source, node));
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    return lines;
}

function scriptKindOf(ts: Ts, fileName: string): TypeScript.ScriptKind
{
    if (fileName.endsWith('.tsx'))
    {
        return ts.ScriptKind.TSX;
    }

    // The JSX kind parses plain .js, .mjs and .cjs as well.
    return /\.[cm]?tsx?$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
}

/**
 * A name counts as read when it is accessed as a property, destructured out
 * of an object, or written as a string literal.
 */
function collectName(ts: Ts, node: TypeScript.Node, names: Set<string>): void
{
    if (ts.isPropertyAccessExpression(node))
    {
        names.add(node.name.text);
    }
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    {
        names.add(node.text);
    }
    else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent))
    {
        const name = propertyNameText(ts, node.propertyName ?? node.name);

        if (name)
        {
            names.add(name);
        }
    }
}

function collectDirectRead(ts: Ts, source: TypeScript.SourceFile, node: TypeScript.Node, reads: DirectRead[]): void
{
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(ts, node.expression))
    {
        reads.push({ line: lineOf(source, node), name: node.name.text, reason: 'read from process.env' });
    }
    else if (ts.isElementAccessExpression(node) && isProcessEnv(ts, node.expression))
    {
        reads.push({ line: lineOf(source, node), ...describeElementKey(ts, source, node.argumentExpression) });
    }
    else if (ts.isVariableDeclaration(node) && node.initializer && isProcessEnv(ts, node.initializer) && ts.isObjectBindingPattern(node.name))
    {
        reads.push(...node.name.elements.map((element) => destructuredRead(ts, source, element)));
    }
}

function describeElementKey(ts: Ts, source: TypeScript.SourceFile, key: TypeScript.Expression): Omit<DirectRead, 'line'>
{
    if (ts.isStringLiteralLike(key))
    {
        return { name: key.text, reason: 'read from process.env' };
    }

    const text = key.getText(source).replace(/\s+/g, ' ');

    return {
        name: `[${text.length > MAX_KEY_TEXT ? `${text.slice(0, MAX_KEY_TEXT)}…` : text}]`,
        reason: 'read from process.env under a computed key',
    };
}

function destructuredRead(ts: Ts, source: TypeScript.SourceFile, element: TypeScript.BindingElement): DirectRead
{
    const name = element.dotDotDotToken
        ? `...${element.name.getText(source)}`
        : propertyNameText(ts, element.propertyName ?? element.name) ?? `[${(element.propertyName ?? element.name).getText(source)}]`;

    return { line: lineOf(source, element), name, reason: 'destructured from process.env' };
}

/**
 * `process.env`, reached plainly, through optional chaining
 * (`process?.env`) or through the global object (`globalThis.process.env`).
 */
function isProcessEnv(ts: Ts, node: TypeScript.Node): boolean
{
    const expression = skipWrappers(ts, node);

    return ts.isPropertyAccessExpression(expression)
        && expression.name.text === 'env'
        && isProcess(ts, skipWrappers(ts, expression.expression));
}

function isProcess(ts: Ts, node: TypeScript.Node): boolean
{
    if (ts.isIdentifier(node))
    {
        return node.text === 'process';
    }

    return ts.isPropertyAccessExpression(node)
        && node.name.text === 'process'
        && ts.isIdentifier(node.expression)
        && ['globalThis', 'global', 'window', 'self'].includes(node.expression.text);
}

/** Parentheses, `as` casts and `!` do not change what is read. */
function skipWrappers(ts: Ts, node: TypeScript.Node): TypeScript.Node
{
    let current = node;

    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current))
    {
        current = current.expression;
    }

    return current;
}

function propertyNameText(ts: Ts, name: TypeScript.Node): string | undefined
{
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name))
    {
        return name.text;
    }

    return undefined;
}

function lineOf(source: TypeScript.SourceFile, node: TypeScript.Node): number
{
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
