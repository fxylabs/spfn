/**
 * Code Generation Module
 *
 * Automatic client code generation from route contracts
 */

// Orchestrator & Generator system
export { CodegenOrchestrator } from './core/orchestrator';
export {
    loadCodegenConfig,
    createGeneratorsFromConfig,
    defineConfig,
    defineGenerator,
} from './core/config-loader';

// Marks a process the spfn CLI started to generate code (see module-evaluation)
export { markCodegenProcess } from '../module-evaluation';

export type {
    RouteContractMapping,
    ResourceRoutes,
    ClientGenerationOptions,
    GenerationStats,
} from './core/types';

export type {
    ChangedFile,
    Generator,
    GeneratorOptions,
    GeneratorTrigger,
} from './core/generator';

export type {
    LoadingOrchestratorOptions,
    OrchestratorOptions,
} from './core/orchestrator';

export type {
    CodegenConfig,
    GeneratorConfig,
} from './core/config-loader';

export * from './generators';
