/**
 * Environment Schema Tests
 */

import { describe, it, expect } from 'vitest';
import {
    defineEnvSchema,
    envSecret,
    envString,
    envNumber,
    envBoolean,
    envUrl,
    envEnum,
    envJson,
    isClientAccessible,
    isServerOnly,
} from '../schema';

describe('defineEnvSchema', () =>
{
    it('should add key property from object keys', () =>
    {
        const schema = defineEnvSchema({
            DATABASE_URL: envString({ description: 'Database URL' }),
            PORT: envNumber({ description: 'Server port' }),
        });

        expect(schema.DATABASE_URL.key).toBe('DATABASE_URL');
        expect(schema.PORT.key).toBe('PORT');
    });

    it('should preserve original properties', () =>
    {
        const schema = defineEnvSchema({
            DEBUG: envBoolean({
                description: 'Debug mode',
                default: false,
            }),
        });

        expect(schema.DEBUG.description).toBe('Debug mode');
        expect(schema.DEBUG.default).toBe(false);
        expect(schema.DEBUG.type).toBe('boolean');
    });

    it('should keep the declared layer and leave it unset otherwise', () =>
    {
        const schema = defineEnvSchema({
            DB_NAME: envString({ description: 'Database name', layer: 'instance' }),
            API_KEY: envSecret({ description: 'Third-party key' }),
        });

        expect(schema.DB_NAME.layer).toBe('instance');
        expect('layer' in schema.API_KEY).toBe(false);
    });

    it('should keep the declared readBy paths', () =>
    {
        const schema = defineEnvSchema({
            PROVIDER_KEY: envSecret({ description: 'Provider key', readBy: ['src/server/providers.ts'] }),
        });

        expect(schema.PROVIDER_KEY.readBy).toEqual(['src/server/providers.ts']);
    });
});

describe('envString', () =>
{
    it('should create string schema', () =>
    {
        const schema = envString({
            description: 'API key',
            required: true,
            sensitive: true,
        });

        expect(schema.type).toBe('string');
        expect(schema.description).toBe('API key');
        expect(schema.required).toBe(true);
        expect(schema.sensitive).toBe(true);
    });
});

describe('envNumber', () =>
{
    it('should create number schema with default validator', () =>
    {
        const schema = envNumber({
            description: 'Port number',
            default: 3000,
        });

        expect(schema.type).toBe('number');
        expect(schema.default).toBe(3000);
        expect(schema.validator).toBeDefined();
        expect(schema.validator!('42')).toBe(42);
    });

    it('should allow custom validator', () =>
    {
        const customValidator = (val: string) => parseInt(val, 10) * 2;
        const schema = envNumber({
            description: 'Double port',
            validator: customValidator,
        });

        expect(schema.validator('21')).toBe(42);
    });
});

describe('envBoolean', () =>
{
    it('should create boolean schema with default validator', () =>
    {
        const schema = envBoolean({
            description: 'Enable feature',
            default: false,
        });

        expect(schema.type).toBe('boolean');
        expect(schema.default).toBe(false);
        expect(schema.validator!('true')).toBe(true);
        expect(schema.validator!('false')).toBe(false);
    });
});

describe('envUrl', () =>
{
    it('should create URL schema', () =>
    {
        const schema = envUrl({
            description: 'API endpoint',
            required: true,
        });

        expect(schema.type).toBe('url');
        expect(schema.required).toBe(true);
    });
});

describe('envEnum', () =>
{
    it('should create enum schema with validator', () =>
    {
        const schema = envEnum(['debug', 'info', 'warn', 'error'] as const, {
            description: 'Log level',
            default: 'info',
        });

        expect(schema.type).toBe('enum');
        expect(schema.default).toBe('info');
        expect(schema.validator('debug')).toBe('debug');
    });

    it('should throw on invalid enum value', () =>
    {
        const schema = envEnum(['a', 'b', 'c'] as const, {
            description: 'Options',
        });

        expect(() => schema.validator('invalid')).toThrow('Must be one of');
    });
});

describe('envJson', () =>
{
    it('should create JSON schema with validator', () =>
    {
        interface Config
        {
            host: string;
            port: number;
        }

        const schema = envJson<Config>({
            description: 'JSON config',
            required: true,
        });

        expect(schema.type).toBe('json');
        expect(schema.validator('{"host":"localhost","port":3000}')).toEqual({
            host: 'localhost',
            port: 3000,
        });
    });

    it('should throw on invalid JSON', () =>
    {
        const schema = envJson({
            description: 'JSON data',
        });

        expect(() => schema.validator('not json')).toThrow('Invalid JSON');
    });
});

describe('isClientAccessible', () =>
{
    it('should return true for NEXT_PUBLIC_ prefixed keys', () =>
    {
        expect(isClientAccessible('NEXT_PUBLIC_API_URL')).toBe(true);
        expect(isClientAccessible('NEXT_PUBLIC_APP_NAME')).toBe(true);
    });

    it('should return false for non-NEXT_PUBLIC_ keys', () =>
    {
        expect(isClientAccessible('DATABASE_URL')).toBe(false);
        expect(isClientAccessible('API_SECRET')).toBe(false);
    });
});

describe('isServerOnly', () =>
{
    it('should return true for non-NEXT_PUBLIC_ keys', () =>
    {
        expect(isServerOnly('DATABASE_URL')).toBe(true);
        expect(isServerOnly('API_SECRET')).toBe(true);
    });

    it('should return false for NEXT_PUBLIC_ prefixed keys', () =>
    {
        expect(isServerOnly('NEXT_PUBLIC_API_URL')).toBe(false);
    });
});
