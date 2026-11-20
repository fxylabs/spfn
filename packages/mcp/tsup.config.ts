import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        dispatcher: 'src/dispatcher-entry.ts',
        server: 'src/server.ts',
        stdio: 'src/stdio.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: [
        /^@modelcontextprotocol\//,
        /^@spfn\//,
    ],
});
