/**
 * Text that lands in a migration file: constraint names and SQL literals.
 *
 * Shared by `enumCheck` and the tenancy constraints and policies. A migration
 * file holds no bound parameters, so a value is written into it as a literal.
 */

import { createHash } from 'crypto';

/** PostgreSQL truncates identifiers to 63 bytes. */
const MAX_IDENTIFIER_BYTES = 63;
const HASH_LENGTH = 8;

/**
 * `<table>_<suffix>`, or — past 63 bytes, where PostgreSQL would truncate it and
 * two names could become one — its first 54 bytes, `_`, and 8 hex digits of a
 * hash of the whole name.
 */
export function constraintName(table: string, suffix: string): string
{
    const full = `${table}_${suffix}`;

    if (Buffer.byteLength(full) <= MAX_IDENTIFIER_BYTES)
    {
        return full;
    }

    const hash = createHash('sha256').update(full).digest('hex').slice(0, HASH_LENGTH);

    return `${truncateBytes(full, MAX_IDENTIFIER_BYTES - HASH_LENGTH - 1)}_${hash}`;
}

/** A string quoted with `'` doubled, a number or a boolean, as SQL text. */
export function sqlLiteral(value: string | number | boolean): string
{
    return typeof value === 'string' ? `'${value.replaceAll('\'', '\'\'')}'` : String(value);
}

function truncateBytes(text: string, maxBytes: number): string
{
    let result = '';

    for (const char of text)
    {
        if (Buffer.byteLength(result + char) > maxBytes)
        {
            break;
        }

        result += char;
    }

    return result;
}
