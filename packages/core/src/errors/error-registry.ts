/**
 * Error Registry
 *
 * Central registry for serializable error types.
 * Enables automatic error deserialization on the client side.
 */

import type { SerializableError } from './serializable-error';

/**
 * Error constructor type
 */
export type SerializableErrorConstructor = new (data: any) => SerializableError;

/**
 * Input type for ErrorRegistry constructor
 */
export type ErrorRegistryInput =
    | SerializableErrorConstructor
    | SerializableErrorConstructor[]
    | ErrorRegistry;

/**
 * Build `ErrorClass` once with no data and read the `name` the instance carries.
 * A constructor that cannot be built without its fields has no name to offer.
 */
function probeName(ErrorClass: SerializableErrorConstructor): string | undefined
{
    try
    {
        return new ErrorClass({}).name;
    }
    catch
    {
        return undefined;
    }
}

/**
 * The name instances of `ErrorClass` set for themselves, or undefined when they
 * only inherit one.
 *
 * A minified browser bundle renames the class binding (`Q`, `eA`, …) but keeps
 * the string the constructor assigns to `this.name`, while the server — which is
 * not minified — sends `__type` as the class name that string repeats. So in the
 * browser this name is the one that still matches `__type`.
 *
 * A name equal to the parent's is inherited: a subclass that never sets
 * `this.name` answers with its parent's, and keying it there would let the
 * subclass stand in for the parent.
 */
function ownInstanceName(ErrorClass: SerializableErrorConstructor): string | undefined
{
    const name = probeName(ErrorClass);
    const Parent = Object.getPrototypeOf(ErrorClass) as SerializableErrorConstructor;

    return name !== undefined && name !== probeName(Parent) ? name : undefined;
}

/**
 * Error registry for serialization/deserialization
 *
 * @example
 * ```typescript
 * // Create registry with initial errors
 * const registry = new ErrorRegistry([
 *     errorRegistry,           // Another ErrorRegistry
 *     PaymentFailedError,      // Single error class
 *     [RefundError, OrderError], // Array of error classes
 * ]);
 *
 * // Or create empty and append
 * const registry = new ErrorRegistry();
 * registry
 *     .append(ValidationError)
 *     .append([PaymentFailedError, RefundError]);
 *
 * // Deserialize from JSON
 * const error = registry.deserialize({
 *     __type: 'PaymentFailedError',
 *     message: 'Payment failed',
 *     transactionId: 'tx_123',
 *     reason: 'insufficient_funds'
 * });
 *
 * // error instanceof PaymentFailedError === true
 * ```
 */
export class ErrorRegistry
{
    private errors = new Map<string, SerializableErrorConstructor>();

    /**
     * The same classes keyed by the name their instances set for themselves.
     * Consulted only when no class is registered under the constructor name, so
     * an unminified registry resolves exactly as before and a minified one —
     * whose constructor names are `Q`, `eA`, … — still resolves `__type`.
     */
    private instanceNames = new Map<string, SerializableErrorConstructor>();

    constructor(initialErrors?: ErrorRegistryInput[])
    {
        if (initialErrors)
        {
            for (const input of initialErrors)
            {
                if (input instanceof ErrorRegistry)
                {
                    this.concat(input);
                }
                else if (Array.isArray(input))
                {
                    this.append(input);
                }
                else
                {
                    this.append(input);
                }
            }
        }
    }

    /**
     * Append error class(es) to the registry
     *
     * @param ErrorClass - Single error constructor
     * @returns This registry for chaining
     */
    append(ErrorClass: SerializableErrorConstructor): this;

    /**
     * Append error class(es) to the registry
     *
     * @param ErrorClasses - Array of error constructors
     * @returns This registry for chaining
     */
    append(ErrorClasses: SerializableErrorConstructor[]): this;

    /**
     * Append error class(es) to the registry
     *
     * @param input - Error constructor or array of constructors
     * @returns This registry for chaining
     */
    append(input: SerializableErrorConstructor | SerializableErrorConstructor[]): this
    {
        for (const ErrorClass of Array.isArray(input) ? input : [input])
        {
            this.register(ErrorClass);
        }

        return this;
    }

    /**
     * Key `ErrorClass` by its constructor name and, when its instances set one of
     * their own, by that name too.
     */
    private register(ErrorClass: SerializableErrorConstructor): void
    {
        this.errors.set(ErrorClass.name, ErrorClass);

        const name = ownInstanceName(ErrorClass);

        if (name !== undefined)
        {
            this.instanceNames.set(name, ErrorClass);
        }
    }

    /**
     * Concatenate another ErrorRegistry into this one
     *
     * @param registry - Another ErrorRegistry to merge
     * @returns This registry for chaining
     */
    concat(registry: ErrorRegistry): this
    {
        for (const [name, ErrorClass] of registry.errors)
        {
            this.errors.set(name, ErrorClass);
        }

        for (const [name, ErrorClass] of registry.instanceNames)
        {
            this.instanceNames.set(name, ErrorClass);
        }

        return this;
    }

    /**
     * The class registered for `type`: by constructor name first, then by the
     * name its instances carry.
     */
    private find(type: string): SerializableErrorConstructor | undefined
    {
        return this.errors.get(type) ?? this.instanceNames.get(type);
    }

    /**
     * Check if error type is registered
     *
     * @param name - Error class name, or the name its instances carry
     */
    has(name: string): boolean
    {
        return this.find(name) !== undefined;
    }

    /**
     * Deserialize error from JSON data
     *
     * @param data - Serialized error data with __type field
     * @returns Deserialized error instance
     * @throws Error if error type is not registered
     */
    deserialize(data: { __type: string; [key: string]: any }): SerializableError
    {
        const ErrorClass = this.find(data.__type);

        if (!ErrorClass)
        {
            throw new Error(`Unknown error type: ${data.__type}`);
        }

        // `__type` routed this lookup and `error` is the response envelope: both
        // describe the response, not the error. The documented constructor shape
        // is Object.assign(this, data), which would otherwise copy them onto the
        // instance as reserved fields — and a reserved field refuses to serialize
        // the moment a server re-throws this error.
        const { __type: _type, error: _envelope, ...fields } = data;

        return new ErrorClass(fields);
    }

    /**
     * Try to deserialize error, return null if type unknown
     *
     * @param data - Serialized error data
     * @returns Deserialized error or null
     */
    tryDeserialize(data: { __type?: string; [key: string]: any }): SerializableError | null
    {
        if (!data.__type || !this.has(data.__type))
        {
            return null;
        }

        try
        {
            return this.deserialize(data as any);
        }
        catch
        {
            return null;
        }
    }

    /**
     * Get all registered error types
     */
    getRegisteredTypes(): string[]
    {
        return [...new Set([...this.errors.keys(), ...this.instanceNames.keys()])];
    }
}
