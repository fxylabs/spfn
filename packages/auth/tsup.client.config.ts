import { defineConfig } from 'tsup';

import { sharedExternal } from './tsup.shared';

export default defineConfig({
    entry: {
        'nextjs/client': 'src/nextjs/client.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    splitting: false,
    banner: { js: `'use client';` },
    // Shares no chunk with the main build: whatever it takes from it comes through the
    // package's private import, so each module is emitted once (scripts/check-bundle-identity.mjs)
    external: [...sharedExternal, '#nextjs/client-shared'],
});
