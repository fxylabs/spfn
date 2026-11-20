/**
 * Logger Class
 *
 * Central logging class with multiple transports, child loggers, and sensitive data masking.
 */

import { format } from 'node:util';
import type { LogLevel, LogMetadata, LoggerConfig, Transport } from './types';
import { LOG_LEVEL_PRIORITY } from './types';
import { maskContext } from './formatters';
import { describeError, isError } from './error-description';

const FORMAT_PATTERN = /%[sdifjoOc%]/;

/**
 * Whether the only argument after the message is the caught value rather
 * than the context: an Error, or anything that is not an object
 */
function isCaught(value: unknown): boolean
{
    return value !== undefined && (isError(value) || typeof value !== 'object' || value === null);
}

/**
 * The context argument, if it is an object
 */
function asContext(value: unknown): Record<string, unknown> | undefined
{
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/**
 * Logger class
 */
export class Logger
{
    private readonly config: LoggerConfig;
    private readonly module?: string;

    constructor(config: LoggerConfig)
    {
        this.config = config;
        this.module = config.module;
    }

    /**
     * Get current log level
     */
    get level(): LogLevel
    {
        return this.config.level;
    }

    /**
     * Create child logger (per module)
     */
    child(module: string): Logger
    {
        return new Logger({
            ...this.config,
            module,
        });
    }

    /**
     * Log at a level: the arguments after the message decide what is the
     * caught value and what is the context, by position.
     *
     * - `(message, caught, context)`: the second argument **is** the caught
     *   value, whatever its shape — `undefined`, a string, a plain object —
     *   and the context is always kept.
     * - `(message, value)`: an Error, or anything that is not an object, is the
     *   caught value; any other object is the context. A catch site whose value
     *   may not be an Error passes `{ error }` or the three-argument form.
     * - A printf token in the message formats the second argument into it.
     */
    private logWithLevel(level: LogLevel, message: string, args: unknown[]): void
    {
        // Early return if log level is below configured level
        // This prevents unnecessary description and masking
        if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.level])
        {
            return;
        }

        const [value, context] = args;

        if (value !== undefined && FORMAT_PATTERN.test(message))
        {
            this.log(level, format(message, value), undefined, asContext(context));
        }
        else if (args.length >= 2)
        {
            this.log(level, message, describeError(value), asContext(context));
        }
        else if (isCaught(value))
        {
            this.log(level, message, describeError(value));
        }
        else
        {
            this.log(level, message, undefined, asContext(value));
        }
    }

    /**
     * Debug log
     */
    debug(message: string, context?: Record<string, unknown>): void;
    debug(message: string, formatArg: string | number | boolean): void;
    debug(message: string, error: Error | unknown): void;
    debug(message: string, error: unknown, context: Record<string, unknown>): void;
    debug(message: string, ...args: unknown[]): void
    {
        this.logWithLevel('debug', message, args);
    }

    /**
     * Info log
     */
    info(message: string, context?: Record<string, unknown>): void;
    info(message: string, formatArg: string | number | boolean): void;
    info(message: string, error: Error | unknown): void;
    info(message: string, error: unknown, context: Record<string, unknown>): void;
    info(message: string, ...args: unknown[]): void
    {
        this.logWithLevel('info', message, args);
    }

    /**
     * Warn log
     */
    warn(message: string, context?: Record<string, unknown>): void;
    warn(message: string, formatArg: string | number | boolean): void;
    warn(message: string, error: Error | unknown): void;
    warn(message: string, error: unknown, context: Record<string, unknown>): void;
    warn(message: string, ...args: unknown[]): void
    {
        this.logWithLevel('warn', message, args);
    }

    /**
     * Error log
     */
    error(message: string, context?: Record<string, unknown>): void;
    error(message: string, formatArg: string | number | boolean): void;
    error(message: string, error: Error | unknown): void;
    error(message: string, error: unknown, context: Record<string, unknown>): void;
    error(message: string, ...args: unknown[]): void
    {
        this.logWithLevel('error', message, args);
    }

    /**
     * Fatal log
     */
    fatal(message: string, context?: Record<string, unknown>): void;
    fatal(message: string, formatArg: string | number | boolean): void;
    fatal(message: string, error: Error | unknown): void;
    fatal(message: string, error: unknown, context: Record<string, unknown>): void;
    fatal(message: string, ...args: unknown[]): void
    {
        this.logWithLevel('fatal', message, args);
    }

    /**
     * Log processing (internal)
     *
     * The error reaches a transport only as its description: a database
     * error's bound values, which sit in its message, stack and fields, never do.
     */
    private log(level: LogLevel, message: string, error?: LogMetadata['error'], context?: Record<string, unknown>): void
    {
        const metadata: LogMetadata = {
            timestamp: new Date(),
            level,
            message,
            module: this.module,
            error,
            // Mask sensitive information in context to prevent credential leaks
            context: context ? maskContext(context) : undefined,
        };

        // Pass to all enabled Transports
        this.processTransports(metadata);
    }

    /**
     * Process Transports
     */
    private processTransports(metadata: LogMetadata): void
    {
        const promises = this.config.transports
            .filter(transport => transport.enabled)
            .map(transport => this.safeTransportLog(transport, metadata));

        // Async processing to prevent Transport errors from blocking logs
        Promise.all(promises).catch(error =>
        {
            // Use stderr directly to avoid circular logging
            const errorMessage = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[Logger] Transport error: ${errorMessage}\n`);
        });
    }

    /**
     * Transport log (error-safe)
     */
    private async safeTransportLog(transport: Transport, metadata: LogMetadata): Promise<void>
    {
        try
        {
            await transport.log(metadata);
        }
        catch (error)
        {
            // Use stderr directly to avoid circular logging
            const errorMessage = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[Logger] Transport "${transport.name}" failed: ${errorMessage}\n`);
        }
    }

    /**
     * Close all Transports
     */
    async close(): Promise<void>
    {
        const closePromises = this.config.transports
            .filter(transport => transport.close)
            .map(transport => transport.close!());

        await Promise.all(closePromises);
    }
}
