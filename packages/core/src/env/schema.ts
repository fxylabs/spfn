/**
 * Environment Variable Schema Definition System
 *
 * 환경변수에 메타데이터를 정의하여 중앙 관리, 문서화, 검증을 지원합니다.
 *
 * @example
 * ```typescript
 * const schema = defineEnvSchema({
 *   DATABASE_URL: envUrl({
 *     description: 'Database connection',
 *     required: true,
 *     validator: parsePostgresUrl,
 *     sensitive: true,
 *   })
 * });
 * ```
 *
 * @module env/schema
 */

import { parseBoolean, parseNumber, parseJson } from './validator';

/**
 * 환경변수 스키마 정의
 */
export interface EnvVarSchema<T = string>
{
    /** 환경변수 키 */
    key: string;

    /** 설명 (목적, 사용처) */
    description: string;

    /** 타입 */
    type: 'string' | 'number' | 'boolean' | 'url' | 'enum' | 'json';

    /** 필수 여부 */
    required?: boolean;

    /** 기본값 */
    default?: T;

    /** 검증/변환 함수 */
    validator?: (value: string) => T;

    // === 검증 옵션 ===

    /** Fallback 환경변수 키들 (backward compatibility) */
    fallbackKeys?: string[];

    /** 최소 길이 (문자열 타입) */
    minLength?: number;

    // === 메타데이터 ===

    /** 민감정보 여부 (로깅 시 마스킹) */
    sensitive?: boolean;

    /**
     * 자동 생성 방식 — 값이 미지정이면 프로비저닝(secrets 관리 CLI)이 이 방식으로 생성한다.
     * 외부에서 받아야 하는 시크릿(API 키 등)은 generate를 비워 사용자 입력으로 둔다.
     */
    generate?: 'hex32' | 'hex64' | 'uuid' | 'base64url32';

    /** 예시 값들 (타입과 일치해야 함) */
    examples?: T[];

    // === 파일 분리 ===

    /**
     * Next.js 프로세스에서 사용 여부
     *
     * - true: .env.local에 존재해야 함 (Next.js 서버 컴포넌트에서 접근 가능)
     * - false: .env.server에만 존재해야 함 (SPFN 서버에서만 접근)
     *
     * @default NEXT_PUBLIC_* 이면 true, 아니면 false
     */
    nextjs?: boolean;
}

/**
 * 스키마 컬렉션 타입
 */
export type EnvSchemaCollection = Record<string, EnvVarSchema<any>>;

/**
 * Helper type: Check if field has default value
 */
type HasDefault<T> = T extends { default: any } ? true : false;

/**
 * Helper type: Check if field is explicitly required
 */
type IsRequired<T> = T extends { required: true } ? true : false;

/**
 * Helper type: Check if field should be required (has default OR required: true)
 */
type ShouldBeRequired<T> = HasDefault<T> extends true ? true : IsRequired<T>;

/**
 * 스키마로부터 타입 추출
 *
 * required: true 또는 default가 있는 필드 → 필수
 * required: false 또는 미지정 → optional (| undefined)
 */
export type InferEnvType<T extends EnvSchemaCollection> = {
    // Required fields (required: true OR has default)
    [K in keyof T as ShouldBeRequired<T[K]> extends true ? K : never]:
    T[K] extends EnvVarSchema<infer U> ? U : string;
} & {
    // Optional fields (required: false OR not specified)
    [K in keyof T as ShouldBeRequired<T[K]> extends true ? never : K]?:
    T[K] extends EnvVarSchema<infer U> ? U | undefined : string | undefined;
};

/**
 * 스키마 정의 헬퍼 (타입 추론 지원)
 *
 * Automatically fills in the `key` property from object keys.
 *
 * @example
 * ```typescript
 * const schema = defineEnvSchema({
 *   DATABASE_URL: envString({ description: 'Database URL', required: true })
 * });
 * // Automatically adds key: 'DATABASE_URL'
 * ```
 */
export function defineEnvSchema<T extends Record<string, any>>(
    schema: T,
): { [K in keyof T]: T[K] & { key: K } }
{
    const result: any = {};

    for (const key in schema)
    {
        result[key] = {
            ...schema[key],
            key,
        };
    }

    return result;
}

/**
 * 문자열 스키마 헬퍼
 *
 * @example
 * ```typescript
 * const schema = {
 *   API_KEY: {
 *     ...envString({
 *       description: 'API authentication key',
 *       required: true,
 *       sensitive: true,
 *     }),
 *     key: 'API_KEY',
 *   }
 * };
 * ```
 */
export function envString<T extends Omit<EnvVarSchema, 'key' | 'type'>>(
    options: T,
): T & { type: 'string'; validator: (value: string) => string }
{
    return {
        ...options,
        type: 'string',
        validator: options.validator || ((value: string) => value),
    };
}

/**
 * 시크릿 스키마 헬퍼 — sensitive:true 자동.
 *
 * generate 지정 시 프로비저닝(secrets CLI)이 값을 자동 생성, 미지정이면 외부 입력(사용자가 붙여넣음).
 * 이로써 env.config.ts가 "설정(envString) vs 외부 시크릿(envSecret) vs 자동 시크릿(envSecret+generate)"을
 * 선언적으로 가른다 — CLI·프레임워크·프로비저닝이 한 원천을 읽는다.
 *
 * @example
 * ```typescript
 * SPFN_AUTH_SESSION_SECRET: envSecret({ description: '세션 서명 키', generate: 'base64url32' }),
 * OPENAI_API_KEY: envSecret({ description: 'OpenAI API 키' }),  // generate 없음 → 외부 입력
 * ```
 */
