/**
 * Server Configuration Validation
 *
 * Validates server configuration to catch errors early with clear messages.
 */

import { parseRedactPaths, parseTrustedProxyHops } from '@spfn/core/middleware';
import type { ServerConfig } from './types';

/**
 * Validate server configuration
 * Throws descriptive errors for invalid configurations
 */
export function validateServerConfig(config: ServerConfig): void
{
    // Port validation
    if (config.port !== undefined)
    {
        if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
        {
            throw new Error(
                `Invalid port: ${config.port}. Port must be an integer between 0 and 65535.`,
            );
        }
    }

    // Timeout validation
    if (config.timeout)
    {
        const { request, keepAlive, headers } = config.timeout;

        if (request !== undefined && (request < 0 || !Number.isFinite(request)))
        {
            throw new Error(`Invalid timeout.request: ${request}. Must be a positive number.`);
        }

        if (keepAlive !== undefined && (keepAlive < 0 || !Number.isFinite(keepAlive)))
        {
            throw new Error(`Invalid timeout.keepAlive: ${keepAlive}. Must be a positive number.`);
        }

        if (headers !== undefined && (headers < 0 || !Number.isFinite(headers)))
        {
            throw new Error(`Invalid timeout.headers: ${headers}. Must be a positive number.`);
        }

        // Logical validation
        if (headers && request && headers > request)
        {
            throw new Error(
                `Invalid timeout configuration: headers timeout (${headers}ms) cannot exceed request timeout (${request}ms).`,
            );
        }
    }

    // Shutdown timeout validation
    if (config.shutdown?.timeout !== undefined)
    {
        const timeout = config.shutdown.timeout;
        if (timeout < 0 || !Number.isFinite(timeout))
        {
            throw new Error(`Invalid shutdown.timeout: ${timeout}. Must be a positive number.`);
        }
    }

    if (config.trustedProxyHops !== undefined)
    {
        parseTrustedProxyHops(config.trustedProxyHops);
    }

    if (config.logging?.redactPaths !== undefined)
    {
        parseRedactPaths(config.logging.redactPaths);
    }

    // Health check path validation
    if (config.healthCheck?.path)
    {
        if (!config.healthCheck.path.startsWith('/'))
        {
            throw new Error(
                `Invalid healthCheck.path: "${config.healthCheck.path}". Must start with "/".`,
            );
        }
    }
}
