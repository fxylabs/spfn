import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Default Vitest Configuration (All Tests)
 *
 * Runs all tests (unit + integration) sequentially to avoid memory issues.
 *
 * This is the only config the package has: the separate unit and integration
 * ones were folded into it, and the settings integration tests need — a single
 * fork, no file parallelism, 30s timeouts — apply to every run because of it.
 *
 * For faster feedback during development, the per-module scripts narrow the
 * run to one directory under this same config: pnpm test:logger, test:db, and
 * the rest. The db, cache, and server ones need their infrastructure up.
 */
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.{test,spec}.{js,ts,tsx}'],

        // Sequential execution to reduce memory usage and avoid global state conflicts
        fileParallelism: false,
        maxConcurrency: 1,
        pool: 'forks',  // Use forks for better isolation with global state

        // Pool options for proper cleanup
        poolOptions: {
            forks: {
                singleFork: true,  // Use single fork process (sequential)
            },
        },

        // Timeout for integration tests
        testTimeout: 30000,
        hookTimeout: 30000,  // Timeout for beforeAll/afterAll hooks
        teardownTimeout: 10000,  // Timeout for cleanup after tests
    },
    resolve: {
        alias: {
            '@core': resolve(__dirname, './src'),
            '@/server/entities': resolve(__dirname, './src/db/__tests__/fixtures/entities'),
        },
    },
});