export function envSecret<T extends Omit<EnvVarSchema, 'key' | 'type' | 'sensitive'>>(
    options: T,
): T & { type: 'string'; sensitive: true; validator: (value: string) => string }
{
    return {
        ...options,
        type: 'string',
        sensitive: true,
        validator: options.validator || ((value: string) => value),
    };
}

/**
 * 숫자 스키마 헬퍼
 *
 * @example
 * ```typescript
 * const schema = {
 *   PORT: {
 *     ...envNumber({
 *       description: 'Server port',
 *       default: 3000,
 *       validator: createNumberParser({ min: 1, max: 65535 }),
 *     }),
 *     key: 'PORT',
 *   }
 * };
 * ```
 */
export function envNumber<T extends Omit<EnvVarSchema<number>, 'key' | 'type'>>(
    options: T,
): T & { type: 'number'; validator: (value: string) => number }
{
    return {
        ...options,
        type: 'number',
        validator: options.validator || parseNumber,
    };
}

/**
 * Boolean 스키마 헬퍼
 *
 * @example
 * ```typescript
 * const schema = {
 *   DEBUG: {
 *     ...envBoolean({
 *       description: 'Enable debug mode',
 *       default: false,
 *     }),
 *     key: 'DEBUG',
 *   }
 * };
 * ```
 */
export function envBoolean<T extends Omit<EnvVarSchema<boolean>, 'key' | 'type'>>(
    options: T,
): T & { type: 'boolean'; validator: (value: string) => boolean }
{
    return {
        ...options,
        type: 'boolean',
        validator: options.validator || parseBoolean,
    };
}

/**
 * URL 스키마 헬퍼
 *
 * @example
 * ```typescript
 * const schema = {
 *   DATABASE_URL: {
 *     ...envUrl({
 *       description: 'Database connection URL',
 *       required: true,
 *       validator: parsePostgresUrl,
 *     }),
 *     key: 'DATABASE_URL',
 *   }
 * };
 * ```
 */
export function envUrl<T extends Omit<EnvVarSchema, 'key' | 'type'>>(
    options: T,
): T & { type: 'url' }
{
    return {
        ...options,
        type: 'url',
    };
}

/**
 * Enum 스키마 헬퍼
 *
 * @example
 * ```typescript
 * const schema = {
 *   LOG_LEVEL: {
 *     ...envEnum(['debug', 'info', 'warn', 'error'] as const, {
 *       description: 'Logging level',
 *       default: 'info',
 *     }),
 *     key: 'LOG_LEVEL',
 *   }
 * };
 * ```
 */
export function envEnum<
    T extends string,
    O extends Omit<EnvVarSchema<T>, 'key' | 'type' | 'validator'>,
>(
    allowed: readonly T[],
    options: O,
): O & { type: 'enum'; validator: (val: string) => T }
{
    return {
        ...options,
        type: 'enum',
        validator: (val: string): T =>
        {
            if (!allowed.includes(val as T))
            {
                throw new Error(`Must be one of: ${allowed.join(', ')}`);
            }

            return val as T;
        },
    };
}

/**
 * JSON 스키마 헬퍼
 *
 * @example
 * ```typescript
 * const schema = {
 *   CONFIG_JSON: {
 *     ...envJson<{ host: string; port: number }>({
 *       description: 'JSON configuration object',
 *       required: true,
 *     }),
 *     key: 'CONFIG_JSON',
 *   }
 * };
 * ```
 */
export function envJson<
    T = any,
    O extends Omit<EnvVarSchema<T>, 'key' | 'type' | 'validator'> = Omit<EnvVarSchema<T>, 'key' | 'type' | 'validator'>,
>(
    options: O,
): O & { type: 'json'; validator: (val: string) => T }
{
    return {
        ...options,
        type: 'json',
        validator: (val: string) => parseJson<T>(val),
    };
}

/**
 * 환경변수가 클라이언트에서 접근 가능한지 확인
 * (NEXT_PUBLIC_ 접두사로 판단)
 *
 * @param key - 환경변수 키
 * @returns 클라이언트에서 접근 가능하면 true
 *
 * @example
 * ```typescript
 * isClientAccessible('NEXT_PUBLIC_API_URL');  // true
 * isClientAccessible('DATABASE_URL');         // false
 * ```
 */
export function isClientAccessible(key: string): boolean
{
    return key.startsWith('NEXT_PUBLIC_');
}

/**
 * 환경변수가 서버 전용인지 확인
 * (NEXT_PUBLIC_ 접두사가 없으면 서버 전용)
 *
 * @param key - 환경변수 키
 * @returns 서버 전용이면 true
 *
 * @example
 * ```typescript
 * isServerOnly('DATABASE_URL');              // true
 * isServerOnly('NEXT_PUBLIC_API_URL');       // false
 * ```
 */
export function isServerOnly(key: string): boolean
{
    return !isClientAccessible(key);
}

/**
 * 스키마의 nextjs 옵션 값 결정
 *
 * 명시적으로 지정되지 않은 경우:
 * - NEXT_PUBLIC_* → true
 * - 그 외 → false
 *
 * @param schema - 환경변수 스키마
 * @returns Next.js 프로세스에서 사용 가능 여부
 */
export function isNextjsAccessible(schema: EnvVarSchema): boolean
{
    if (schema.nextjs !== undefined)
    {
        return schema.nextjs;
    }

    return isClientAccessible(schema.key);
}

/**
 * 스키마가 SPFN 서버 전용인지 확인
 *
 * @param schema - 환경변수 스키마
 * @returns SPFN 서버에서만 사용되면 true
 */
export function isSpfnServerOnly(schema: EnvVarSchema): boolean
{
    return !isNextjsAccessible(schema);
}
