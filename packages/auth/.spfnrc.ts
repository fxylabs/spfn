import { defineConfig, defineGenerator } from '@spfn/core/codegen';
import type { RouteMapGeneratorConfig } from '@spfn/core/codegen';

const routeMapGen = defineGenerator<RouteMapGeneratorConfig>({
    name: '@spfn/core:route-map',
    routerPath: './src/server/routes/index.ts',
    outputPath: './src/generated/route-map.ts',
});

export default defineConfig({
    generators: [routeMapGen],
});
