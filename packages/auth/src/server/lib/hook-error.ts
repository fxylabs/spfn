/**
 * What the package keeps of an error an app's deletion hook threw: its class
 * name and, when a database statement failed, the SQLSTATE — identifiers
 * only. The hook was handed the account's email and phone, and its error's
 * text may quote them anywhere: its message, a driver error's `detail`, a
 * cause down the chain. The package never holds on to the error itself, so no
 * logger, serializer or response body can walk to that text.
 *
 * @module lib/hook-error
 */

import { describeError, type ErrorDescription, type DatabaseErrorDescription } from '@spfn/core/logger';

/** A SQLSTATE is exactly five characters, digits and uppercase letters only: `23505`, `08P01` */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

export interface HookErrorIdentity
{
    /** The thrown value's class (`Error`, `DrizzleQueryError`), or its `typeof` when it is not an object */
    hookErrorClass: string;
    /** The SQLSTATE of the first database error in its cause chain, if there is one */
    hookErrorCode?: string;
}

/** The class name and SQLSTATE of what a hook threw, and nothing it says. */
export function identifyHookError(error: unknown): HookErrorIdentity
{
    const hookErrorCode = sqlStateOf(error);

    return hookErrorCode === undefined
        ? { hookErrorClass: classNameOf(error) }
        : { hookErrorClass: classNameOf(error), hookErrorCode };
}

function classNameOf(error: unknown): string
{
    if (typeof error !== 'object' || error === null)
    {
        return typeof error;
    }

    return Object.getPrototypeOf(error)?.constructor?.name || 'Object';
}

/** Walks core's description of the chain, which bounds its depth and stops at a cycle. */
function sqlStateOf(error: unknown): string | undefined
{
    let link: ErrorDescription | DatabaseErrorDescription | undefined = describeError(error, { stack: false });
    while (link)
    {
        if (link.kind === 'database' && link.code !== undefined && SQLSTATE_PATTERN.test(link.code))
        {
            return link.code;
        }
        link = link.kind === 'error' ? link.cause : undefined;
    }

    return undefined;
}
