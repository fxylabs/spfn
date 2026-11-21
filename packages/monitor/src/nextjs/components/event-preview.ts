/**
 * @spfn/monitor - the event preview of the error detail view
 *
 * An event's `stackTrace` is its error's description as indented JSON (#382).
 * Its first lines are only `{ kind name code severity`, so the preview is
 * built from the description instead: the line naming the fault — the
 * group's line, `summarizeError` — then its top frames. Everything shown comes
 * from the stored description, which core's `describeError` already made safe.
 *
 * A row stored before #382 holds a raw stack, whose header is the error's
 * message — for a failed statement its SQL, and its next line `params: …` the
 * bound values. From that text only what names a place in code is shown: the
 * error's name and its `at …` frame lines.
 */

import { summarizeError, type Description } from '../../error-summary';

const PREVIEW_FRAMES = 3;

const FRAME_LINE = /^\s*at /;

const ERROR_NAME = /^[\w$.]+$/;

export function eventPreview(stackTrace: string): string
{
    const description = storedDescription(stackTrace);

    if (!description)
    {
        return legacyPreview(stackTrace);
    }

    return [summarizeError(description), ...topFrames(description.stack ?? '')].join('\n');
}

/** A raw stack's error name — the text before the first `:` of its header — and its frames */
function legacyPreview(stackTrace: string): string
{
    const name = stackTrace.split('\n', 1)[0].split(':', 1)[0].trim();

    return [ERROR_NAME.test(name) ? name : 'Error', ...topFrames(stackTrace)].join('\n');
}

function topFrames(text: string): string[]
{
    return text.split('\n').filter(line => FRAME_LINE.test(line)).slice(0, PREVIEW_FRAMES);
}

/** The stored description, or null for text that is not one: a row stored before #382 */
function storedDescription(stackTrace: string): Description | null
{
    try
    {
        const parsed: Partial<Description> | null = JSON.parse(stackTrace);

        return isDescription(parsed) ? parsed : null;
    }
    catch
    {
        return null;
    }
}

function isDescription(value: Partial<Description> | null): value is Description
{
    return typeof value === 'object'
        && value !== null
        && (value.kind === 'error' || value.kind === 'database')
        && typeof value.name === 'string';
}
