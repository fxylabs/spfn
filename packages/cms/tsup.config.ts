import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        actions: 'src/actions.ts',
        server: 'src/server.ts',
        config: 'src/config/index.ts',
        errors: 'src/errors/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    external: [
        // Internal entrypoints (prevent bundling into each other)
        '@spfn/cms',
        '@spfn/cms/actions',
        '@spfn/cms/server',
        '@spfn/cms/config',
        '@spfn/cms/errors',
        // External dependencies
        '@spfn/core',
        '@spfn/core/server',
        '@spfn/core/db',
        '@spfn/core/route',
        '@spfn/core/errors',
        '@spfn/core/logger',
        '@spfn/core/config',
        '@spfn/core/env',
        'drizzle-orm',
        'postgres',
        'bcryptjs',
        'jsonwebtoken',
        'next',
        /^next\//,
        'server-only',
        'jose',
        'react',
        'react/jsx-runtime',
    ],
});
