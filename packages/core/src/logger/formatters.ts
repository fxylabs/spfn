/**
 * Logger Formatters
 *
 * Log formatting utilities for console and JSON outputs with sensitive data masking.
 */

import type { LogLevel, LogMetadata } from './types';
import { describeError, isArray, isDescription, isError } from './error-description';
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
 * The keys a caught value conventionally sits under, at any depth of a
 * context. A value there is described whatever its shape: a thrown
 * `{ code, params }` is not an Error, and walking it would print its params.
 */
const ERROR_KEYS: ReadonlySet<string> = new Set(['error', 'err', 'cause', 'reason']);

/**
 * The key a list of caught values conventionally sits under — an array, or
 * an `AggregateError`'s `errors`. Each element of an array or a Set there is
 * described; any other value there is walked.
 */
const ERRORS_KEY = 'errors';

/**
 * Marks a value `alreadySentToClient` vouches for. `Symbol.for`: a second
 * copy of this module reads the same mark.
 */
const SENT_TO_CLIENT = Symbol.for('@spfn/core:logger.alreadySentToClient');

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
 * Mark a value as a body already sent to a client, before it goes into a log
 * context
 *
 * Under the mark, keys are still masked by their sensitive names, and an
 * Error instance is still described; a value under `error`, `err`, `cause`,
 * `reason` or `errors` is not: there it is the body's own data — the error
 * envelope a client received — not a caught value. A body that came out of
 * `JSON.parse` holds no Error, and whatever it carries the client already has.
 *
 * Core's request logger applies it to its copy of a 4xx/5xx response body,
 * which the error handler built from a description. An app may apply it only
 * to a value that was itself sent, as it is, to the client — never to a
 * caught value or to an object holding one.
 *
 * Returns the value; a primitive or a non-extensible object is returned
 * unmarked, and so is masked as any other context value.
 *
 * @example
 * ```typescript
 * logger.warn('Upstream refused', { response: alreadySentToClient(await res.clone().json()) });
 * ```
 */
export function alreadySentToClient<T>(body: T): T
{
    if (typeof body === 'object' && body !== null && Object.isExtensible(body))
    {
        Object.defineProperty(body, SENT_TO_CLIENT, { value: true });
    }

    return body;
}

function isSentToClient(data: object): boolean
{
    try
    {
        return (data as Record<symbol, unknown>)[SENT_TO_CLIENT] === true;
    }
    catch
    {
        // A revoked Proxy
        return false;
    }
}

/**
 * A log line's context, masked by `maskSensitiveData`; a context that is
 * itself an Error is its description under `error`
 */
export function maskContext(context: Record<string, unknown>): Record<string, unknown>
{
    if (isError(context))
    {
        return { error: describeError(context) };
    }

    return maskSensitiveData(context) as Record<string, unknown>;
}

/**
 * How a walk treats the keys it meets
 */
interface Walk
{
    seen: WeakSet<object>;
    /** False under a value marked `alreadySentToClient` */
    describesErrorKeys: boolean;
}

/**
 * 민감 정보 마스킹
 * Context 객체에서 민감한 정보(비밀번호, 토큰 등)를 마스킹
 * Circular reference를 안전하게 처리
 *
 * At every depth: an Error is described, a value under `ERROR_KEYS` is
 * described whatever its shape, each element of a list under `errors` is
 * described. A Map logs as its `[key, value]` pairs, a string key ruling its
 * value as an object key does; a Set as its values.
 *
 * @param data - 원본 데이터
 * @param seen - 순환 참조 감지용 WeakSet (내부 사용)
 * @returns 마스킹된 데이터
 */
export function maskSensitiveData(data: unknown, seen = new WeakSet<object>()): unknown
{
    return walkValue(data, { seen, describesErrorKeys: true });
}

function walkValue(data: unknown, walk: Walk): unknown
{
    // 기본 타입은 그대로 반환
    if (typeof data !== 'object' || data === null)
    {
        return data;
    }

    // Circular reference 감지
    if (walk.seen.has(data))
    {
        return '[Circular]';
    }
    walk.seen.add(data);

    // An error is described, not walked: its enumerable fields (drizzle's
    // `params`, the driver's `detail`) hold the values a log must not carry
    if (isError(data))
    {
        return describeError(data);
    }

    return walkObject(data, isSentToClient(data) ? { ...walk, describesErrorKeys: false } : walk);
}

function walkObject(data: object, walk: Walk): unknown
{
    if (isArray(data))
    {
        return entriesOf(data).map(([, item]) => walkValue(item, walk));
    }

    if (isInstance(data, Set))
    {
        return membersOf(data).map(item => walkValue(item, walk));
    }

    if (isInstance(data, Map))
    {
        return (membersOf(data) as [unknown, unknown][]).map(([key, value]) =>
            [walkValue(key, walk), typeof key === 'string' ? maskEntry(key, value, walk) : walkValue(value, walk)]);
    }

    return Object.fromEntries(entriesOf(data).map(([key, value]) => [key, maskEntry(key, value, walk)]));
}

/**
 * `instanceof`, false for a Proxy whose prototype trap throws
 */
function isInstance<T>(value: unknown, type: new (...args: never[]) => T): value is T
{
    try
    {
        return value instanceof type;
    }
    catch
    {
        return false;
    }
}

/**
 * A Set's values or a Map's entries, none if iterating throws (a Proxy)
 */
function membersOf(collection: Set<unknown> | Map<unknown, unknown>): unknown[]
{
    try
    {
        return [...collection];
    }
    catch
    {
        return [];
    }
}

function itemsOf(list: unknown[] | Set<unknown>): unknown[]
{
    return isArray(list) ? entriesOf(list).map(([, item]) => item) : membersOf(list);
}

/**
 * One entry of an object: masked if its key is sensitive, described if its
 * key names a caught value, otherwise walked
 */
function maskEntry(key: string, value: unknown, walk: Walk): unknown
{
    if (isSensitiveKey(key))
    {
        return MASKED_VALUE;
    }

    if (walk.describesErrorKeys && ERROR_KEYS.has(key) && value !== undefined)
    {
        return describeError(value);
    }

    if (walk.describesErrorKeys && key === ERRORS_KEY && (isArray(value) || isInstance(value, Set)))
    {
        return itemsOf(value).map(item => describeError(item));
    }

    return walkValue(value, walk);
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
        : [error.message === undefined ? error.name : `${error.name}: ${error.message}`];

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

    // A described error in the context is printed after the message, like the
    // line's own error, not as one escaped line of JSON
    const described = Object.entries(metadata.context ?? {}).filter(([, value]) => isDescription(value));

    // Context를 각각 [key=value] 형태로 추가
    if (metadata.context && Object.keys(metadata.context).length > 0)
    {
        Object.entries(metadata.context).forEach(([key, value]) =>
        {
            if (isDescription(value))
            {
                return;
            }

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

    for (const [key, description] of described)
    {
        output += `\n${key}: ${formatError(description as ErrorDescription | DatabaseErrorDescription)}`;
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
