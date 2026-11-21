import { defineConfig } from 'tsup';
import { recordMetafile } from '../../scripts/lib/bundle-identity.mjs';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        cli: 'src/cli.ts',
        dev: 'src/dev.ts',
        hosted: 'src/hosted.tsx',
    },
    format: ['esm'],
    esbuildPlugins: [recordMetafile('main')],
    dts: { entry: { index: 'src/index.ts', dev: 'src/dev.ts', hosted: 'src/hosted.tsx' } },
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: ['react', 'react-dom', 'next', '@spfn/pages'],
});
