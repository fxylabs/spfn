/**
 * Options the Application States
 *
 * The one way a package reads an object of options the application hands
 * over — `@spfn/auth`'s `createAuthLifecycle(options)`, each object inside it,
 * `configureAuth` and the other `configure*` functions (#477). For packages;
 * an application may use it. Isomorphic: it imports nothing, so a browser or
 * edge bundle may import it too (#492).
 *
 * A reader that checks one reach of the object and uses another loses what the
 * application stated. `Object.keys` (own, enumerable) beside `options.x` (own
 * or inherited) ignores an inherited misspelling and drops an inherited option
 * for its default; a value checked on one read and stored from another stores
 * what a getter answered the second time, which never passed the check. So a
 * reader here reaches the object once: it must be a plain object, every own
 * name it carries must be one the reader knows, and each known option is read
 * once into a snapshot. The caller checks the snapshot and stores from it, and
 * never reads the application's object again.
 *
 * Only Node tells a Proxy from its target, so a Proxy is refused on Node and
 * read like any object where the host cannot tell (a browser or edge bundle):
 * the same call answers differently by host for a Proxy (`isProxy`).
 */

/** How the messages name what an object holds: options, or channels for `channels`. */
export interface OptionTerms
{
    /** One key, with its article, as in "`channels.totp` is not a channel". */
    noun: string;

    /** The keys, as in "Known channels: …". */
    plural: string;

    /** What the object gives, as in "must be a plain object giving channels true or false". */
    giving: string;

    /**
     * Keys this reader once knew, each with the refusal that says what became
     * of it, so an application that still states one learns that rather than
     * "is not an option".
     */
    removed?: ReadonlyMap<string, string>;
}

export const OPTION_TERMS: OptionTerms = { noun: 'an option', plural: 'options', giving: 'naming its options' };

/**
 * Every option of `T`, named by an object that must hold each one: an option
 * added to `T` and not here fails type-check, where a list typed
 * `ReadonlyArray<keyof T>` would admit the gap and a reader would refuse the
 * new option at runtime as "not an option".
 *
 * @example
 * ```ts
 * const DEVICE_LINK_OPTIONS = optionKeys<AuthDeviceLinkConfig>({ ttlMs: true });
 * ```
 */
export function optionKeys<T extends object>(names: { [K in keyof T]-?: true }): (keyof T & string)[]
{
    return Object.keys(names) as (keyof T & string)[];
}

/**
 * The options `options` states, each read once: a key it carries as an own
 * property, with the value that one read answered. A key it does not carry is
 * absent from the snapshot; one it carries as `undefined` is present as
 * `undefined`.
 *
 * @param name - The option as messages name it: `deletion`, `channels`,
 *   `configureAuth: oauthLink`
 * @param options - What the application handed over. `undefined` is the
 *   caller's to handle: it means "not stated", and is refused here
 * @param keys - Every option this reader knows
 * @throws Error when `options` is not a plain object, or carries an own name —
 *   enumerable or not — that is not in `keys`
 */
export function readOptions<T extends object>(
    name: string,
    options: unknown,
    keys: readonly (keyof T & string)[],
    terms: OptionTerms = OPTION_TERMS,
): Partial<T>
{
    requirePlainObject(name, options, `${terms.giving} — ${keys.join(', ')}`);
    refuseUnknownNames(name, options, keys, terms);

    return snapshot(options, keys) as Partial<T>;
}

/**
 * Every entry of a map keyed by the application's own names —
 * `authorizationServer.scopes`, `rolePermissions` — each read once. It has no
 * known keys to refuse against, but it must still be a plain object, so its
 * own names are every name a read of it could reach; each one, enumerable or
 * not, is read into the snapshot.
 *
 * @param giving - What the map gives, for the refusal: `naming each scope`
 * @throws Error when `entries` is not a plain object
 */
export function readEntries<V>(name: string, entries: unknown, giving: string): Record<string, V>
{
    requirePlainObject(name, entries, giving);

    return snapshot(entries, Object.getOwnPropertyNames(entries)) as Record<string, V>;
}

/**
 * The elements of a list the application hands over — `defaultScopes`,
 * `opsOrUser`'s `roles`, each `rolePermissions` entry — each read once into a
 * new frozen array: that copy is what the caller checks and keeps, so a later
 * `push` or index assignment on the application's array changes nothing.
 *
 * The list must be an ordinary array (`Array.isArray`, and not a Proxy, which
 * `Array.isArray` sees through: it answers whether it has a place and what a
 * read of that place finds each from its handler). A `Set` or an array-like
 * object, whose elements a loop over `length` would find none of, fails. It
 * must hold every place below its `length` as its own: a hole would read
 * through to `Array.prototype`. Then `list[i]` reaches only the list's own
 * elements.
 *
 * @param giving - What the list holds, for the refusal: `of scope names`
 * @throws Error when `list` is not such an array
 */
export function readList<V>(name: string, list: unknown, giving: string): readonly V[]
{
    if (!isOrdinaryObject(list) || !Array.isArray(list))
    {
        throw new Error(`${name} must be an array ${giving}; received ${describeNotPlain(list)}.`);
    }

    return Object.freeze(listElements(name, list)) as readonly V[];
}

/**
 * Every record of a list the application hands over — `roles`, the entries
 * of `defineUserSettings` — the list read once by `readList` and each record
 * once by `readOptions` with `keys`, named in messages by its place:
 * `roles[2].prority is not an option`.
 *
 * @throws Error when `list` is refused by `readList`, or a record by
 *   `readOptions`
 */
