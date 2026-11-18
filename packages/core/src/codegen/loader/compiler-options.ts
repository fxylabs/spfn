/**
 * The compiler options a project file is transformed with
 *
 * The codegen loader compiles project TypeScript file by file
 * (`transpileModule`). A few compiler options change what the compiled code
 * does, and an app states them in the tsconfig that governs the file: the
 * nearest `tsconfig.json` above it, `extends` merged, searching up to the
 * project root (a file outside the root: the root's). `spfn build` compiles the
 * server with esbuild reading the app's tsconfig, so these are taken from it:
 *
 * - `experimentalDecorators`, `emitDecoratorMetadata`: legacy decorators
 *   rather than standard ones.
 * - `useDefineForClassFields`: define or assign semantics for class fields.
 *   Unstated, it follows the tsconfig's `target` as TypeScript and esbuild
 *   decide it: assign below ES2022, define from ES2022 on or with no `target`.
 *   This is the only way `target` is read.
 * - `jsx`, `jsxFactory`, `jsxFragmentFactory`, `jsxImportSource`. A `jsx` of
 *   `preserve` or `react-native` leaves JSX in the output, which Node cannot
 *   run: it becomes `react-jsx`, as does an unstated one.
 * - `verbatimModuleSyntax`: an import written without `type` is kept even when
 *   only types are used from it, so its module runs. (`importsNotUsedAsValues`
 *   and `preserveValueImports` were removed in TypeScript 5.5 and are not read.)
 *
 * Forced, whatever the tsconfig says, because Node runs the output as an ES
 * module and the loader maps its positions back to the source: `module:
 * ESNext`, `target: ES2022` (syntax Node 22 runs as written), `sourceMap: true`
 * and `isolatedModules: true`. Every other option changes types or checking,
 * not what runs, and is not read; `paths` is read by `./aliases`.
 */

import type * as ts from 'typescript';

/** Define semantics unless the tsconfig's `target` is below ES2022. */
function definesClassFields(compiler: typeof ts, target: ts.ScriptTarget | undefined): boolean
{
    return target === undefined || target >= compiler.ScriptTarget.ES2022;
}

/** The tsconfig's `jsx`, unless it leaves JSX that Node cannot run. */
function runnableJsx(compiler: typeof ts, jsx: ts.JsxEmit | undefined): ts.JsxEmit
{
    const leavesJsx = jsx === undefined || jsx === compiler.JsxEmit.Preserve || jsx === compiler.JsxEmit.ReactNative;

    return leavesJsx ? compiler.JsxEmit.ReactJSX : jsx;
}

/** The options to transform a file with, from the options of the tsconfig that governs it (none: `{}`). */
export function transpileOptions(compiler: typeof ts, project: ts.CompilerOptions): ts.CompilerOptions
{
    const taken: ts.CompilerOptions = {
        experimentalDecorators: project.experimentalDecorators,
        emitDecoratorMetadata: project.emitDecoratorMetadata,
        useDefineForClassFields: project.useDefineForClassFields ?? definesClassFields(compiler, project.target),
        jsx: runnableJsx(compiler, project.jsx),
        jsxFactory: project.jsxFactory,
        jsxFragmentFactory: project.jsxFragmentFactory,
        jsxImportSource: project.jsxImportSource,
        verbatimModuleSyntax: project.verbatimModuleSyntax,
    };

    return {
        ...Object.fromEntries(Object.entries(taken).filter(([, value]) => value !== undefined)),
        module: compiler.ModuleKind.ESNext,
        target: compiler.ScriptTarget.ES2022,
        sourceMap: true,
        isolatedModules: true,
    };
}
