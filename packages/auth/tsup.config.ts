import { defineConfig } from 'tsup';

import { sharedExternal } from './tsup.shared';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        client: 'src/client.ts',
        'client-proof': 'src/server/client-proof/index.ts',
        config: 'src/config/index.ts',
        crypto: 'src/crypto.ts',
        errors: 'src/errors/index.ts',
        'nextjs/api': 'src/nextjs/api.ts',
        'nextjs/server': 'src/nextjs/server.ts',
        // Not exported: the private `#nextjs/client-shared` of the separate `nextjs/client` build
        'nextjs/client-shared': 'src/nextjs/client-shared.ts',
        server: 'src/server.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: sharedExternal,
});
