import { defineConfig } from 'tsup';
import { recordMetafile } from '../../scripts/lib/bundle-identity.mjs';

export default defineConfig({
    entry: {
        'client': 'src/client.tsx',
    },
    format: ['esm'],
    esbuildPlugins: [recordMetafile('client')],
    dts: true,
    sourcemap: true,
    splitting: false,
    banner: { js: `'use client';` },
    external: [
        'react',
        'react/jsx-runtime',

        // Built after the main entry, and kept external so dist/client.d.ts
        // references the root module instead of inlining copies of its types.
        // Type augmentation only reaches useT through a real import.
        './index.js',
    ],
});
