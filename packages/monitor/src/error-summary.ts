/**
 * @spfn/monitor - one line naming a fault, from its error's description (#382)
 *
 * A leaf both sides read: the error-tracking service stores the line as the
 * group's `message`, and the dashboard's event preview builds it from the
 * stored description. The description is already safe — core's
 * `describeError` kept only what may be read — so the line copies nothing
 * else.
 */

import type { DatabaseErrorDescription, ErrorDescription } from '@spfn/core/logger';

export type Description = ErrorDescription | DatabaseErrorDescription;

/**
 * Each link of the cause chain by its name, code, constraint and table, and
 * the message its description kept
 */
export function summarizeError(description: Description): string
{
    return chainOf(description).map(linkSummary).join(' ← ');
}

export function chainOf(description: Description): Description[]
{
    return description.kind === 'error' && description.cause
        ? [description, ...chainOf(description.cause)]
        : [description];
}

function linkSummary(link: Description): string
{
    const fields = link.kind === 'database'
        ? { code: link.code, constraint: link.constraint, table: link.table }
        : { code: link.code };
    const tags = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ` [${key}=${value}]`)
        .join('');

    return `${link.name}${tags}${link.message ? `: ${link.message}` : ''}`;
}