export function readRecords<T extends object>(name: string, list: unknown, keys: readonly (keyof T & string)[]): Partial<T>[]
{
    return readList(name, list, `of plain objects naming their options — ${keys.join(', ')}`)
        .map((record, index) => readOptions<T>(`${name}[${index}]`, record, keys));
}

/** Each place of `list`, read once; a hole is refused rather than read through to `Array.prototype`. */
function listElements(name: string, list: readonly unknown[]): unknown[]
{
    const elements: unknown[] = [];

    for (let index = 0; index < list.length; index++)
    {
        if (!Object.hasOwn(list, index))
        {
            throw new Error(`${name}[${index}] is empty: a hole in the list would be read from Array.prototype.`);
        }

        elements.push(list[index]);
    }

    return elements;
}

function requirePlainObject(name: string, value: unknown, giving: string): asserts value is object
{
    if (!isPlainObject(value))
    {
        throw new Error(`${name} must be a plain object ${giving}; received ${describeNotPlain(value)}.`);
    }
}

/**
 * Each own key of `keys` that `options` carries, read once. `Object.hasOwn`
 * reads the property's description, never its value, so a getter runs once:
 * for the snapshot.
 */
function snapshot(options: object, keys: readonly string[]): Record<string, unknown>
{
    return Object.fromEntries(keys
        .filter(key => Object.hasOwn(options, key))
        .map(key => [key, (options as Record<string, unknown>)[key]]));
}

/**
 * An object literal, `JSON.parse` output, `Object.create(null)`, or one of
 * these from another realm (`vm`, an iframe): its prototype is `null` or the
 * `Object.prototype` of some realm. A read `options[name]` then reaches the
 * object's own names and that `Object.prototype`, which holds no option — so
 * the own names are every name the read can find.
 *
 * Anything else — a class instance, a `Map`, an array, an object made by
 * `Object.create` from another object — has a prototype the read reaches
 * into, where an option or a misspelt one would be found or lost unseen.
 * A Proxy too, whatever its prototype (`isOrdinaryObject`).
 */
function isPlainObject(options: unknown): options is object
{
    if (!isOrdinaryObject(options))
    {
        return false;
    }

    const prototype = Object.getPrototypeOf(options);

    return prototype === null || isObjectPrototype(prototype);
}

/**
 * An object that is not a Proxy: the one check every container the rule
 * reads — an options object, a map, a list — passes through. A Proxy answers
 * the question of its names, whether it has one and what a read finds each
 * from its handler, so what was checked of it does not say what is read.
 */
function isOrdinaryObject(value: unknown): value is object
{
    return typeof value === 'object' && value !== null && !isProxy(value);
}

/** What `isProxy` needs of the host's `process`: Node's, where `getBuiltinModule` is. */
interface HostProcess
{
    getBuiltinModule?(id: string): { types: { isProxy(value: unknown): boolean } };
}

/**
 * Whether `value` is a Proxy, as the running host tells: Node's
 * `util.types.isProxy`, taken through `process.getBuiltinModule` (as
 * `module-evaluation.ts` takes `node:fs`), so the module holds no `node:`
 * import a bundler would have to replace — a browser's userland `util`
 * throws from `types.isProxy`. `process` is read off `globalThis`: a free
 * `process` would have a client bundler inject a shim. Where the host has no
 * `getBuiltinModule` — a browser or edge bundle — it cannot tell, and a Proxy
 * is read like any object, under every other part of the rule.
 */
function isProxy(value: unknown): boolean
{
    return (globalThis as { process?: HostProcess }).process
        ?.getBuiltinModule?.('node:util').types.isProxy(value) ?? false;
}

/**
 * The source text of the built-in `Object`, as this engine prints it. Every
 * realm's `Object` prints the same, and no function written in JavaScript
 * prints `[native code]`.
 */
const OBJECT_SOURCE = Function.prototype.toString.call(Object);

/**
 * Whether `candidate` is the `Object.prototype` of some realm. Each realm's
 * `Object` keeps its `prototype` in a property that can be neither written
 * nor redefined, so `candidate` is one when its `constructor` is a realm's
 * built-in `Object` — the only function whose source reads as `Object`'s
 * does in this realm (`OBJECT_SOURCE`); not a class, a bound function or a
 * Proxy — and that `Object`'s `prototype` is `candidate`. An
 * `Object.create(null)` given a `constructor` still fails: no `Object` names
 * it as its `prototype`.
 */
function isObjectPrototype(candidate: object): boolean
{
    const constructor: unknown = Object.getOwnPropertyDescriptor(candidate, 'constructor')?.value;

    return Object.getPrototypeOf(candidate) === null
        && typeof constructor === 'function'
        && Function.prototype.toString.call(constructor) === OBJECT_SOURCE
        && Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value === candidate;
}

function describeNotPlain(value: unknown): string
{
    if (isProxy(value))
    {
        return 'a Proxy, whose names do not say what a read of it finds';
    }

    if (Array.isArray(value))
    {
        return 'an array';
    }

    return typeof value === 'object' && value !== null ? 'an object with another prototype' : String(value);
}

/**
 * A name the object carries that this reader does not know — a misspelt
 * option would otherwise be read as left out. Every own name, enumerable or
 * not: for a plain object those are all the read reaches besides
 * `Object.prototype`. Symbols are passed over: the read never reaches one,
 * and none is a misspelt option.
 */
function refuseUnknownNames(name: string, options: object, keys: readonly string[], terms: OptionTerms): void
{
    const unknown = Object.getOwnPropertyNames(options).find(key => !keys.includes(key));

    if (unknown === undefined)
    {
        return;
    }

    throw new Error(terms.removed?.get(unknown)
        ?? `${name}.${unknown} is not ${terms.noun}. Known ${terms.plural}: ${keys.join(', ')}.`);
}
