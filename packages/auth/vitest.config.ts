import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest Configuration for @spfn/auth
 *
 * Auth tests require database infrastructure (PostgreSQL)
 */
export default defineConfig(
    {
        test:
        {
            globals: true,
            environment: 'node',
            include: ['src/**/*.{test,spec}.{js,ts}'],

            // Sequential execution for database tests
            pool: 'forks',
            poolOptions:
            {
                forks:
                {
                    singleFork: true,
                },
            },

            // Disable parallelization
            fileParallelism: false,

            // Timeout for integration tests
            testTimeout: 30000,

            // bcrypt at the production cost of 12 is ~265 ms a hash, and an
            // integration test seeds users, logs in and may hash ten recovery
            // codes — about 2 s a test spent on nothing it asserts. Cost 4 is
            // bcrypt's minimum. The env proxy reads on every access, so
            // unit/password.test.ts removes this for itself and keeps proving
            // the production default.
            //
            // One trusted proxy hop, as a deployment behind a load balancer
            // declares it: suites give each row its own address through
            // `x-forwarded-for` so that per-IP limits, which outlive a file in
            // the single fork, do not carry from one row to the next. With no
            // declaration the backend reads no forwarding header (au9-N3).
            env:
            {
                SPFN_AUTH_BCRYPT_SALT_ROUNDS: '4',
                // Every repository method that writes an account's credential
                // state throws without the account lock in its transaction
                // (`usersRepository.lockAccount`).
                SPFN_AUTH_ASSERT_ACCOUNT_LOCK: '1',
                SERVER_TRUSTED_PROXY_HOPS: '1',
            },

            // Coverage configuration
            coverage:
            {
                provider: 'v8',
                reporter: ['text', 'json', 'html', 'json-summary'],
                reportsDirectory: './coverage',
                exclude: [
                    'node_modules/**',
                    'dist/**',
                    '**/*.d.ts',
                    '**/*.config.*',
                    '**/mockData/**',
                    '**/__tests__/**',
                ],
                include: ['src/**/*.ts'],
                all: true,

                // Coverage thresholds
                thresholds:
                {
                    lines: 80,
                    functions: 80,
                    branches: 75,
                    statements: 80,
                },
            },
        },
        resolve:
        {
            alias:
            {
                '@': resolve(__dirname, './src'),
                '@auth': resolve(__dirname, './src'),
            },
        },
    },
);
