/**
 * @spfn/monitor - the event preview of the error detail view
 *
 * An event's `stackTrace` is its error's description as indented JSON (#382).
 * Its first lines are only `{ kind name code severity`, so the preview is
 * built from the description's fields instead: the fault's name, code,
 * constraint and table, then its top frames.
 *
 * A row stored before #382 holds a raw stack, whose header is the error's
 * message — for a failed statement its SQL, and its next line `params: …` the
 * bound values. From that text only what names a place in code is shown: the
 * error's name and its `at …` frame lines.
 */

const PREVIEW_FRAMES = 3;

const FRAME_LINE = /^\s*at /;

const ERROR_NAME = /^[\w$.]+$/;

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
        return legacyPreview(stackTrace);
    }

    const frames = typeof description.stack === 'string'
        ? description.stack.split('\n').slice(0, PREVIEW_FRAMES)
        : [];

    return [faultLine(description), ...frames].join('\n');
}

/** A raw stack's error name — the text before the first `:` of its header — and its frames */
function legacyPreview(stackTrace: string): string
{
    const name = stackTrace.split('\n', 1)[0].split(':', 1)[0].trim();
    const frames = stackTrace.split('\n').filter(line => FRAME_LINE.test(line)).slice(0, PREVIEW_FRAMES);

    return [ERROR_NAME.test(name) ? name : 'Error', ...frames].join('\n');
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
