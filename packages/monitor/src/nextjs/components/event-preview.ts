/**
 * @spfn/monitor - the event preview of the error detail view
 *
 * An event's `stackTrace` is its error's description as indented JSON (#382).
 * Its first lines are only `{ kind name code severity`, so the preview is
 * built from the description's fields instead: the fault's name, code,
 * constraint and table, then its top frames. A row stored before #382 holds a
 * raw stack and keeps its first lines.
 */

const PREVIEW_FRAMES = 3;

const RAW_STACK_LINES = 5;

interface StoredDescription
{
    name?: unknown;
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
    stack?: unknown;
}

export function eventPreview(stackTrace: string): string
{
    const description = storedDescription(stackTrace);

    if (!description)
    {
        return stackTrace.split('\n').slice(0, RAW_STACK_LINES).join('\n');
    }

    const frames = typeof description.stack === 'string'
        ? description.stack.split('\n').slice(0, PREVIEW_FRAMES)
        : [];

    return [faultLine(description), ...frames].join('\n');
}

/** `Name [code=…] [constraint=…] [table=…]`, each tag only when present */
function faultLine(description: StoredDescription): string
{
    const tags = (['code', 'constraint', 'table'] as const)
        .filter(key => ['string', 'number'].includes(typeof description[key]) && description[key] !== '')
        .map(key => ` [${key}=${description[key]}]`)
        .join('');

    return `${typeof description.name === 'string' ? description.name : 'Error'}${tags}`;
}

function storedDescription(stackTrace: string): StoredDescription | null
{
    try
    {
        const parsed: unknown = JSON.parse(stackTrace);

        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    }
    catch
    {
        return null;
    }
}
