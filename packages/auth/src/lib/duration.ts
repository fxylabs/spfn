/**
 * @spfn/auth - Duration strings
 *
 * One grammar for a session lifetime, read in two places: the env schema's
 * validator for `SPFN_AUTH_SESSION_TTL`, which refuses a malformed value when
 * the environment is validated, and `getSessionTtl`, which turns the value into
 * seconds. The module imports nothing, so the schema can use it without pulling
 * the server config (which reads the schema's env) in behind it.
 */

/**
 * Parse duration string to seconds
 *
 * Supports: '30d', '12h', '45m', '3600s', or plain number
 *
 * @example
 * parseDuration('30d')   // 2592000 (30 days in seconds)
 * parseDuration('12h')   // 43200
 * parseDuration('45m')   // 2700
 * parseDuration('3600')  // 3600
 */
export function parseDuration(duration: string | number): number
{
    if (typeof duration === 'number')
    {
        return duration;
    }

    const match = duration.match(/^(\d+)([dhms]?)$/);
    if (!match)
    {
        throw new Error(`Invalid duration format: ${duration}. Use format like '30d', '12h', '45m', '3600s', or plain number.`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || 's';

    switch (unit)
    {
        case 'd':
            return value * 24 * 60 * 60;
        case 'h':
            return value * 60 * 60;
        case 'm':
            return value * 60;
        case 's':
            return value;
        default:
            throw new Error(`Unknown duration unit: ${unit}`);
    }
}
