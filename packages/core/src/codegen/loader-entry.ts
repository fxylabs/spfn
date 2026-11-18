/**
 * `@spfn/core/codegen/loader` — the module-format rule for an app's own source
 *
 * Shared by the codegen loader inside this package and the `spfn dev` hook in
 * the CLI, so the two decide a file's format by one rule (`./loader/format`).
 * Kept to Node built-ins, so the `spfn dev` hook can import it into the server
 * process before anything of the app is loaded.
 *
 * Here rather than in `./loader/index.ts`: beside `./index.ts`, the entry
 * shares that entry's program in the declaration build (`tsup.config.ts`).
 */

export { applicationFormat, isDependency, packageType } from './loader/format';
export type { ModuleFormat, SyntaxFormat } from './loader/format';
