/**
 * Promise Context Extraction Tests
 *
 * Tests for extractPromiseContext, extractQueryInfo, and formatUnhandledRejection functions
 */

import { describe, it, expect } from 'vitest';
import {
    extractPromiseContext,
    extractQueryInfo,
    formatUnhandledRejection,
} from '../formatters';

describe('extractQueryInfo', () =>
{
    it('should extract query from Drizzle error message', () =>
    {
        const error = new Error(
            'Failed query: update "spfn_storage"."legacy_cms_files" set "sync_status" = $1, "sync_progress" = $2',
        );

        const result = extractQueryInfo(error);

        expect(result).not.toBeNull();
        expect(result?.query).toContain('update');
        expect(result?.table).toBe('legacy_cms_files');
    });

    it('should extract table from INSERT query', () =>
    {
        const error = new Error(
            'Failed query: INSERT INTO "users" ("name", "email") VALUES ($1, $2)',
        );

        const result = extractQueryInfo(error);

        expect(result).not.toBeNull();
        expect(result?.table).toBe('users');
    });

    it('should extract table from schema-qualified query', () =>
    {
        const error = new Error(
            'Failed query: UPDATE "spfn_storage"."files" SET "status" = $1',
        );

        const result = extractQueryInfo(error);

        expect(result).not.toBeNull();
        expect(result?.table).toBe('files');
    });

    it('should return null for non-DB errors', () =>
    {
        const error = new Error('Some other error');

        const result = extractQueryInfo(error);

        expect(result).toBeNull();
    });
});

describe('extractPromiseContext', () =>
{
    it('should extract file and line number from stack trace', () =>
    {
        const error = new Error('Test error');
        // Simulate a stack trace
        error.stack = `Error: Test error
    at LegacyCmsFilesRepository.updateStatus (/path/to/legacy-cms-files.repository.ts:266:18)
    at async Object.onProgress (/path/to/episode-download.worker.ts:508:25)`;

        const result = extractPromiseContext(error);

        expect(result.file).toBe('legacy-cms-files.repository.ts');
        expect(result.line).toBe(266);
        expect(result.column).toBe(18);
        expect(result.class).toBe('LegacyCmsFilesRepository');
        expect(result.method).toBe('updateStatus');
        expect(result.repository).toBe('LegacyCmsFilesRepository');
    });

    it('should skip node_modules in stack trace', () =>
    {
        const error = new Error('Test error');
        error.stack = `Error: Test error
    at Module._compile (node_modules/some-lib/index.js:123:45)
    at UserRepository.findById (/path/to/user.repository.ts:50:10)`;

        const result = extractPromiseContext(error);

        // Should skip node_modules and go to next frame
        expect(result.file).toBe('user.repository.ts');
        expect(result.line).toBe(50);
    });

    it('should handle stack trace without class names', () =>
    {
        const error = new Error('Test error');
        error.stack = `Error: Test error
    at processFile (/path/to/processor.ts:100:20)
    at async main (/path/to/index.ts:10:5)`;

        const result = extractPromiseContext(error);

        expect(result.file).toBe('processor.ts');
        expect(result.line).toBe(100);
        expect(result.function).toBe('processFile');
        expect(result.class).toBeUndefined();
    });

    it('should return empty context for errors without stack', () =>
    {
        const error = new Error('Test error');
        delete error.stack;

        const result = extractPromiseContext(error);

        expect(result).toEqual({});
    });
});

describe('formatUnhandledRejection', () =>
{
    it('should format Error rejection with context', () =>
    {
        const reason = new Error('Database connection failed');
        reason.stack = `Error: Database connection failed
    at DatabaseManager.connect (/path/to/db-manager.ts:50:15)`;

        const promise = Promise.reject(reason).catch(() => 
        {}); // Prevent unhandled rejection
        const result = formatUnhandledRejection(reason, promise);

        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe('Database connection failed');
        expect(result.context.promiseContext).toBeDefined();
        expect((result.context.promiseContext as any).file).toBe('db-manager.ts');
    });

    it('should format string rejection', () =>
    {
        const reason = 'Something went wrong';
        const promise = Promise.reject(reason).catch(() => 
        {}); // Prevent unhandled rejection
        const result = formatUnhandledRejection(reason, promise);

        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe('Something went wrong');
    });

    it('should extract DB query info when available', () =>
    {
        const reason = new Error(
            'Failed query: update "users" set "status" = $1\nparams: active',
        );
        reason.stack = `Error: Failed query...
    at UserRepository.updateStatus (/path/to/user.repository.ts:100:10)`;

        const promise = Promise.reject(reason).catch(() => 
        {}); // Prevent unhandled rejection
        const result = formatUnhandledRejection(reason, promise);

        expect(result.context.queryInfo).toBeDefined();
        expect((result.context.queryInfo as any).table).toBe('users');
    });

    it('R10: the context carries the failed query, never its params line (#382)', () =>
    {
        const reason = new Error(
            'Failed query: insert into "users" ("email", "password_hash") values ($1, $2)\n'
            + 'params: leak-probe@example.test,$2b$FAKEHASH',
        );

        const promise = Promise.reject(reason).catch(() =>
        {}); // Prevent unhandled rejection
        const { context } = formatUnhandledRejection(reason, promise);
        const logged = JSON.stringify(context);

        expect(context.queryInfo).toEqual({
            query: 'insert into "users" ("email", "password_hash") values ($1, $2)',
            table: 'users',
        });
        expect(logged).not.toContain('leak-probe@example.test');
        expect(logged).not.toContain('FAKEHASH');
    });

    it('should include repository info when available', () =>
    {
        const reason = new Error('Query failed');
        reason.stack = `Error: Query failed
    at LegacyCmsFilesRepository.updateStatus (/path/to/legacy-cms-files.repository.ts:266:18)`;

        const promise = Promise.reject(reason).catch(() => 
        {}); // Prevent unhandled rejection
        const result = formatUnhandledRejection(reason, promise);

        expect(result.context.promiseContext).toBeDefined();
        expect((result.context.promiseContext as any).repository).toBe('LegacyCmsFilesRepository');
        expect((result.context.promiseContext as any).method).toBe('updateStatus');
    });
});
