/**
 * Logger Formatters
 *
 * Log formatting utilities for console and JSON outputs with sensitive data masking.
 */

import type { LogLevel, LogMetadata } from './types';
import { describeError, isArray, isError } from './error-description';
import type { DatabaseErrorDescription, ErrorDescription } from './error-description';

/**
 * 민감 정보로 간주되는 키 목록
 * 이 키들을 포함하는 필드는 자동으로 마스킹됨
 */
const SENSITIVE_KEYS = [
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'apikey',
    'api_key',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'authorization',
    'auth',
    'cookie',
    'session',
    'sessionid',
    'session_id',
    'privatekey',
    'private_key',
    'creditcard',
    'credit_card',
    'cardnumber',
    'card_number',
    'cvv',
    'ssn',
    'pin',
];

/**
 * 마스킹된 값
 */
const MASKED_VALUE = '***MASKED***';

/**
 * A context value whose read threw
 */
const UNREADABLE_VALUE = '[Unreadable]';

/**
 * 키가 민감 정보를 포함하는지 확인
 */
function isSensitiveKey(key: string): boolean
{
    const lowerKey = key.toLowerCase();

    return SENSITIVE_KEYS.some(sensitive => lowerKey.includes(sensitive));
}

/**
 * An object's own enumerable entries, each read on its own: a getter that
 * throws stands in as `[Unreadable]`, and an object whose keys cannot be
 * listed (a revoked Proxy) has none. Masking never throws into a log call.
 */
function entriesOf(data: object): [string, unknown][]
{
    let keys: string[];

    try
    {
        keys = Object.keys(data);
    }
    catch
    {
        return [];
    }

    return keys.map(key => [key, readEntry(data, key)]);
}

function readEntry(data: object, key: string): unknown
{
    try
    {
        return (data as Record<string, unknown>)[key];
    }
    catch
    {
        return UNREADABLE_VALUE;
    }
}

/**
 * 민감 정보 마스킹
 * Context 객체에서 민감한 정보(비밀번호, 토큰 등)를 마스킹
 * Circular reference를 안전하게 처리
 *
 * @param data - 원본 데이터
 * @param seen - 순환 참조 감지용 WeakSet (내부 사용)
 * @returns 마스킹된 데이터
 */
export function maskSensitiveData(data: unknown, seen = new WeakSet<object>()): unknown
{
    // null, undefined 처리
    if (data === null || data === undefined)
    {
        return data;
    }

    // 기본 타입은 그대로 반환
    if (typeof data !== 'object')
    {
        return data;
    }

    // Circular reference 감지
    if (seen.has(data as object))
    {
        return '[Circular]';
    }
    seen.add(data as object);

    // An error is described, not walked: its enumerable fields (drizzle's
    // `params`, the driver's `detail`) hold the values a log must not carry
    if (isError(data))
    {
        return describeError(data);
    }

    // 배열 처리
    if (isArray(data))
    {
        return entriesOf(data).map(([, item]) => maskSensitiveData(item, seen));
    }

    // 객체 처리
    const masked: Record<string, unknown> = {};

    for (const [key, value] of entriesOf(data))
    {
        if (isSensitiveKey(key))
        {
            // 민감 정보 키는 마스킹
            masked[key] = MASKED_VALUE;
        }
        else if (typeof value === 'object' && value !== null)
        {
            // 중첩된 객체는 재귀 처리 (seen 전달)
            masked[key] = maskSensitiveData(value, seen);
        }
        else
        {
            // 일반 값은 그대로 유지
            masked[key] = value;
        }
    }

    return masked;
}

/**
 * ANSI 컬러 코드
 */
const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',

    // 로그 레벨 컬러
    debug: '\x1b[36m',    // cyan
    info: '\x1b[32m',     // green
    warn: '\x1b[33m',     // yellow
    error: '\x1b[31m',    // red
    fatal: '\x1b[35m',    // magenta

    // 추가 컬러
    gray: '\x1b[90m',
};

/**
 * 로그 레벨을 컬러 문자열로 변환
 */
export function colorizeLevel(level: LogLevel): string
{
    const color = COLORS[level];
    const levelStr = level.toUpperCase().padEnd(5);

    return `${color}${levelStr}${COLORS.reset}`;
}

/**
 * 타임스탬프 포맷 (ISO 8601)
 */
export function formatTimestamp(date: Date): string
{
    return date.toISOString();
}

/**
 * 타임스탬프 포맷 (사람이 읽기 쉬운 형식)
 */
