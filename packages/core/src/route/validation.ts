/**
 * Route Input Validation
 *
 * Provides unified validation logic for route input fields
 */

import type { TSchema } from '@sinclair/typebox';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Context } from 'hono';
import { ValidationError } from '@spfn/core/errors';
import { formatFileSize } from './file-schema';

// ============================================
// Format Registry
// ============================================

FormatRegistry.Set('email', (value: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
);

FormatRegistry.Set('uri', (value: string) =>
    /^https?:\/\/.+/.test(value),
);

FormatRegistry.Set('uuid', (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
);

FormatRegistry.Set('date', (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value),
);

FormatRegistry.Set('date-time', (value: string) =>
    !isNaN(Date.parse(value)),
);

/**
 * Validation error field info
 */
interface ValidationFieldError
{
    path: string;
    message: string;
    value: unknown;
}

/**
 * Check if a value is a File object
 */
function isFile(value: unknown): value is File
{
    return value instanceof File ||
        (typeof value === 'object' &&
         value !== null &&
         'name' in value &&
         'size' in value &&
         'type' in value &&
         typeof (value as any).arrayBuffer === 'function');
}

/**
 * Check if a TypeBox schema represents a File type
 */
function isFileSchemaDef(schema: TSchema): boolean
{
    const kind = (schema as any)[Symbol.for('TypeBox.Kind')];

    return kind === 'File';
}

/**
 * Check if a TypeBox schema represents a FileArray type
 */
function isFileArraySchemaDef(schema: TSchema): boolean
{
    const kind = (schema as any)[Symbol.for('TypeBox.Kind')];

    return kind === 'FileArray';
}

/**
 * Get file options from schema
 */
function getSchemaFileOptions(schema: TSchema): any | undefined
{
    return (schema as any).fileOptions;
}

/**
 * Validate a single file against schema options
 */
function validateSingleFile(
    file: File,
    fieldPath: string,
    options: { maxSize?: number; minSize?: number; allowedTypes?: string[] } | undefined,
    errors: ValidationFieldError[],
): void
{
    if (!options) return;

    const { maxSize, minSize, allowedTypes } = options;

    if (maxSize !== undefined && file.size > maxSize)
    {
        errors.push({
            path: fieldPath,
            message: `File size ${formatFileSize(file.size)} exceeds maximum ${formatFileSize(maxSize)}`,
            value: file.size,
        });
    }

    if (minSize !== undefined && file.size < minSize)
    {
        errors.push({
            path: fieldPath,
            message: `File size ${formatFileSize(file.size)} is below minimum ${formatFileSize(minSize)}`,
            value: file.size,
        });
    }

    if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(file.type))
    {
        errors.push({
            path: fieldPath,
            message: `File type "${file.type}" is not allowed. Allowed: ${allowedTypes.join(', ')}`,
            value: file.type,
        });
    }
}

/**
 * What a request body is called in the message it fails its schema with:
 * `invalidInputMessage(REQUEST_BODY)` is `Invalid request body`.
 */
export const REQUEST_BODY = 'request body';

/**
 * The message of the `ValidationError` a part of the request fails its schema
 * with. Exported so that a check a handler makes on the same body after the
 * schema's answers with the message the schema's failure has, and cannot drift
 * from it.
 *
 * @param part - what the part is called (`REQUEST_BODY`, `'query parameters'`)
 */
export function invalidInputMessage(part: string): string
{
    return `Invalid ${part}`;
}

/**
 * Validate a value against a TypeBox schema
 *
 * @param schema - TypeBox schema to validate against
 * @param rawValue - Raw value to validate
 * @param fieldName - Field name for error messages
 * @returns Validated and converted value
 * @throws ValidationError if validation fails
 */
export function validateField<T extends Record<string, unknown>>(
    schema: TSchema | undefined,
    rawValue: Record<string, unknown>,
    fieldName: string,
): T
{
    if (!schema)
    {
        return {} as T;
    }

    const converted = Value.Convert(schema, rawValue);
    const errors = [...Value.Errors(schema, converted)];

    if (errors.length > 0)
    {
        throw new ValidationError({
            message: invalidInputMessage(fieldName),
            fields: errors.map((e): ValidationFieldError => ({
                path: e.path,
                message: e.message,
                value: e.value,
            })),
        });
    }

    return converted as T;
}

/**
 * Validate form data against a TypeBox schema
 *
 * Handles File fields specially:
 * - File/FileArray schemas are validated using fileOptions (maxSize, allowedTypes, etc.)
 * - Non-file fields are validated using TypeBox
 *
 * @param schema - TypeBox schema to validate against
 * @param rawValue - Raw form data to validate
 * @param fieldName - Field name for error messages
 * @returns Validated form data
 * @throws ValidationError if validation fails
 */
export function validateFormData<T extends Record<string, unknown>>(
    schema: TSchema | undefined,
    rawValue: Record<string, unknown>,
    fieldName: string,
): T
{
    if (!schema)
    {
        return {} as T;
    }

    // For Object schemas, validate non-File fields and validate File fields with fileOptions
    const schemaProps = (schema as any).properties;
    if (!schemaProps)
    {
        // Not an object schema, just return raw value
        return rawValue as T;
    }

    const result: Record<string, unknown> = {};
    const nonFileData: Record<string, unknown> = {};
    const nonFileSchema: Record<string, TSchema> = {};
    const fileErrors: ValidationFieldError[] = [];

    // Process each field
    for (const [key, value] of Object.entries(rawValue))
    {
        const propSchema = schemaProps[key];

        if (propSchema && isFileSchemaDef(propSchema))
        {
            // Single File field
            result[key] = value;

            if (isFile(value))
            {
                const fileOptions = getSchemaFileOptions(propSchema);
                validateSingleFile(value, `/${key}`, fileOptions, fileErrors);
            }
        }
        else if (propSchema && isFileArraySchemaDef(propSchema))
        {
            // File array field
            result[key] = value;

            const fileOptions = getSchemaFileOptions(propSchema);
            const files = Array.isArray(value) ? value : [value];
            const fileArray = files.filter(isFile);

            // Validate file count
            if (fileOptions?.maxFiles !== undefined && fileArray.length > fileOptions.maxFiles)
            {
                fileErrors.push({
                    path: `/${key}`,
                    message: `Too many files. Maximum: ${fileOptions.maxFiles}, received: ${fileArray.length}`,
                    value: fileArray.length,
                });
            }

            if (fileOptions?.minFiles !== undefined && fileArray.length < fileOptions.minFiles)
            {
                fileErrors.push({
                    path: `/${key}`,
                    message: `Too few files. Minimum: ${fileOptions.minFiles}, received: ${fileArray.length}`,
                    value: fileArray.length,
                });
            }

            // Validate each file
            fileArray.forEach((file, index) =>
            {
                validateSingleFile(file, `/${key}/${index}`, fileOptions, fileErrors);
            });
        }
        else if (isFile(value) || (Array.isArray(value) && value.some(isFile)))
        {
            // Value is a File but schema doesn't indicate it - pass through without validation
            result[key] = value;
        }
        else
        {
            // Non-file field - collect for TypeBox validation
            nonFileData[key] = value;
            if (propSchema)
            {
                nonFileSchema[key] = propSchema;
            }
        }
    }

    // Throw file validation errors if any
    if (fileErrors.length > 0)
    {
        throw new ValidationError({
            message: invalidInputMessage(fieldName),
            fields: fileErrors,
        });
    }

    // Validate non-file fields if any
    if (Object.keys(nonFileSchema).length > 0)
    {
        const tempSchema = {
            ...schema,
            properties: nonFileSchema,
            required: (schema as any).required?.filter((r: string) => r in nonFileSchema) ?? [],
        };

        const converted = Value.Convert(tempSchema, nonFileData);
        const errors = [...Value.Errors(tempSchema, converted)];

        if (errors.length > 0)
        {
            throw new ValidationError({
                message: invalidInputMessage(fieldName),
                fields: errors.map((e): ValidationFieldError => ({
                    path: e.path,
                    message: e.message,
                    value: e.value,
                })),
            });
        }

        // Merge validated non-file fields with file fields
        Object.assign(result, converted);
    }
    else
    {
        // No non-file fields to validate
        Object.assign(result, nonFileData);
    }

    return result as T;
}

/**
 * Extract query parameters from request URL
 *
 * Handles array values (multiple params with same key)
 */
export function extractQueryParams(c: Context): Record<string, string | string[]>
{
    const url = new URL(c.req.url);
    const queryObj: Record<string, string | string[]> = {};

    url.searchParams.forEach((v, k) =>
    {
        const existing = queryObj[k];
        if (existing)
        {
            queryObj[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
        }
        else
        {
            queryObj[k] = v;
        }
    });

    return queryObj;
}

/**
 * Extract headers from request (lowercase keys)
 */
export function extractHeaders(c: Context): Record<string, string>
{
    const rawHeaders: Record<string, string> = {};

    c.req.raw.headers.forEach((value, key) =>
    {
        rawHeaders[key.toLowerCase()] = value;
    });

    return rawHeaders;
}

/**
 * Extract and parse cookies from request
 */
export function extractCookies(c: Context): Record<string, string>
{
    const cookieHeader = c.req.header('cookie');
    const rawCookies: Record<string, string> = {};

    if (cookieHeader)
    {
        cookieHeader.split(';').forEach(cookie =>
        {
            const [key, value] = cookie.trim().split('=');
            if (key && value)
            {
                rawCookies[key] = decodeURIComponent(value);
            }
        });
    }

    return rawCookies;
}

/**
 * Parse JSON body from request
 *
 * @throws ValidationError if JSON parsing fails
 */
export async function parseJsonBody(c: Context): Promise<Record<string, unknown>>
{
    try
    {
        return await c.req.json();
    }
    catch (error)
    {
        throw new ValidationError({
            message: 'Invalid JSON body',
            fields: [{
                path: '/',
                message: 'Failed to parse JSON',
                value: error instanceof Error ? error.message : 'Unknown error',
            }],
        });
    }
}

/**
 * Parse multipart/form-data from request
 *
 * Handles file uploads and form fields.
 * Multiple files with same key are collected into arrays.
 *
 * @throws ValidationError if form data parsing fails
 */
export async function parseFormData(c: Context): Promise<Record<string, unknown>>
{
    try
    {
        const formData = await c.req.formData();
        const result: Record<string, unknown> = {};

        formData.forEach((value, key) =>
        {
            const existing = result[key];

            if (existing !== undefined)
            {
                // Multiple values with same key - convert to array
                if (Array.isArray(existing))
                {
                    existing.push(value);
                }
                else
                {
                    result[key] = [existing, value];
                }
            }
            else
            {
                result[key] = value;
            }
        });

        return result;
    }
    catch (error)
    {
        throw new ValidationError({
            message: 'Invalid form data',
            fields: [{
                path: '/',
                message: 'Failed to parse form data',
                value: error instanceof Error ? error.message : 'Unknown error',
            }],
        });
    }
}
