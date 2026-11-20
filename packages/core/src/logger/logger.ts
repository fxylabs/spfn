/**
 * Logger Class
 *
 * Central logging class with multiple transports, child loggers, and sensitive data masking.
 */

import { format } from 'node:util';
import type { LogLevel, LogMetadata, LoggerConfig, Transport } from './types';
import { LOG_LEVEL_PRIORITY } from './types';
import { maskSensitiveData } from './formatters';
import { describeError, isError } from './error-description';

const FORMAT_PATTERN = /%[sdifjoOc%]/;

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
     * Whether the only argument after the message is the caught value rather
     * than the context: an Error, or anything that is not an object
     */
    private isCaught(value: unknown): boolean
    {
        return value !== undefined && (isError(value) || typeof value !== 'object' || value === null);
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
     * Common log method with error/context detection
     */
    private logWithLevel(
        level: LogLevel,
        message: string,
        errorOrContext?: Error | unknown | Record<string, unknown>,
        context?: Record<string, unknown>,
    ): void
    {
        // printf-style format string: logger.info('url: %s', value)
        if (errorOrContext !== undefined && FORMAT_PATTERN.test(message))
        {
            this.log(level, format(message, errorOrContext), undefined, context);

            return;
        }

        if (this.isCaught(errorOrContext))
        {
            this.log(level, message, errorOrContext, context);
        }
        else
        {
            this.log(level, message, undefined, errorOrContext as Record<string, unknown>);
        }
    }

    /**
     * Debug log
     */
    debug(message: string, context?: Record<string, unknown>): void;
    debug(message: string, formatArg: string | number | boolean): void;
    debug(message: string, error: Error | unknown, context?: Record<string, unknown>): void;
    debug(message: string, errorOrContext?: unknown, context?: Record<string, unknown>): void
    {
        this.logWithLevel('debug', message, errorOrContext, context);
    }

    /**
     * Info log
     */
    info(message: string, context?: Record<string, unknown>): void;
    info(message: string, formatArg: string | number | boolean): void;
    info(message: string, error: Error | unknown, context?: Record<string, unknown>): void;
    info(message: string, errorOrContext?: unknown, context?: Record<string, unknown>): void
    {
        this.logWithLevel('info', message, errorOrContext, context);
    }

    /**
     * Warn log
     */
    warn(message: string, context?: Record<string, unknown>): void;
    warn(message: string, formatArg: string | number | boolean): void;
    warn(message: string, error: Error | unknown, context?: Record<string, unknown>): void;
    warn(message: string, errorOrContext?: unknown, context?: Record<string, unknown>): void
    {
        this.logWithLevel('warn', message, errorOrContext, context);
    }

    /**
     * Error log
     */
    error(message: string, context?: Record<string, unknown>): void;
    error(message: string, formatArg: string | number | boolean): void;
    error(message: string, error: Error | unknown, context?: Record<string, unknown>): void;
    error(message: string, errorOrContext?: unknown, context?: Record<string, unknown>): void
    {
        this.logWithLevel('error', message, errorOrContext, context);
    }

    /**
     * Fatal log
     */
    fatal(message: string, context?: Record<string, unknown>): void;
    fatal(message: string, formatArg: string | number | boolean): void;
    fatal(message: string, error: Error | unknown, context?: Record<string, unknown>): void;
    fatal(message: string, errorOrContext?: unknown, context?: Record<string, unknown>): void
    {
        this.logWithLevel('fatal', message, errorOrContext, context);
    }

    /**
     * Log processing (internal)
     *
     * The error reaches a transport only as its description: a database
     * error's bound values, which sit in its message, stack and fields, never do.
     */
    private log(level: LogLevel, message: string, error?: unknown, context?: Record<string, unknown>): void
    {
        // Early return if log level is below configured level
        // This prevents unnecessary metadata creation and processing
        if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.level])
        {
            return;
        }

        const metadata: LogMetadata = {
            timestamp: new Date(),
            level,
            message,
            module: this.module,
            error: error === undefined ? undefined : describeError(error),
            // Mask sensitive information in context to prevent credential leaks
            context: context ? maskSensitiveData(context) as Record<string, unknown> : undefined,
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
