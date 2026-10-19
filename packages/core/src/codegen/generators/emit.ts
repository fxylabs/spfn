/**
 * Emit
 *
 * The literals the generators write into a generated file: an object key and a
 * string. Shared so every generated file spells a name the same way — a state
 * id and a route name reach the same `__proto__` and quoting rules.
 */

/**
 * A route name is a key in an object literal, and a key that is not an
 * identifier has to be quoted or the generated file will not parse.
 *
 * The source parser could never produce such a name — it read names off
 * `export const` — but `defineRouter({ 'get-user': getUser })` is a legal
 * router that the server registers as `get-user`, so the map has to be able to
 * spell it. `JSON.stringify` is the escaping: double quotes are what it emits,
 * and every other name is left bare so an unchanged project regenerates
 * byte-identically.
 */
export function toObjectKey(name: string): string
{
    // `__proto__:` in an object literal sets the prototype instead of defining
    // an own property, and so does `"__proto__":` — the route would vanish from
    // Object.keys and from the proxy's spread. A computed key is the one form
    // that always defines an own property.
    if (name === '__proto__')
    {
        return `[${JSON.stringify(name)}]`;
    }

    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Printable ASCII, minus the two characters a single-quoted literal cannot hold.
 * Every realistic path is in here and is emitted as it always was, so an
 * unchanged project regenerates byte-identically.
 */
const SINGLE_QUOTABLE = /^[\x20-\x26\x28-\x5B\x5D-\x7E]*$/;

/**
 * A path is emitted as a string literal, and a path carrying a quote, a
 * backslash or a line terminator would close it early — or end the line — and
 * leave a `DO NOT EDIT` file whose syntax error points at nothing.
 *
 * `JSON.stringify` handles all of those, so anything outside the plain ASCII a
 * single-quoted literal can hold is handed to it. U+2028 and U+2029 are the
 * exception it does not cover: they are legal in a JSON string and were a line
 * terminator in string literals before ES2019, so they are escaped by hand.
 */
export function toStringLiteral(value: string): string
{
    if (SINGLE_QUOTABLE.test(value))
    {
        return `'${value}'`;
    }

    return JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
