/**
 * Leak probe for #382
 *
 * A database error built the way drizzle and postgres.js build one, carrying
 * obviously fake values, and a logger that renders what it is given through
 * both formatters — so a row can assert none of the values reaches the output.
 */

import postgres from 'postgres';
import { DrizzleQueryError } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { formatConsole, formatJSON } from '../../formatters';
import type { LogMetadata, LoggerConfig } from '../../types';

/** The values bound to the failed insert; none may be logged, stored or answered */
export const BOUND_VALUES = ['leak-probe@example.test', '$2b$FAKEHASH'] as const;

export const FAILED_INSERT = 'insert into "users" ("email", "password_hash") values ($1, $2)';

/**
 * The driver's 23505 as postgres.js raises it: every ErrorResponse field
 * copied onto the error, `detail` holding the duplicated key's value
 */
export function uniqueViolation(): postgres.PostgresError
{
    // The driver passes the parsed ErrorResponse; the published type says string
    const fields = {
        severity_local: 'ERROR',
        severity: 'ERROR',
        code: '23505',
        message: 'duplicate key value violates unique constraint "users_email_key"',
        detail: `Key (email)=(${BOUND_VALUES[0]}) already exists.`,
        schema_name: 'public',
        table_name: 'users',
        constraint_name: 'users_email_key',
        file: 'nbtinsert.c',
        line: '666',
        routine: '_bt_check_unique',
    };

    return new postgres.PostgresError(fields as unknown as string);
}

/**
 * drizzle's query error over that 23505: the values sit in `params`, in its
 * message and in the stack header that repeats the message
 */
export function failedInsert(): DrizzleQueryError
{
    return new DrizzleQueryError(FAILED_INSERT, [...BOUND_VALUES], uniqueViolation());
}

/**
 * Assert the text holds none of the bound values, nor drizzle's params line
 * or the driver's `detail`
 */
export function expectNoValues(text: string): void
{
    for (const value of [...BOUND_VALUES, 'params:', 'Key ('])
    {
        expect(text).not.toContain(value);
    }
}

/**
 * A logger class's instance whose one transport keeps every line as the
 * console and JSON formatters render it
 */
export function capturingLogger<T>(LoggerClass: new (config: LoggerConfig) => T): { logger: T; output: () => string; lines: LogMetadata[] }
{
    const lines: LogMetadata[] = [];
    const logger = new LoggerClass({
        level: 'debug',
        transports: [{
            name: 'capture',
            level: 'debug',
            enabled: true,
            log: async (metadata) =>
            {
                lines.push(metadata);
            },
        }],
    });

    return {
        logger,
        lines,
        output: () => lines.map(line => `${formatConsole(line, false)}\n${formatJSON(line)}`).join('\n'),
    };
}

/**
 * Route every line any instance of the logger class writes — the built
 * `@spfn/core/logger` the runner, error handler and request logger use — into
 * a capturing instance of that class. Undone by `vi.restoreAllMocks()`.
 */
export function captureLoggerClass<T extends object>(LoggerClass: (new (config: LoggerConfig) => T) & { prototype: T }): ReturnType<typeof capturingLogger<T>>
{
    const capture = capturingLogger(LoggerClass);

    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const)
    {
        const original = (LoggerClass.prototype as Record<string, (...args: unknown[]) => void>)[level];

        vi.spyOn(LoggerClass.prototype as Record<string, (...args: unknown[]) => void>, level).mockImplementation((...args: unknown[]) =>
        {
            original.apply(capture.logger, args);
        });
    }

    return capture;
}
