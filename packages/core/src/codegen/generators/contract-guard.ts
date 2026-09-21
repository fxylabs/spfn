/**
 * Router registration guard
 *
 * A contract has to describe what production serves. When a route is registered
 * only under a feature flag or an environment check, the generated contract
 * describes whichever way the generator happened to run — and the gate then
 * compares a promise nobody made.
 *
 * Object spread is the one way a key can be conditionally present in the object
 * `defineRouter()` receives, so that is what this reads — in every
 * `defineRouter({...})` the file writes, since a nested router is assembled by
 * writing a second one. A spread of a plain identifier (`...baseRoutes`) is
 * unconditional and passes; anything computed inside the spread does not.
 *
 * What it reads is this one file's source. A conditional spread inside an
 * imported route module, a router returned by a factory, and a `.packages()`
 * list assembled conditionally are all past it.
 */

/** Thrown when the router registers contracted routes conditionally. */
export class ConditionalRegistrationError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'ConditionalRegistrationError';
    }
}

/** Text inside one object literal passed to `defineRouter()`, comments stripped. */
function defineRouterBlock(source: string, start: number): string | undefined
{
    const open = source.indexOf('{', start);

    if (open === -1)
    {
        return undefined;
    }

    let depth = 1;
    let cursor = open + 1;

    while (depth > 0 && cursor < source.length)
    {
        if (source[cursor] === '{') depth++;
        else if (source[cursor] === '}') depth--;
        cursor++;
    }

    return source.slice(open + 1, cursor - 1).replace(/\/\/[^\n]*/g, '');
}

/**
 * Every `defineRouter({...})` in the file, not only the first.
 *
 * A nested router is assembled by writing a second `defineRouter(` in the same
 * file — `const users = defineRouter({…})` and then `defineRouter({ users })` —
 * so reading only the first block would look straight past the app router in the
 * files where nesting is used.
 */
function defineRouterBlocks(source: string): string[]
{
    const blocks: string[] = [];

    for (let start = source.indexOf('defineRouter('); start !== -1; start = source.indexOf('defineRouter(', start + 1))
    {
        const block = defineRouterBlock(source, start);

        if (block !== undefined)
        {
            blocks.push(block);
        }
    }

    return blocks;
}

const PLAIN_REFERENCE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\s*$/;

/**
 * Refuse a router whose route set depends on a condition.
 *
 * @param routerPath - path named in the error message
 * @param source - contents of the router file
 */
export function assertUnconditionalRegistration(routerPath: string, source: string): void
{
    for (const block of defineRouterBlocks(source))
    {
        assertUnconditionalBlock(routerPath, block);
    }
}

function assertUnconditionalBlock(routerPath: string, block: string): void
{
    for (const [, expression] of block.matchAll(/\.\.\.\s*([^,\n]+)/g))
    {
        if (PLAIN_REFERENCE.test(expression))
        {
            continue;
        }

        throw new ConditionalRegistrationError(
            `${routerPath} registers routes conditionally: "...${expression.trim()}".\n\n`
            + 'A contract has to describe what production serves. When the route set depends on a flag or an '
            + 'environment, the generated contract describes whichever way the generator happened to run.\n'
            + 'Register contracted routes unconditionally, and gate behaviour inside the handler instead.',
        );
    }
}
