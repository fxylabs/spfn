import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        alias: {
            // The package's private import points at the built entry (`imports` in
            // package.json); tests read the source, as tsc maps it, so a stale or
            // missing dist does not decide what the nextjs/client rows run.
            '#nextjs/client-shared': resolve(__dirname, './src/nextjs/client-shared.ts'),
        },
    },
});
