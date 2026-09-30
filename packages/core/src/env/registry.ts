/**
 * Environment Variable Registry
 *
 * 환경변수 스키마를 등록하고 타입 안전하게 접근할 수 있는 레지스트리
 *
 * @example
 * ```typescript
 * const schema = defineEnvSchema({
 *   DATABASE_URL: envString({ description: 'Database URL', required: true })
 * });
 *
 * const registry = createEnvRegistry(schema);
 * const env = registry.validate(); // 검증 + env 반환
 * console.log(env.DATABASE_URL);
 * ```
 *
 * @module env/registry
 */
import type { EnvVarSchema, EnvSchemaCollection, InferEnvType } from './schema';
import { isClientAccessible } from './schema';
import { logger } from '@spfn/core/logger';

const envLogger = logger.child('@spfn/core:env-registry');

/**
 * 환경변수 레지스트리
 *
 * 스키마 기반 환경변수 관리 및 검증
 */
export class EnvRegistry<T extends EnvSchemaCollection = EnvSchemaCollection>
{
    private schemas = new Map<string, EnvVarSchema>();
    private hasValidated = false;

    constructor(schemas?: T)
    {
        if (schemas)
        {
            this.registerMultiple(schemas);
        }
    }

    /**
     * 스키마 등록
     */
    register(schema: EnvVarSchema): void
    {
        this.schemas.set(schema.key, schema);
    }

    /**
     * 여러 스키마 등록
     */
    registerMultiple(schemas: EnvSchemaCollection): void
    {
        for (const [key, schema] of Object.entries(schemas))
        {
            this.register({ ...schema, key });
        }
    }

    /**
     * 검증 상태 리셋 (테스트용)
     */
    reset(): void
    {
        this.hasValidated = false;
    }

    /**
     * 환경변수 원시값 가져오기 (fallback 지원)
     */
    private getRawValue(key: string, fallbackKeys?: string[]): string | undefined
    {
        let value = process.env[key];

        if (!value && fallbackKeys)
        {
            for (const fallbackKey of fallbackKeys)
            {
                value = process.env[fallbackKey];
                if (value)
                {
                    break;
                }
            }
        }

        return value;
    }

    /**
     * 값에 validator 적용
     */
    private applyValidator<U>(
        value: string,
        schema: EnvVarSchema<U>,
    ): U
    {
        if (schema.validator)
        {
            return schema.validator(value) as U;
        }

        return value as U;
    }

    /**
     * 스키마 검증 수행 (값 읽기 없이)
     *
     * @internal
     */
    private validateSchemas(): void
    {
        // Skip if already validated
        if (this.hasValidated)
        {
            return;
        }

        const warnings: string[] = [];

        // 클라이언트 변수 중 민감정보 경고
        for (const [key, schema] of this.schemas)
        {
            if (isClientAccessible(key) && schema.sensitive)
            {
                warnings.push(
                    `${key} is marked as sensitive but accessible from client (NEXT_PUBLIC_*). Remove NEXT_PUBLIC_ prefix or unmark as sensitive.`,
                );
            }
        }

        // Log warnings
        if (warnings.length > 0)
        {
            envLogger.warn('Environment validation warnings:');
            warnings.forEach(w => envLogger.warn(`  - ${w}`));
        }

        this.hasValidated = true;
    }

    /**
     * SKIP_ENV_VALIDATION 환경변수 확인
     */
    private shouldSkipValidation(): boolean
    {
        const skip = process.env.SKIP_ENV_VALIDATION;

        return skip === 'true' || skip === '1';
    }

    /**
     * 실제 접근 시점에 환경변수 값 가져오기 및 검증
     *
     * @internal
     */
    private getAndValidate(key: string): any
    {
        const schema = this.schemas.get(key);
        if (!schema)
        {
            return undefined;
        }

        // Get raw value using common helper
        const value = this.getRawValue(key, schema.fallbackKeys);

        // Check if required (skip if SKIP_ENV_VALIDATION is set)
        if (schema.required && !value && !this.shouldSkipValidation())
        {
            const fallbackHint = schema.fallbackKeys
                ? ` (or ${schema.fallbackKeys.join(', ')})`
                : '';

            const errorMsg = `${key}${fallbackHint} is required but not set. ${schema.description || ''}`;
            envLogger.error(`Environment validation failed:\n  - ${errorMsg}`);
            throw new Error('Environment validation failed');
        }

        // If no value and not required, use default
        if (!value)
        {
            return schema.default;
        }

        // Check minLength
        if (schema.minLength !== undefined && value.length < schema.minLength)
        {
            const errorMsg = `${key} must be at least ${schema.minLength} characters long (current: ${value.length})`;
            envLogger.error(`Environment validation failed:\n  - ${errorMsg}`);
            throw new Error('Environment validation failed');
        }

        // Apply validator
        try
        {
            return this.applyValidator(value, schema);
        }
        catch (error)
        {
            // For sensitive keys, never log the validator's message — it may have
            // interpolated the secret value (e.g. a DB/Redis URL with credentials).
            const detail = schema.sensitive
                ? '(value hidden — sensitive key)'
                : (error instanceof Error ? error.message : String(error));
            const errorMsg = `${key} validation failed: ${detail}`;
            envLogger.error(`Environment validation failed:\n  - ${errorMsg}`);
            throw new Error('Environment validation failed');
        }
    }

