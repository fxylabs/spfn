/**
 * `spfn env audit` — keep the declared env list and the code in step.
 *
 * Two checks over the files in scope (see ./files.ts):
 *
 * - Direct reads: `process.env.X`, `process.env['X']`, `process.env[expr]` and
 *   `const { X } = process.env` outside the app's schema modules and root
 *   `*.config.*` files. `NODE_ENV` may be read anywhere.
 * - Unused declarations: a name in the app's own schemas (`env.schemas`) that
 *   no scanned file reads — as a property (`env.X`), a destructured key or a
 *   string literal `'X'` — and that has no `readBy`. Names an installed
 *   `@spfn/*` package declares are read inside that package and are skipped.
 *
 * Findings carry names only, never values.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadAppConfig, type SpfnEnvAuditConfig } from '@spfn/core/app-config';
import { loadAppSchemas, loadPackageSchemas, mergeEnvSources, type EnvList, type EnvSource } from '../env-list.js';
import type { EnvSchemaEntry } from '../env-schema.js';
import { DEFAULT_INCLUDE, listAuditFiles, type AuditScope } from './files.js';
import { loadTypeScript, readPropertyLines, readSourceFacts, type SourceFacts } from './parse.js';

export interface AuditFinding
{
    file: string;
    line: number;
    name: string;
    reason: string;
}

export interface EnvAuditReport
{
    fileCount: number;
    directReads: AuditFinding[];

    /** Unused names and `readBy` problems; empty when the check was skipped. */
    declarations: AuditFinding[];

    /** Why a check did not run, for the reader — not a finding. */
    notices: string[];
}

/** Root-level config files may read `process.env`: they run before any schema. */
const ROOT_CONFIG_FILE = /^[^/]+\.config\.(?:js|cjs|mjs|ts)$/;

/** What both checks share: the parsed files and the app's schema modules. */
interface AuditContext
{
    cwd: string;
    ts: ReturnType<typeof loadTypeScript>;
    list: EnvList;
    appSources: EnvSource[];

    /** The app's schema modules as project paths — scanned files are keyed the same way. */
    schemaFiles: Set<string>;
    facts: Map<string, SourceFacts>;
}

/**
 * Run both checks for the app at `cwd`.
 *
 * @throws Error when the env list cannot be built, `env.audit` is malformed,
 * or TypeScript cannot be found
 */
export async function runEnvAudit(cwd: string = process.cwd()): Promise<EnvAuditReport>
{
    const scope = readScope((await loadAppConfig(cwd)).env?.audit);
    const appSources = await loadAppSchemas(cwd);
    const list = mergeEnvSources([...appSources, ...await loadPackageSchemas(cwd)]);
    const ts = loadTypeScript(cwd);
    const files = listAuditFiles(cwd, scope);
    const context: AuditContext = {
        cwd,
        ts,
        list,
        appSources,
        schemaFiles: new Set(appSources.map((source) => toProjectPath(cwd, source.name))),
        facts: new Map(files.map((file) => [file, readSourceFacts(ts, file, readFileSync(join(cwd, file), 'utf-8'))])),
    };

    return {
        fileCount: files.length,
        directReads: findDirectReads(context),
        declarations: appSources.length > 0 ? findUnusedDeclarations(context) : [],
        notices: appSources.length > 0 ? [] : ['No env.schemas in spfn.config.js — the unused-declaration check is skipped.'],
    };
}

/**
 * `env.audit` with its default, refused when it is not arrays of strings.
 */
function readScope(audit: SpfnEnvAuditConfig | undefined): AuditScope
{
    const include = audit?.include ?? DEFAULT_INCLUDE;
    const ignore = audit?.ignore ?? [];

    for (const [field, value] of [['include', include], ['ignore', ignore]] as const)
    {
        if (!Array.isArray(value) || value.some((glob) => typeof glob !== 'string'))
        {
            throw new Error(`spfn.config.js: env.audit.${field} must be an array of globs relative to the project root.`);
        }
    }

    return { include, ignore };
}

function findDirectReads({ facts, schemaFiles }: AuditContext): AuditFinding[]
{
    return [...facts]
        .filter(([file]) => !schemaFiles.has(file) && !ROOT_CONFIG_FILE.test(file))
        .flatMap(([file, { directReads }]) => directReads.map((read) => ({ file, ...read })));
}

/**
 * App schema names read nowhere in scope, and `readBy` paths that do not hold.
 */
function findUnusedDeclarations(context: AuditContext): AuditFinding[]
{
    const readNames = new Set([...context.facts]
        .filter(([file]) => !context.schemaFiles.has(file))
        .flatMap(([, { names }]) => [...names]));

    return context.appSources.flatMap((source) =>
    {
        const file = toProjectPath(context.cwd, source.name);
        const lines = readPropertyLines(context.ts, file, readFileSync(join(context.cwd, file), 'utf-8'));

        return Object.entries(source.schema)
            .filter(([name]) => !isPackageName(context, name))
            .flatMap(([name, entry]) => checkEntry(context, readNames, name, entry)
                .map((reason) => ({ file, line: lines.get(name) ?? 1, name, reason })));
    });
}

/**
 * Why one app schema entry fails the check — none when it passes.
 */
function checkEntry(context: AuditContext, readNames: Set<string>, name: string, entry: EnvSchemaEntry): string[]
{
    if (entry.readBy === undefined)
    {
        return readNames.has(name) ? [] : ['declared but read nowhere in scope (unused)'];
    }

    if (!Array.isArray(entry.readBy) || entry.readBy.some((path) => typeof path !== 'string'))
    {
        return ['readBy must be an array of paths relative to the project root'];
    }

    return checkReadBy(context, entry.readBy);
}

/** A name an installed package declares too — that package reads it. */
function isPackageName({ list, appSources }: AuditContext, name: string): boolean
{
    const appNames = new Set(appSources.map((source) => source.name));

    return (list.declaredBy[name] ?? []).some((owner) => !appNames.has(owner));
}

/**
 * Why a `readBy` list does not vouch for its name — one reason per bad path.
 */
function checkReadBy({ cwd, facts }: AuditContext, readBy: string[]): string[]
{
    return readBy.flatMap((path) =>
    {
        const file = toProjectPath(cwd, path);

        if (!existsSync(join(cwd, file)))
        {
            return [`readBy file ${path} does not exist`];
        }

        return facts.has(file) ? [] : [`readBy file ${path} is not scanned (see env.audit)`];
    });
}

/** A config path in the form scanned files are keyed by. */
function toProjectPath(cwd: string, path: string): string
{
    return relative(cwd, resolve(cwd, path)).split('\\').join('/');
}
