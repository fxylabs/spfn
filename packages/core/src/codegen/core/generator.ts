/**
 * Generator Interface
 *
 * Defines the contract for code generators that can be orchestrated by the codegen system.
 */

/**
 * Generator execution trigger types
 *
 * Who fires each one:
 * - `watch`  — `spfn dev`, on the initial pass and every file change
 * - `manual` — `spfn codegen run` and `spfn contract`
 * - `build`  — `spfn build`
 * - `start`  — nothing in the shipped CLI; reserved for a programmatic caller that
 *              dispatches it through `orchestrator.generateAll('start')`
 */
export type GeneratorTrigger = 'watch' | 'manual' | 'build' | 'start';

/** A file whose change triggered a run, relative to the project root. */
export interface ChangedFile
{
    path: string;
    event: 'add' | 'change' | 'unlink';
}

export interface GeneratorOptions
{
    /** Project root directory */
    cwd: string;

    /** Enable debug logging */
    debug?: boolean;

    /** Execution trigger information */
    trigger?: {
        /** How the generator was triggered */
        type: GeneratorTrigger;

        /**
         * The change that triggered this run, when exactly one did (only for the
         * 'watch' trigger, never on its initial pass). Absent when several
         * changes were taken together: read `changedFiles` then.
         */
        changedFile?: ChangedFile;

        /**
         * Every change that triggered this run (only for the 'watch' trigger,
         * never on its initial pass): the files matching the generator's
         * `watchPatterns`, and the files its previous run read, that changed
         * since. The watcher takes every change queued while a generation ran
         * into the next one, so a run may be for several.
         */
        changedFiles?: ChangedFile[];
    };

    /**
     * One run of the orchestrator: every generator it runs for one trigger gets
     * the same value. The built-in generators load each router once per
     * generation through it, so the project is evaluated once per run however
     * many generators read the router. A generator called without one loads on
     * its own.
     */
    generation?: string;

    /** Custom configuration options */
    [key: string]: any;
}

export interface Generator
{
    /** Unique generator name */
    name: string;

    /** File patterns to watch (glob patterns) */
    watchPatterns: string[];

    /**
     * When this generator should run
     *
     * @default ['watch', 'manual', 'build'] — every trigger the CLI fires
     *
     * Narrowing this is the easy mistake: drop `build` and the generator is silently
     * skipped during `spfn build`, so whatever it produces ships stale.
     *
     * Examples:
     * - ['watch']: only while `spfn dev` is watching, never from `spfn codegen run`
     * - ['manual']: only on an explicit run, never mid-edit — for something slow
     */
    runOn?: GeneratorTrigger[];

    /**
     * Generate code
     *
     * Generator can implement incremental updates by checking `options.trigger.changedFile`
     * (or `changedFiles`, when several changes were taken together). If incremental update
     * is not possible — or neither is set — do full regeneration.
     *
     * @param options - Generator options with trigger context
     *
     * @example
     * ```typescript
     * async generate(options: GeneratorOptions): Promise<void>
     * {
     *     // Check if incremental update is possible
     *     if (options.trigger?.changedFile)
     *     {
     *         const { path, event } = options.trigger.changedFile;
     *
     *         if (canDoIncrementalUpdate(path, event))
     *         {
     *             await updateSingleFile(path);
     *             return;
     *         }
     *     }
     *
     *     // Fallback: full regeneration
     *     await fullRegenerate();
     * }
     * ```
     */
    generate(options: GeneratorOptions): Promise<void>;
}
