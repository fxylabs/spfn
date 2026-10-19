/**
 * Built-in Generators Export
 *
 * @example
 * ```typescript
 * // .spfnrc.ts
 * import { defineConfig, defineGenerator } from '@spfn/core/codegen';
 * import type { RouteMapGeneratorConfig, ContractGeneratorConfig, StatesGeneratorConfig } from '@spfn/core/codegen';
 *
 * export default defineConfig({
 *   generators: [
 *     defineGenerator<RouteMapGeneratorConfig>({
 *       name: '@spfn/core:route-map',
 *       routerPath: './src/server/router.ts',
 *       outputPath: './src/generated/route-map.ts',
 *     }),
 *     defineGenerator<ContractGeneratorConfig>({
 *       name: '@spfn/core:contract',
 *       routerPath: './src/server/router.ts',
 *       outputDir: './contracts',
 *     }),
 *     defineGenerator<StatesGeneratorConfig>({
 *       name: '@spfn/core:states',
 *       routerPath: './src/server/router.ts',
 *       outputPath: './src/generated/states.ts',
 *     }),
 *   ]
 * });
 * ```
 */

import { createRouteMapGenerator } from './route-map';
import { createContractGenerator } from './contract';
import { createStatesGenerator } from './states';

export type { RouteMapGeneratorConfig } from './route-map';
export { RouteMapGeneratorError } from './route-map';
export type { ContractGeneratorConfig } from './contract';
export { ContractGeneratorError } from './contract';
export type { StatesGeneratorConfig } from './states';
export { StatesGeneratorError } from './states';
export { assertUnconditionalRegistration, ConditionalRegistrationError } from './contract-guard';
export type { RegistrationScan } from './contract-guard';

/**
 * @internal
 * Registry of available generators for package-based loading.
 * DO NOT use directly - use defineGenerator({ name: '@spfn/core:route-map', ... }) instead.
 */
export const generators: Record<string, unknown> = {
    'route-map': createRouteMapGenerator,
    contract: createContractGenerator,
    states: createStatesGenerator,
};
