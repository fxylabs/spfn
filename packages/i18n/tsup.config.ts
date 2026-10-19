import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'server': 'src/server.ts',
        'routing': 'src/routing.ts',
        'next': 'src/next.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    external: [
        'next',
        /^next\//,
    ],
    treeshake: {
        preset: 'smallest',
        propertyReadSideEffects: false,
    },
});