export function formatTimestampHuman(date: Date): string
{
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * An error description as text: its header, the database fields, the stack
 * frames and the cause chain
 */
export function formatError(error: ErrorDescription | DatabaseErrorDescription): string
{
    const lines = error.kind === 'database'
        ? formatDatabaseError(error)
        : [`${error.name}: ${error.message}`];

    if (error.stack)
    {
        lines.push(error.stack);
    }

    if (error.kind === 'error' && error.cause)
    {
        lines.push(`Caused by: ${formatError(error.cause)}`);
    }

    return lines.join('\n');
}

function formatDatabaseError(error: DatabaseErrorDescription): string[]
{
    const fields = (['code', 'severity', 'constraint', 'schema', 'table', 'column', 'dataType', 'routine'] as const)
        .filter(key => error[key] !== undefined)
        .map(key => `[${key}=${error[key]}]`);
    const lines = [`${error.name}: ${error.message ?? 'database error'}`];

    if (fields.length > 0)
    {
        lines.push(`    ${fields.join(' ')}`);
    }

    if (error.sql !== undefined)
    {
        lines.push(`    sql: ${error.sql} (${error.paramCount ?? 0} params)`);
    }

    return lines;
}

/**
 * Context 객체를 문자열로 변환
 */
export function formatContext(context: Record<string, unknown>): string
{
    try
    {
        return JSON.stringify(context, null, 2);
    }
    catch (error)
    {
        return '[Context serialization failed]';
    }
}

/**
 * 콘솔용 컬러 포맷
 */
export function formatConsole(metadata: LogMetadata, colorize = true): string
{
    const parts: string[] = [];

    // [타임스탬프]
    const timestamp = formatTimestampHuman(metadata.timestamp);
    if (colorize)
    {
        parts.push(`${COLORS.gray}[${timestamp}]${COLORS.reset}`);
    }
    else
    {
        parts.push(`[${timestamp}]`);
    }

    // [pid=12345]
    const pid = process.pid;
    if (colorize)
    {
        parts.push(`${COLORS.dim}[pid=${pid}]${COLORS.reset}`);
    }
    else
    {
        parts.push(`[pid=${pid}]`);
    }

    // [module=value]
    if (metadata.module)
    {
        if (colorize)
        {
            parts.push(`${COLORS.dim}[module=${metadata.module}]${COLORS.reset}`);
        }
        else
        {
            parts.push(`[module=${metadata.module}]`);
        }
    }

    // Context를 각각 [key=value] 형태로 추가
    if (metadata.context && Object.keys(metadata.context).length > 0)
    {
        Object.entries(metadata.context).forEach(([key, value]) =>
        {
            let valueStr: string;
            if (typeof value === 'string')
            {
                valueStr = value;
            }
            else if (typeof value === 'object' && value !== null)
            {
                try
                {
                    valueStr = JSON.stringify(value);
                }
                catch (error)
                {
                    valueStr = '[circular]';
                }
            }
            else
            {
                valueStr = String(value);
            }

            if (colorize)
            {
                parts.push(`${COLORS.dim}[${key}=${valueStr}]${COLORS.reset}`);
            }
            else
            {
                parts.push(`[${key}=${valueStr}]`);
            }
        });
    }

    // (LEVEL):
    const levelStr = metadata.level.toUpperCase();
    if (colorize)
    {
        const color = COLORS[metadata.level];
        parts.push(`${color}(${levelStr})${COLORS.reset}:`);
    }
    else
    {
        parts.push(`(${levelStr}):`);
    }

    // 메시지
    if (colorize)
    {
        parts.push(`${COLORS.bright}${metadata.message}${COLORS.reset}`);
    }
    else
    {
        parts.push(metadata.message);
    }

    let output = parts.join(' ');

    // 에러는 별도 줄로 추가
    if (metadata.error)
    {
        output += '\n' + formatError(metadata.error);
    }

    return output;
}

/**
 * JSON 포맷 (파일 저장 및 전송용)
 */
export function formatJSON(metadata: LogMetadata): string
{
    const obj: Record<string, unknown> = {
        timestamp: formatTimestamp(metadata.timestamp),
        level: metadata.level,
        message: metadata.message,
    };

    if (metadata.module)
    {
        obj.module = metadata.module;
    }

    if (metadata.context)
    {
        obj.context = metadata.context;
    }

    if (metadata.error)
    {
        obj.error = metadata.error;
    }

    return JSON.stringify(obj);
}

/**
 * Drizzle ORM 에러에서 쿼리 정보 추출
 *
 * Drizzle ORM은 에러 메시지에 다음 형식으로 정보를 포함:
 * - "Failed query: <QUERY>\nparams: <PARAMS>"
 * - "Query: <QUERY>"
 *
 * Only the query line is read: the `params:` line holds the bound values,
 * which a log never carries.
 *
 * @param error - Error 객체
 * @returns 쿼리 정보 (query, table)
 */
export function extractQueryInfo(error: Error): {
    query?: string;
    table?: string;
} | null
{
    const message = error.message;

    if (!message) return null;

    // Extract query from "Failed query: ..." or "Query: ..."
    const queryMatch = message.match(/(?:Failed query:|Query:)\s*([^\n]+)/);
    if (!queryMatch) return null;

    const query = queryMatch[1].trim();

    // Extract table name from query (e.g., UPDATE "table_name" or INSERT INTO "table_name")
    const tableMatch = query.match(/(?:UPDATE|INSERT INTO|DELETE FROM|FROM)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\."?([a-zA-Z_][a-zA-Z0-9_]*)"?|(?:UPDATE|INSERT INTO|DELETE FROM|FROM)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i);

    // Schema.Table or just Table
    const table = tableMatch ? tableMatch[2] || tableMatch[3] || tableMatch[1] : undefined;

    return table === undefined ? { query } : { query, table };
}

/**
 * Promise rejection의 호출 스택에서 실제 발생 위치 추출
 *
 * 스택 트레이스에서 다음 정보를 추출:
 * - 실제 에러 발생 파일 경로
 * - 라인 번호
 * - 함수명/메서드명
 * - Repository 정보 (있는 경우)
 *
 * @param error - Error 객체
 * @returns Promise context 정보
 */
export function extractPromiseContext(error: Error): Record<string, unknown>
{
    const context: Record<string, unknown> = {};

    if (!error.stack) return context;

    const stackLines = error.stack.split('\n');

    // Frames only — the header (the message, which for a drizzle error runs
    // over two lines and ends in its params) is skipped
    // Ignore node_modules and internal Node.js paths
    for (let i = 1; i < stackLines.length; i++)
    {
        const line = stackLines[i].trim();

        if (!line.startsWith('at ')) continue;

        // Skip node_modules and node internals
        if (line.includes('node_modules') || line.includes('node:internal')) continue;

        // Extract file, line number, and function name
        // Format: "at ClassName.methodName (file.ts:line:col)"
        // or: "at functionName (file.ts:line:col)"
        // or: "at file.ts:line:col"

        const match = line.match(/at\s+(?:([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\s+)?\(?([^)]+):(\d+):(\d+)\)?/);

        if (match)
        {
            const [, functionName, filePath, lineNumber, columnNumber] = match;

            // Extract just the filename from the full path
            const fileNameMatch = filePath.match(/([^/\\]+)$/);
            const fileName = fileNameMatch ? fileNameMatch[1] : filePath;

            context.file = fileName;
            context.line = parseInt(lineNumber, 10);
            context.column = parseInt(columnNumber, 10);

            if (functionName)
            {
                // Check if it's a class method (e.g., "ClassName.methodName")
                const methodMatch = functionName.match(/^(.+)\.([^.]+)$/);
                if (methodMatch)
                {
                    const [, className, methodName] = methodMatch;

                    context.class = className;
                    context.method = methodName;

                    // Check if it's a Repository
                    if (className.includes('Repository'))
                    {
                        context.repository = className;
                    }
                }
                else
                {
                    context.function = functionName;
                }
            }

            // Found first relevant frame, stop here
            break;
        }
    }

    return context;
}

/**
 * Unhandled rejection 에러를 상세하게 포맷팅
 *
 * Promise context와 DB 쿼리 정보를 자동으로 추출하여
 * 에러 발생 위치와 원인을 명확하게 파악할 수 있도록 함
 *
 * @param reason - Rejection 원인 (Error 또는 기타)
 * @param promise - Promise 객체
 * @returns 상세 context 정보
 */
export function formatUnhandledRejection(reason: unknown, promise: Promise<unknown>): {
    error: Error;
    context: Record<string, unknown>;
}
{
    // Convert reason to Error if not already
    let error: Error;
    if (reason instanceof Error)
    {
        error = reason;
    }
    else if (typeof reason === 'string')
    {
        error = new Error(reason);
    }
    else
    {
        error = new Error(JSON.stringify(reason));
    }

    const context: Record<string, unknown> = {
        promise: String(promise),
    };

    // Extract promise context (file, line, function, etc.)
    const promiseContext = extractPromiseContext(error);
    if (Object.keys(promiseContext).length > 0)
    {
        context.promiseContext = promiseContext;
    }

    // Extract DB query info if available
    const queryInfo = extractQueryInfo(error);
    if (queryInfo)
    {
        context.queryInfo = queryInfo;
    }

    return { error, context };
}
