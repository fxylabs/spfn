/**
 * PostgreSQL Error Conversion Tests
 *
 * Tests error code mapping and conversion utilities
 */

import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { databaseErrorMessage, fromPostgresError } from '../postgres-errors';
import { DuplicateEntryError } from '../../errors/database-errors';
import { expectNoValues, failedInsert } from '../../logger/__tests__/helpers/leak-probe';

describe('PostgreSQL Error Conversion', () =>
{
    describe('fromPostgresError()', () =>
    {
        describe('Connection Errors (Class 08)', () =>
        {
            it('should convert 08000 to ConnectionError', () =>
            {
                const pgError = { code: '08000', message: 'Connection exception' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
                // Not a driver error (no severity): the class's fixed text, not its message
                expect(error.message).toBe('Database connection failed');
                expect(error.details?.code).toBe('08000');
            });

            it('should convert 08001 to ConnectionError', () =>
            {
                const pgError = { code: '08001', message: 'Unable to establish connection' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 08003 to ConnectionError', () =>
            {
                const pgError = { code: '08003', message: 'Connection does not exist' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 08004 to ConnectionError', () =>
            {
                const pgError = { code: '08004', message: 'Server rejected connection' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 08006 to ConnectionError', () =>
            {
                const pgError = { code: '08006', message: 'Connection failure' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 08007 to ConnectionError', () =>
            {
                const pgError = { code: '08007', message: 'Transaction resolution unknown' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 08P01 to ConnectionError', () =>
            {
                const pgError = { code: '08P01', message: 'Protocol violation' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });
        });

        describe('Integrity Constraint Violations (Class 23)', () =>
        {
            it('should convert 23000 to ConstraintViolationError', () =>
            {
                const pgError = { code: '23000', message: 'Integrity constraint violation' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConstraintViolationError');
                expect(error.details?.constraint).toBe('integrity');
            });

            it('should convert 23001 to ConstraintViolationError', () =>
            {
                const pgError = { code: '23001', message: 'Restrict violation' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConstraintViolationError');
                expect(error.details?.constraint).toBe('integrity');
            });

            it('should convert 23502 to ConstraintViolationError for not_null', () =>
            {
                const pgError = { code: '23502', message: 'null value in column "email" violates not-null constraint' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConstraintViolationError');
                expect(error.details?.constraint).toBe('not_null');
            });

            it('should convert 23503 to ConstraintViolationError for foreign_key', () =>
            {
                const pgError = { code: '23503', message: 'Foreign key constraint violated' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConstraintViolationError');
                expect(error.details?.constraint).toBe('foreign_key');
            });

            it('should convert 23514 to ConstraintViolationError for check', () =>
            {
                const pgError = { code: '23514', message: 'Check constraint violated' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConstraintViolationError');
                expect(error.details?.constraint).toBe('check');
            });
        });

        describe('Unique Violations (23505)', () =>
        {
            it('should convert simple unique violation with field parsing', () =>
            {
                const pgError = {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "users_email_key"\nDetail: Key (email)=(test@example.com) already exists.',
                };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('DuplicateEntryError');
                expect(error.message).toContain('email');
                // The value must NOT leak into the client-facing message (enumeration)…
                expect(error.message).not.toContain('test@example.com');
                // …but is preserved on the instance for server-side handling.
                expect((error as DuplicateEntryError).value).toBe('test@example.com');
            });

            it('should parse field and value from unique violation', () =>
            {
                const pgError = {
                    code: '23505',
                    message: 'Key (username)=(john_doe) already exists.',
                };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('DuplicateEntryError');
                expect(error.message).toContain('username');
                expect(error.message).not.toContain('john_doe');
                expect((error as DuplicateEntryError).value).toBe('john_doe');
            });

            it('should handle complex unique violations with multiple fields', () =>
            {
                const pgError = {
                    code: '23505',
                    message: 'Key (user_id, tenant_id)=(123, 456) already exists.',
                };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('DuplicateEntryError');
            });

            it('should handle quoted field names', () =>
            {
                const pgError = {
                    code: '23505',
                    message: 'Key ("email")=(\'test@example.com\') already exists.',
                };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('DuplicateEntryError');
            });

            it('should fallback to generic duplicate when parsing fails', () =>
            {
                const pgError = {
                    code: '23505',
                    message: 'Unique constraint violated',
                };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('DuplicateEntryError');
            });
        });

        describe('Transaction Rollback (Class 40)', () =>
        {
            it('should convert 40000 to TransactionError', () =>
            {
                const pgError = { code: '40000', message: 'Transaction rollback' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('TransactionError');
                expect(error.statusCode).toBe(500);
            });

            it('should convert 40001 to TransactionError for serialization failure', () =>
            {
                const pgError = { code: '40001', message: 'Serialization failure' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('TransactionError');
            });

            it('should convert 40002 to TransactionError', () =>
            {
                const pgError = { code: '40002', message: 'Transaction integrity constraint violation' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('TransactionError');
            });

            it('should convert 40003 to TransactionError', () =>
            {
                const pgError = { code: '40003', message: 'Statement completion unknown' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('TransactionError');
            });

            it('should convert 40P01 to DeadlockError', () =>
            {
                const pgError = { code: '40P01', message: 'Deadlock detected' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('DeadlockError');
                expect(error.details?.code).toBe('40P01');
            });
        });

        describe('Syntax Error / Access Violations (Class 42)', () =>
        {
            it('should convert 42000 to QueryError', () =>
            {
                const pgError = { code: '42000', message: 'Syntax error or access rule violation' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
                expect(error.statusCode).toBe(400);
            });

            it('should convert 42601 to QueryError for syntax error', () =>
            {
                const pgError = { code: '42601', message: 'Syntax error at or near "SELEC"' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42501 to QueryError for insufficient privilege', () =>
            {
                const pgError = { code: '42501', message: 'Insufficient privilege' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42602 to QueryError for invalid name', () =>
            {
                const pgError = { code: '42602', message: 'Invalid name' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42622 to QueryError for name too long', () =>
            {
                const pgError = { code: '42622', message: 'Name too long' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42701 to QueryError for duplicate column', () =>
            {
                const pgError = { code: '42701', message: 'Duplicate column' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42702 to QueryError for ambiguous column', () =>
            {
                const pgError = { code: '42702', message: 'Ambiguous column' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42703 to QueryError for undefined column', () =>
            {
                const pgError = { code: '42703', message: 'Column "foo" does not exist' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42704 to QueryError for undefined object', () =>
            {
                const pgError = { code: '42704', message: 'Undefined object' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42P01 to QueryError for undefined table', () =>
            {
                const pgError = { code: '42P01', message: 'Relation "users" does not exist' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });

            it('should convert 42P02 to QueryError for undefined parameter', () =>
            {
                const pgError = { code: '42P02', message: 'Undefined parameter' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
            });
        });

        describe('Insufficient Resources (Class 53)', () =>
        {
            it('should convert 53000 to ConnectionError', () =>
            {
                const pgError = { code: '53000', message: 'Insufficient resources' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 53100 to ConnectionError for disk full', () =>
            {
                const pgError = { code: '53100', message: 'Disk full' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 53200 to ConnectionError for out of memory', () =>
            {
                const pgError = { code: '53200', message: 'Out of memory' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 53300 to ConnectionError for too many connections', () =>
            {
                const pgError = { code: '53300', message: 'Too many connections' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });
        });

        describe('Operator Intervention (Class 57)', () =>
        {
            it('should convert 57000 to ConnectionError', () =>
            {
                const pgError = { code: '57000', message: 'Operator intervention' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 57014 to ConnectionError for query canceled', () =>
            {
                const pgError = { code: '57014', message: 'Query canceled' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 57P01 to ConnectionError for admin shutdown', () =>
            {
                const pgError = { code: '57P01', message: 'Admin shutdown' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 57P02 to ConnectionError for crash shutdown', () =>
            {
                const pgError = { code: '57P02', message: 'Crash shutdown' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });

            it('should convert 57P03 to ConnectionError for cannot connect now', () =>
            {
                const pgError = { code: '57P03', message: 'Cannot connect now' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('ConnectionError');
            });
        });

        describe('Unknown Errors', () =>
        {
            it('should convert unknown error code to QueryError', () =>
            {
                const pgError = { code: '99999', message: 'Unknown error' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
                expect(error.statusCode).toBe(500);
                expect(error.details?.code).toBe('99999');
            });

            it('should handle missing error code', () =>
            {
                const pgError = { message: 'Error without code' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
                expect(error.message).toBe('Database query failed');
            });

            it('should handle missing error message', () =>
            {
                const pgError = { code: '42601' };
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
                expect(error.message).toBe('Invalid query');
            });

            it('should handle completely empty error object', () =>
            {
                const pgError = {};
                const error = fromPostgresError(pgError);

                expect(error.name).toBe('QueryError');
                expect(error.message).toBe('Database query failed');
            });

            it('should handle null error', () =>
            {
                const error = fromPostgresError(null);

                expect(error.name).toBe('QueryError');
                expect(error.message).toBe('Database query failed');
            });

            it('should handle undefined error', () =>
            {
                const error = fromPostgresError(undefined);

                expect(error.name).toBe('QueryError');
                expect(error.message).toBe('Database query failed');
            });
        });

        /**
         * | #  | the driver error                         | goes unnoticed without the row                                  |
         * | -- | ---------------------------------------- | --------------------------------------------------------------- |
         * | P1 | a 22P02 quoting the rejected input       | the typed error's message carrying the value to every log line  |
         * | P2 | a 23502 from ExecConstraints             | a kept message replaced by the fixed text, or the cause dropped |
         * | P3 | drizzle's query error over it            | the typed error's message being drizzle's `params:` text        |
         */
        describe('The typed error keeps the driver error as its cause, and its message only where the description does (#382)', () =>
        {
            const driverError = (fields: Record<string, string>): Error =>
                Object.assign(new Error(fields.message), { severity: 'ERROR', severity_local: 'ERROR', ...fields });

            it('P1: a class-22 error gets the class\'s fixed message', () =>
            {
                const invalid = driverError({ code: '22P02', message: 'invalid input syntax for type integer: "leak-probe-value"', routine: 'pg_strtoint32_safe' });

                const error = fromPostgresError(invalid);

                expect(error).toMatchObject({ name: 'QueryError', statusCode: 500, message: 'Invalid input value' });
                expect(error.cause).toBe(invalid);
                expect(JSON.stringify(error.toJSON())).not.toContain('leak-probe-value');
                expect(error.stack).not.toContain('leak-probe-value');
            });

            it('P2: a kept class from a known routine keeps the driver\'s message', () =>
            {
                const notNull = driverError({ code: '23502', message: 'null value in column "email" of relation "users" violates not-null constraint', routine: 'ExecConstraints' });

                const error = fromPostgresError(notNull);

                expect(error).toMatchObject({ name: 'ConstraintViolationError', message: notNull.message });
                expect(error.cause).toBe(notNull);
                expect(Object.keys(error.toJSON())).not.toContain('cause');
            });

            it('P3: drizzle\'s query error is not converted, and its message is the description\'s, not drizzle\'s', () =>
            {
                const error = fromPostgresError(failedInsert());

                // Still the fallback QueryError (converting a wrapped error is #383); the
                // message is the description's — the driver's kept 23505 text
                expect(error).toMatchObject({ name: 'QueryError', statusCode: 500, message: 'duplicate key value violates unique constraint "users_email_key"' });
                expectNoValues(error.message);
            });
        });
    });

    describe('databaseErrorMessage() — the text a database error may be shown with (#378)', () =>
    {
        const driverError = (fields: Record<string, string>): Error =>
            Object.assign(new Error(fields.message), { severity: 'ERROR', severity_local: 'ERROR', ...fields });

        it('M1: class 22 gives the class\'s fixed text, not the rejected input — under drizzle too', () =>
        {
            const invalid = driverError({ code: '22P02', message: 'invalid input syntax for type integer: "SECRETVALUE"', routine: 'pg_strtoint32_safe' });
            const wrapped = new DrizzleQueryError('ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE integer USING "c"::integer', [], invalid);

            expect(databaseErrorMessage(invalid)).toBe('Invalid input value');
            expect(databaseErrorMessage(wrapped)).toBe('Invalid input value');
        });

        it('M2: a kept class from a known routine keeps the driver\'s message', () =>
        {
            expect(databaseErrorMessage(failedInsert())).toBe('duplicate key value violates unique constraint "users_email_key"');
        });

        it.each([
            ['42703', 'column "SECRETVALUE" does not exist', 'Invalid query'],
            ['28P01', 'password authentication failed for user "SECRETVALUE"', 'Database authentication failed'],
            ['XX000', 'SECRETVALUE', 'Database query failed'],
        ])('M3: SQLSTATE %s gives its class\'s fixed text', (code, message, text) =>
        {
            expect(databaseErrorMessage(driverError({ code, message }))).toBe(text);
        });

        it('M4: a 23505 the app raised itself (exec_stmt_raise) gives the class text, not its own message', () =>
        {
            const raised = driverError({ code: '23505', message: 'SECRETVALUE', routine: 'exec_stmt_raise' });

            expect(databaseErrorMessage(raised)).toBe('Integrity constraint violated');
        });

        it('M5: one of the driver\'s own connection codes', () =>
        {
            expect(databaseErrorMessage(Object.assign(new Error('write CONNECTION_CLOSED db:5432'), { code: 'CONNECTION_CLOSED' }))).toBe('Database connection lost');
        });
    });
});
