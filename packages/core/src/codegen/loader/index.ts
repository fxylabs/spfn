/**
 * `@spfn/core/codegen/loader` — the module-format rule for an app's own source
 *
 * Shared by the codegen loader inside this package and the `spfn dev` hook in
 * the CLI, so the two decide a file's format by one rule (`./format`).
 * Kept to Node built-ins, so the `spfn dev` hook can import it into the server
 * process before anything of the app is loaded.
 */

export { applicationFormat, isDependency, packageType } from './format';
export type { ModuleFormat, SyntaxFormat } from './format';