    /**
     * 모든 환경변수를 명시적으로 검증 (SKIP_ENV_VALIDATION 무시)
     *
     * CLI에서 사용하기 위한 메서드로, 모든 required 환경변수를 강제 검증합니다.
     *
     * @returns 검증 결과 (errors, warnings)
     */
    validateAll(): { errors: Array<{ key: string; message: string }>; warnings: Array<{ key: string; message: string }> }
    {
        const errors: Array<{ key: string; message: string }> = [];
        const warnings: Array<{ key: string; message: string }> = [];

        for (const [key, schema] of this.schemas)
        {
            // 클라이언트 변수 중 민감정보 경고
            if (isClientAccessible(key) && schema.sensitive)
            {
                warnings.push({
                    key,
                    message: `${key} is marked as sensitive but accessible from client (NEXT_PUBLIC_*).`,
                });
            }

            const value = this.getRawValue(key, schema.fallbackKeys);

            // Check required
            if (schema.required && !value)
            {
                const fallbackHint = schema.fallbackKeys
                    ? ` (or ${schema.fallbackKeys.join(', ')})`
                    : '';
                errors.push({
                    key,
                    message: `${key}${fallbackHint} is required but not set. ${schema.description || ''}`,
                });
                continue;
            }

            // Check minLength
            if (value && schema.minLength !== undefined && value.length < schema.minLength)
            {
                errors.push({
                    key,
                    message: `${key} must be at least ${schema.minLength} characters long (current: ${value.length})`,
                });
                continue;
            }

            // Check validator
            if (value && schema.validator)
            {
                try
                {
                    schema.validator(value);
                }
                catch (error)
                {
                    // Same rule as the lazy path: a sensitive key's validator
                    // message may have interpolated the value, so it is dropped.
                    const detail = schema.sensitive
                        ? '(value hidden — sensitive key)'
                        : (error instanceof Error ? error.message : String(error));

                    errors.push({
                        key,
                        message: `${key} validation failed: ${detail}`,
                    });
                }
            }
        }

        return { errors, warnings };
    }

    /**
     * 환경변수 검증 및 타입 안전한 env 객체 반환
     *
     * Proxy 기반으로 구현되어 실제 환경변수 접근 시점에 값을 읽고 검증합니다.
     * 이를 통해 dotenv 로딩 타이밍과 무관하게 최신 환경변수 값을 가져올 수 있습니다.
     *
     * @returns 검증된 환경변수 객체 (Proxy)
     * @throws {Error} 필수 변수 누락 또는 검증 실패 시
     *
     * @example
     * ```typescript
     * const registry = createEnvRegistry(schema);
     * const env = registry.validate(); // 스키마만 검증
     * // ... dotenv 로딩 ...
     * console.log(env.DATABASE_URL); // 이 시점에 실제 값 읽기
     * ```
     */
    validate(): InferEnvType<T>
    {
        // Perform schema-level validation (without reading values)
        this.validateSchemas();

        // Return Proxy that lazily reads and validates on access
        return new Proxy({} as InferEnvType<T>, {
            get: (_target, prop: string) =>
            {
                return this.getAndValidate(prop);
            },

            ownKeys: () =>
            {
                return Array.from(this.schemas.keys());
            },

            getOwnPropertyDescriptor: (_target, prop: string) =>
            {
                if (this.schemas.has(prop))
                {
                    return {
                        enumerable: true,
                        configurable: true,
                        get: () => this.getAndValidate(prop),
                    };
                }

                return undefined;
            },

            has: (_target, prop: string) =>
            {
                return this.schemas.has(prop);
            },
        });
    }
}

/**
 * 환경변수 검증 결과
 */
export interface EnvValidationResult
{
    valid: boolean;
    errors: Array<{ key: string; message: string }>;
    warnings: Array<{ key: string; message: string }>;
}

/**
 * 레지스트리 생성 헬퍼
 *
 * @example
 * ```typescript
 * const schema = defineEnvSchema({
 *   DATABASE_URL: envString({ description: 'Database URL', required: true })
 * });
 *
 * const registry = createEnvRegistry(schema);
 * const env = registry.validate();
 * ```
 */
export function createEnvRegistry<T extends EnvSchemaCollection>(
    schemas: T,
): EnvRegistry<T>
{
    return new EnvRegistry(schemas);
}

/**
 * 모든 환경변수를 명시적으로 검증 (SKIP_ENV_VALIDATION 무시)
 *
 * CLI `spfn env validate` 명령어에서 사용
 *
 * @param registries - 검증할 레지스트리 배열
 * @returns 검증 결과
 *
 * @example
 * ```typescript
 * const result = validateAllEnv([coreRegistry, authRegistry]);
 * if (!result.valid) {
 *   console.error('Missing env vars:', result.errors);
 *   process.exit(1);
 * }
 * ```
 */
export function validateAllEnv(
    registries: EnvRegistry<any>[],
): EnvValidationResult
{
    const errors: Array<{ key: string; message: string }> = [];
    const warnings: Array<{ key: string; message: string }> = [];

    for (const registry of registries)
    {
        const result = registry.validateAll();
        errors.push(...result.errors);
        warnings.push(...result.warnings);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}
