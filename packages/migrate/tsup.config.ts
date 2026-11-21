import { defineConfig } from 'tsup';
import { recordMetafile } from '../../scripts/lib/bundle-identity.mjs';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
    },
    format: ['esm'],
    esbuildPlugins: [recordMetafile('main')],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    external: [
        '@spfn/migrate',
        '@spfn/core',
        '@spfn/core/db',
        '@spfn/core/logger',
        'drizzle-orm',
        'drizzle-orm/pg-core',
    ],
});
