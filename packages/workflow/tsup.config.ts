import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'entities/workflow-execution': 'src/entities/workflow-execution.entity.ts',
        'entities/workflow-step-execution': 'src/entities/workflow-step-execution.entity.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: [
        /^@spfn\//,
        '@sinclair/typebox',
        'drizzle-orm',
        'postgres',
        'pg-boss',
    ],
});
