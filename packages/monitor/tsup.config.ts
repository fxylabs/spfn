import { defineConfig } from 'tsup';

import { sharedExternal } from './tsup.shared';
import { recordMetafile } from '../../scripts/lib/bundle-identity.mjs';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        server: 'src/server.ts',
        'config/index': 'src/config/index.ts',
    },
    format: ['esm'],
    esbuildPlugins: [recordMetafile('main')],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: sharedExternal,
});
