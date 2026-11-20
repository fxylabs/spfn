import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'verify': 'src/verify.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
});
