/**
 * Serializable Error Base Class
 *
 * Base class for errors that can be serialized/deserialized across HTTP boundary.
 * Automatically serializes public fields for transmission to client.
 */

// Package specifier, not '../logger': tsup marks `@spfn/*` external, so a
// relative import would inline a SECOND logger singleton into this entrypoint's
// bundle — and into every bundle that imports errors (issue #136).
import { logger } from '@spfn/core/logger';

/**
 * Serialized error format for JSON transmission
 */
export interface SerializedError
{
    __type: string;
    message: string;
    [key: string]: unknown;
}

/**
 * Field names an error class may not use.
 *
 * Public fields are spread into the response body next to `__type`, `message`
 * and the `error` envelope the error handler attaches, so a field sharing one
 * of those names collides with the response shape every consumer reads: the
 * web client restores an error class from `__type` and a generated mobile
 * client reads `error.code`. Reserving the three names removes the collision
 * instead of picking a winner for it — either winner loses something the other
 * side needs.
 */
const RESERVED_RESPONSE_KEYS = new Set(['__type', 'message', 'error']);

/**
 * Environments where a developer is watching and can still rename the class.
 * Anything else is a running deployment, `staging` included — there the throw
 * would replace a real failure with a failure about serializing it, and the
 * original error would never reach the log or the client.
 */
const AUTHORING_ENVIRONMENTS = new Set(['local', 'development', 'test']);

/**
 * Answer a reserved field name: loudly while it can still be renamed, quietly
 * once a rename is no longer possible.
 *
 * While authoring, the throw is the point — the class is renamed the first time
 * a test serializes it.
 */
function refuseReservedKey(className: string, key: string): never | void
{
    const detail = `${className} declares the reserved field "${key}". `
        + `Reserved response keys: ${[...RESERVED_RESPONSE_KEYS].join(', ')}. Rename the field.`;

    if (AUTHORING_ENVIRONMENTS.has(process.env.NODE_ENV ?? 'local'))
    {
        throw new Error(detail);
    }

    logger.error(`[SerializableError] ${detail} The field is omitted from the response.`);
}

/**
 * The key under which every `SerializableError` carries its brand — the
 * class's identity across module copies, where `instanceof` fails (#382)
 */
export const SERIALIZABLE_ERROR_BRAND: unique symbol = Symbol.for('spfn.core.serializableError');

/**
 * Base class for all serializable errors
 *
 * Features:
 * - Auto-serialization of public fields via toJSON()
 * - Constructor accepts object with all fields
 * - Type-safe error handling with instanceof
 *
 * @example
 * ```typescript
 * class PaymentFailedError extends SerializableError
 * {
 *     readonly statusCode = 402;
 *     transactionId!: string;
 *     reason!: 'insufficient_funds' | 'card_declined';
 *
 *     constructor(data: {
 *         message: string;
 *         transactionId: string;
 *         reason: 'insufficient_funds' | 'card_declined';
 *     })
 *     {
 *         super(data.message);
 *         this.name = 'PaymentFailedError';
 *         Object.assign(this, data);
 *     }
 * }
 * ```
 */
export abstract class SerializableError extends Error
{
    /**
     * The brand `isSerializableError` reads. A global-registry symbol, so a
     * second copy of this module (dev under tsx, a test runner) brands its
     * errors with the same key. A prototype getter: no own key, so `toJSON()`
     * never copies it.
     */
    get [SERIALIZABLE_ERROR_BRAND](): true
    {
        return true;
    }

    /**
     * HTTP status code for this error type
     */
    abstract readonly statusCode: number;

    /**
     * Serialize error to JSON-compatible object
     *
     * Automatically includes:
     * - __type: Constructor name for deserialization
     * - message: Error message
     * - All public instance properties (except name, stack)
     */
    toJSON(): SerializedError
    {
        const json: SerializedError = {
            __type: this.constructor.name,
            message: this.message,
        };

        // Extract all public instance properties
        for (const key of Object.keys(this))
        {
            // Skip Error built-ins and statusCode (inferred from type)
            if (key === 'name' || key === 'stack' || key === 'statusCode')
            {
                continue;
            }

            if (RESERVED_RESPONSE_KEYS.has(key))
            {
                refuseReservedKey(this.constructor.name, key);
                continue;
            }

            json[key] = (this as unknown as Record<string, unknown>)[key];
        }

        return json;
    }
}
