import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        server: 'src/server.ts',
        'config/index': 'src/config/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: [
        // Internal entrypoints
        '@spfn/notification',
        '@spfn/notification/server',
        '@spfn/notification/config',
        // External dependencies
        '@spfn/core',
        '@spfn/core/config',
        '@spfn/core/logger',
        '@spfn/core/env',
        '@spfn/core/db',
        '@spfn/core/job',
        '@aws-sdk/client-ses',
        '@aws-sdk/client-sns',
        'drizzle-orm',
        'drizzle-orm/pg-core',
    ],
});
