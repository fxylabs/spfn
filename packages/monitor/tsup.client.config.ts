import { defineConfig } from 'tsup';

import { sharedExternal } from './tsup.shared';
import { recordMetafile } from '../../scripts/lib/bundle-identity.mjs';

export default defineConfig({
    entry: {
        'nextjs/client': 'src/nextjs/client.ts',
    },
    format: ['esm'],
    esbuildPlugins: [recordMetafile('client')],
    dts: true,
    sourcemap: true,
    splitting: false,
    banner: { js: `'use client';` },
    external: sharedExternal,
});
