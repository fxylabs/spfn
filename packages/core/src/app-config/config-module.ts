/**
 * The one rule for a configuration file that exists: its default export is the
 * configuration, and it is a plain object.
 *
 * Shared by `spfn.config.js` (`loadAppConfig`) and `server.config`
 * (`loadServerConfigFile`). Only an absent file means "no configuration". A file
 * that is there but exports nothing usable — named exports only,
 * `export default 42`, a promise — is a mistake in it, and the loader refuses
 * rather than run the app on defaults. A promise is not awaited: the builder's
 * `.build()` returns the object itself, and no loader ever promised more.
 *
 * Free of side effects, like the rest of `app-config`: the CLI imports it.
 *
 * @module app-config/config-module
 */

/**
 * The module's default export, when it is a plain object.
 *
 * @throws Error naming the file and what its default export was instead
 */
export function plainObjectDefault(module: Record<string, unknown>, filePath: string): Record<string, unknown>
{
    const exported = withoutInteropWrapper(module);

    if (isPlainObject(exported.default))
    {
        return exported.default;
    }

    throw new Error(
        `Refusing to start: ${filePath} must export its configuration as a plain object `
        + `(export default { ... }), and it exports ${describeDefaultExport(exported)}.`,
    );
}

/**
 * The module as its author wrote it. A CommonJS file compiled from TypeScript
 * (`exports.default = { ... }`) imported by Node's `import()` arrives as
 * `{ default: { __esModule: true, default: { ... } } }` — `module.exports` is
 * the namespace's default — and the outer default would pass as a plain object
 * holding none of the settings. Exactly one level is unwrapped, and only when
 * the namespace's default marks it: `__esModule` on it, or `default` as its
 * only own key. The namespace's own `__esModule` is no mark: a loader that has
 * already unwrapped the file (vite's) sets it too.
 */
function withoutInteropWrapper(module: Record<string, unknown>): Record<string, unknown>
{
    const wrapped = module.default;

    return isObject(wrapped) && (wrapped.__esModule === true || Object.keys(wrapped).join() === 'default')
        ? wrapped
        : module;
}

function isObject(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null;
}

/**
 * An object literal, or one made with a null prototype. Read by prototype
 * depth rather than `=== Object.prototype`, so an object from another realm
 * (a vm context, a test runner) still counts.
 */
function isPlainObject(value: unknown): value is Record<string, unknown>
{
    if (!isObject(value))
    {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);

    return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function describeDefaultExport(module: Record<string, unknown>): string
{
    if (!('default' in module))
    {
        const named = Object.keys(module);

        return named.length > 0 ? `no default, only named exports (${named.join(', ')})` : 'nothing';
    }

    return describeValue(module.default);
}

function describeValue(value: unknown): string
{
    if (value === null || value === undefined)
    {
        return `a default of ${String(value)}`;
    }

    if (typeof (value as { then?: unknown }).then === 'function')
    {
        return 'a promise as its default — it is not awaited; export the object itself';
    }

    if (Array.isArray(value))
    {
        return 'an array as its default';
    }

    if (typeof value === 'object')
    {
        return `an instance of ${value.constructor?.name ?? 'an unnamed class'} as its default`;
    }

    return `a ${typeof value} as its default${typeof value === 'function' ? '' : ` (${String(value)})`}`;
}
