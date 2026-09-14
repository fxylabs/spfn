/**
 * Drizzle Kit configuration generator
 * Automatically generates drizzle.config.ts from environment variables
 */

import { existsSync, readdirSync, readFileSync, realpathSync, lstatSync, statSync, type Stats } from 'fs';
import { join, relative } from 'path';
import mm from 'micromatch';
import { env } from '@spfn/core/config';
import { toPosixPath } from './path-utils';

// ============================================================================
// Constants
// ============================================================================

/**
 * Barrel file patterns to exclude from schema discovery.
 * These are re-export files that would cause circular imports
 * when loaded alongside the individual entity files they re-export.
 * Paths are normalized to POSIX separators before matching.
 */
const BARREL_FILE_PATTERNS = [
    '/index',
    '/index.ts',
    '/index.js',
    '/index.mjs',
    '/config',
    '/config.ts',
    '/config.js',
    '/config.mjs',
];

/**
 * Folder scan used by default
 */
const DEFAULT_ENTITY_GLOB = './src/server/entities/**/*.ts';

/**
 * Supported file extensions for schema files — the set drizzle-kit's own
 * file preparation accepts. Declaration files (.d.ts, .d.mts, .d.cts) are not schemas.
 */
const SUPPORTED_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const DECLARATION_PATTERN = /\.d\.[mc]?ts$/;

/**
 * Directories a walk never enters. drizzle-kit's glob runs with its default
 * `dot: false`, so dot-directories (.git, .next) are skipped there too;
 * node_modules is skipped on purpose so a `**` pattern cannot pull a
 * dependency's file into the project schema.
 */
const SKIPPED_DIRECTORIES = /^(\.|node_modules$)/;

// ============================================================================
// Helper Functions (Private)
// ============================================================================

/**
 * Check if a file path is an index file
 *
 * @param filePath - File path to check
 * @returns true if file is an index file
 * @internal
 */
function isBarrelFile(filePath: string): boolean
{
    const posixPath = toPosixPath(filePath);

    return BARREL_FILE_PATTERNS.some(pattern => posixPath.endsWith(pattern));
}

/**
 * Check if a path is absolute
 *
 * @param path - Path to check
 * @returns true if path is absolute
 * @internal
 */
function isAbsolutePath(path: string): boolean
{
    // Unix absolute path (starts with /)
    if (path.startsWith('/')) return true;

    // Windows absolute path (C:\ or C:/)
    return !!path.match(/^[A-Za-z]:[\/\\]/);
}

/**
 * Check if a file has a supported extension
 *
 * @param filePath - File path to check
 * @returns true if file has supported extension
 * @internal
 */
function hasSupportedExtension(filePath: string): boolean
{
    if (DECLARATION_PATTERN.test(filePath)) return false;

    return SUPPORTED_EXTENSIONS.some(ext => filePath.endsWith(ext));
}

/**
 * Filter out barrel files (re-export aggregators) from file list
 *
 * @param files - Array of file paths
 * @returns Filtered array without barrel files
 * @internal
 */
function filterBarrelFiles(files: string[]): string[]
{
    return files.filter(file => !isBarrelFile(file));
}

/**
 * stat (following symlinks) that answers undefined for anything it cannot
 * stat — a dangling symlink, a permission error — instead of throwing
 *
 * @internal
 */
function safeStat(path: string): Stats | undefined
{
    try
    {
        return statSync(path);
    }
    catch
    {
        return undefined;
    }
}

/**
 * Directory entries, or none for a directory that cannot be read
 *
 * @internal
 */
function safeReaddir(dir: string): string[]
{
    try
    {
        return readdirSync(dir);
    }
    catch
    {
        return [];
    }
}

/**
 * A directory tree walk: supported files and the directories seen, at most
 * `maxDepth` levels down (1 = the directory itself). Symlinks are followed
 * the way drizzle-kit's glob follows them: a symlinked directory is read one
 * level deep and not descended further, so two paths to one directory both
 * appear and a link cycle ends. A directory already on the current path
 * (by real path) is not entered again.
 *
 * @internal
 */
interface Walk
{
    files: string[];
    directories: string[];
}

function walkDirectory(dir: string, maxDepth: number, ancestors: Set<string> = new Set()): Walk
{
    const walk: Walk = { files: [], directories: [] };

    if (maxDepth < 1 || !safeStat(dir)?.isDirectory()) return walk;

    const realDir = realpathSafe(dir);

    if (ancestors.has(realDir)) return walk;

    const chain = new Set(ancestors).add(realDir);

    for (const entry of safeReaddir(dir))
    {
        const path = join(dir, entry);
        const stat = safeStat(path);

        if (stat?.isFile() && hasSupportedExtension(path))
        {
            walk.files.push(path);
        }
        else if (stat?.isDirectory() && !SKIPPED_DIRECTORIES.test(entry))
        {
            walk.directories.push(path);

            const isLink = isSymlink(path);
            const child = walkDirectory(path, isLink ? Math.min(maxDepth - 1, 1) : maxDepth - 1, chain);

            for (const file of child.files) walk.files.push(file);
            for (const sub of child.directories) walk.directories.push(sub);
        }
    }

    return walk;
}

function isSymlink(path: string): boolean
{
    try
    {
        return lstatSync(path).isSymbolicLink();
    }
    catch
    {
        return false;
    }
}

function realpathSafe(path: string): string
{
    try
    {
        return realpathSync(path);
    }
    catch
    {
        return path;
    }
}

/**
 * Supported files under a directory, at most `maxDepth` levels down
 *
 * @internal
 */
function scanDirectory(dir: string, maxDepth: number): string[]
{
    return walkDirectory(dir, maxDepth).files;
}

/**
 * A schema entry relative to cwd in POSIX form, with parentheses escaped so
 * micromatch reads them as path characters, the way drizzle-kit's glob does
 *
 * @internal
 */
function toRelativePattern(entry: string, cwd: string): string
{
    return toPosixPath(isAbsolutePath(entry) ? relative(cwd, entry) : entry)
        .replace(/^\.\//, '')
        .replace(/[()]/g, '\\$&');
}

/**
 * Expand a glob the way drizzle-kit's `glob` does: `**`, `*`, `?`, `{a,b}`
 * and `[…]` are glob syntax, parentheses are literal, a matched directory
 * is read one level deep. Matching is done on paths relative to cwd so the
 * project's own directory names never enter the pattern, and the walk goes
 * only as deep as the pattern can match.
 *
 * @internal
 */
function expandGlob(pattern: string, cwd: string): string[]
{
    const scan = mm.scan(pattern);
    const depth = scan.isGlobstar || scan.glob.includes('**') ? Infinity : scan.glob.split('/').length;
    const base = join(cwd, scan.base.replace(/\\([()])/g, '$1'));
    const matches = mm.matcher(pattern);
    const matched = (path: string): boolean => matches(toPosixPath(relative(cwd, path)));
    const walk = walkDirectory(base, depth);

    // A directory the glob matches is read one level deep, and a file reached
    // both ways counts once, as in drizzle-kit
    return Array.from(new Set([...walk.files.filter(matched), ...walk.directories.filter(matched).flatMap(dir => scanDirectory(dir, 1))]));
}

/**
 * Expand one schema entry to the files drizzle-kit loads from it: a glob to
 * its matches, a directory to the files directly inside it, a file to itself.
 * Nothing is filtered — a barrel named explicitly is the entry point exactly
 * as drizzle-kit reads it from a drizzle.config.ts.
 *
 * @internal
 */
function expandSchemaEntry(entry: string, cwd: string): string[]
{
    const pattern = toRelativePattern(entry, cwd);

    if (mm.scan(pattern).isGlob)
    {
        return expandGlob(pattern, cwd);
    }

    const path = isAbsolutePath(entry) ? entry : join(cwd, entry);
    const stat = safeStat(path);

    if (!stat) return [];

    // A directory entry is read one level deep, the way drizzle-kit reads it
    return stat.isDirectory() ? scanDirectory(path, 1) : [path];
}

/**
 * Schema selection: the entries, where they came from, the files when the
 * selection already had to expand them, and the registry left aside
 *
 * @internal
 */
interface SchemaSelection
{
    schemas: string[];
    source: string;
    files?: string[];
    registry?: string;
}

/**
 * Default schema when none is given: the entities folder scan, barrels
 * excluded. When the scan finds no entity file — the folder holds only the
 * registry and the tables live elsewhere — the registry named by env
 * `DRIZZLE_SCHEMA_PATH` (default `src/server/entities/config.ts`) is loaded
 * alone. When both exist, the scan is chosen here and the registry is
 * reported alongside, so a caller that can load modules may check whether
 * the registry exports a table the scanned files do not.
 *
 * @internal
 */
function selectDefaultSchema(cwd: string): SchemaSelection
{
    const registry = env.DRIZZLE_SCHEMA_PATH;
    const registryFile = isAbsolutePath(registry) ? registry : join(cwd, registry);
    const registryExists = safeStat(registryFile)?.isFile() === true;
    const scanned = filterBarrelFiles(expandSchemaEntry(DEFAULT_ENTITY_GLOB, cwd));

    if (scanned.length === 0 && registryExists)
    {
        return { schemas: [registry], source: `entity registry ${registry}` };
    }

    return {
        schemas: [DEFAULT_ENTITY_GLOB],
        source: `${DEFAULT_ENTITY_GLOB} scan`,
        files: scanned,
        registry: registryExists ? registry : undefined,
    };
}

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface DrizzleConfigOptions
{
    /** Database connection URL (defaults to process.env.DATABASE_URL) */
    databaseUrl?: string;

    /** Schema entry file(s), directories or glob pattern(s). Default: './src/server/entities/\*\*\/*.ts', or the registry `DRIZZLE_SCHEMA_PATH` (./src/server/entities/config.ts) when that scan finds no entity file; `schemaRegistry` reports the registry when both exist */
    schema?: string | string[];

    /** Migration output directory (defaults to './src/server/drizzle') */
    out?: string;

    /** Database dialect (auto-detected from URL if not provided) */
    dialect?: 'postgresql' | 'mysql' | 'sqlite';

    /** Current working directory for discovering package schemas */
    cwd?: string;

    /** Disable automatic package schema discovery */
    disablePackageDiscovery?: boolean;

    /** Only include schemas from specific package (e.g., '@spfn/cms') */
    packageFilter?: string;

    /** Expand glob patterns to actual file paths (useful for Drizzle Studio) */
    expandGlobs?: boolean;

    /** PostgreSQL schema filter for push/introspect commands */
    schemaFilter?: string[];

    /** Migration prefix strategy (default: 'timestamp') */
    migrationPrefix?: 'index' | 'timestamp' | 'unix' | 'none';
}

/**
 * Discover schema paths from installed packages
 * Only scans packages that:
 * 1. Are in @spfn scope
 * 2. Are direct dependencies with "spfn" keyword or "spfn" field in package.json
 */
function discoverPackageSchemas(cwd: string): string[]
{
    const schemas: string[] = [];
    const nodeModulesPath = join(cwd, 'node_modules');

    if (!existsSync(nodeModulesPath))
    {
        return schemas;
    }

    // Get direct dependencies from project's package.json
    const projectPkgPath = join(cwd, 'package.json');
    let directDeps: Set<string> = new Set();

    if (existsSync(projectPkgPath))
    {
        try
        {
            const projectPkg = JSON.parse(readFileSync(projectPkgPath, 'utf-8'));
            directDeps = new Set([
                ...Object.keys(projectPkg.dependencies || {}),
                ...Object.keys(projectPkg.devDependencies || {}),
            ]);
        }
        catch (error: unknown)
        {
            // If we can't read project package.json, just scan @spfn packages
            // Silent skip is intentional - we continue with @spfn package discovery
        }
    }

    const checkPackage = (_pkgName: string, pkgPath: string) =>
    {
        const pkgJsonPath = join(pkgPath, 'package.json');

        if (!existsSync(pkgJsonPath)) return;

        try
        {
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

            // Check if package has schema declarations
            if (pkgJson.spfn?.schemas)
            {
                const packageSchemas = Array.isArray(pkgJson.spfn.schemas)
                    ? pkgJson.spfn.schemas
                    : [pkgJson.spfn.schemas];

                // Convert to absolute paths from package root and expand globs
                for (const schema of packageSchemas)
                {
                    const absolutePath = join(pkgPath, schema);

                    // Expand glob patterns to actual file lists
                    // This prevents drizzle-kit from hanging on glob patterns.
                    // A package's barrel re-exports its entity files: drop it.
                    schemas.push(...filterBarrelFiles(expandSchemaEntry(absolutePath, pkgPath)));
                }
            }
        }
        catch (error: unknown)
        {
            // Skip packages with invalid package.json
            // Silent skip is intentional - we continue checking other packages
        }
    };

    // 1. Always scan @spfn/* packages
    const spfnDir = join(nodeModulesPath, '@spfn');
    if (existsSync(spfnDir))
    {
        try
        {
            const spfnPackages = readdirSync(spfnDir);
            for (const pkg of spfnPackages)
            {
                checkPackage(`@spfn/${pkg}`, join(spfnDir, pkg));
            }
        }
        catch (error: unknown)
        {
            // Skip if can't read @spfn directory
            // Silent skip is intentional - we continue with direct dependencies
        }
    }

    // 2. Check direct dependencies for SPFN integration
    for (const depName of directDeps)
    {
        // Skip if already checked (@spfn/* packages)
        if (depName.startsWith('@spfn/')) continue;

        // Resolve package path (handle scoped packages)
        const pkgPath = depName.startsWith('@')
            ? join(nodeModulesPath, ...depName.split('/'))
            : join(nodeModulesPath, depName);

        checkPackage(depName, pkgPath);
    }

    return schemas;
}

/**
 * Detect database dialect from connection URL
 */
export function detectDialect(url: string): 'postgresql' | 'mysql' | 'sqlite'
{
    if (url.startsWith('postgres://') || url.startsWith('postgresql://'))
    {
        return 'postgresql';
    }

    if (url.startsWith('mysql://'))
    {
        return 'mysql';
    }

    if (url.startsWith('sqlite://') || url.includes('.db') || url.includes('.sqlite'))
    {
        return 'sqlite';
    }

    throw new Error(
        `Unsupported database URL format: ${url}. Supported: postgresql://, mysql://, sqlite://`,
    );
}

/**
 * Generate Drizzle Kit configuration
 *
 * @param options - Configuration options
 * @returns Drizzle Kit configuration object
 *
 * @example
 * ```ts
 * // Zero-config (reads from process.env.DATABASE_URL)
 * const config = getDrizzleConfig();
 *
 * // Custom config
 * const config = getDrizzleConfig({
 *   databaseUrl: 'postgresql://localhost/mydb',
 *   schema: './src/db/schema/*.ts',
 *   out: './migrations',
 * });
 * ```
 */
export function getDrizzleConfig(options: DrizzleConfigOptions = {})
{
    const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;

    if (!databaseUrl)
    {
        throw new Error(
            'DATABASE_URL is required. Set it in .env or pass it to getDrizzleConfig()',
        );
    }

    const dialect = options.dialect ?? detectDialect(databaseUrl);
    const out = options.out ?? './src/server/drizzle';

    // If packageFilter is specified, only include that package's schemas
    if (options.packageFilter)
    {
        const packageSchemas = options.disablePackageDiscovery
            ? []
            : discoverPackageSchemas(options.cwd ?? process.cwd());

        // Filter to only the specified package
        const filteredSchemas = packageSchemas.filter(schemaPath =>
            toPosixPath(schemaPath).includes(`node_modules/${options.packageFilter}/`),
        );

        if (filteredSchemas.length === 0)
        {
            throw new Error(
                `No schemas found for package ${options.packageFilter}. ` +
                `Make sure the package is installed and has "spfn.schemas" in package.json.`,
            );
        }

        const schema = filteredSchemas.length === 1 ? filteredSchemas[0] : filteredSchemas;

        return {
            schema,
            schemaSource: `package ${options.packageFilter}`,
            schemaRegistry: undefined as string | undefined,
            out,
            dialect,
            dbCredentials: getDbCredentials(dialect, databaseUrl),
            migrations: {
                prefix: options.migrationPrefix ?? 'timestamp',
            },
        };
    }

    // The user's schema, or the default selection; then package schemas
    const cwd = options.cwd ?? process.cwd();
    const selection: SchemaSelection = options.schema
        ? { schemas: Array.isArray(options.schema) ? options.schema : [options.schema], source: 'schema option' }
        : selectDefaultSchema(cwd);
    const schemaSource = selection.source;
    const schemaRegistry = selection.registry;

    // Discover package schemas unless disabled
    const packageSchemas = options.disablePackageDiscovery
        ? []
        : discoverPackageSchemas(cwd);

    // Expand to the files drizzle-kit loads (useful for Drizzle Studio); package
    // schemas are already files
    const allSchemas = options.expandGlobs
        ? [...(selection.files ?? selection.schemas.flatMap(entry => expandSchemaEntry(entry, cwd))), ...packageSchemas]
        : [...selection.schemas, ...packageSchemas];

    const schema = allSchemas.length === 1 ? allSchemas[0] : allSchemas;

    // PostgreSQL schemaFilter is taken as given; the CLI derives one from the loaded modules
    const schemaFilter = dialect === 'postgresql' ? options.schemaFilter : undefined;

    return {
        schema,
        schemaSource,
        schemaRegistry,
        out,
        dialect,
        dbCredentials: getDbCredentials(dialect, databaseUrl),
        schemaFilter,
        migrations: {
            prefix: options.migrationPrefix ?? 'timestamp',
        },
    };
}

/**
 * Get database credentials based on dialect
 */
function getDbCredentials(dialect: string, url: string)
{
    switch (dialect)
    {
        case 'postgresql':
        case 'mysql':
            return { url };

        case 'sqlite':
            // Extract file path from sqlite:// URL
            const dbPath = url.replace('sqlite://', '').replace('sqlite:', '');

            return { url: dbPath };

        default:
            throw new Error(`Unsupported dialect: ${dialect}`);
    }
}

/**
 * The schema fields a rendered drizzle.config.ts needs
 */
export interface RenderableDrizzleConfig
{
    schema: string | string[];
    out: string;
    dialect: string;
    dbCredentials: Record<string, unknown>;
    schemaFilter?: string[];
    migrations?: Record<string, unknown>;
}

/**
 * Render an already-resolved config as drizzle.config.ts source, schema
 * paths made absolute for Drizzle Studio
 *
 * @param config - Result of getDrizzleConfig, possibly with the schema replaced
 * @param cwd - Base for relative schema paths (default: process.cwd())
 */
export function renderDrizzleConfig(config: RenderableDrizzleConfig, cwd: string = process.cwd()): string
{

    // Convert schema paths to absolute paths for Drizzle Studio compatibility
    const normalizeSchemaPath = (schemaPath: string): string =>
    {
        // If already absolute, return as-is
        if (isAbsolutePath(schemaPath))
        {
            return schemaPath;
        }

        // Convert relative to absolute
        return join(cwd, schemaPath);
    };

    // Format schema value (handle both string and array)
    const schemaValue = Array.isArray(config.schema)
        ? `[\n        ${config.schema.map(s => `'${normalizeSchemaPath(s)}'`).join(',\n        ')}\n    ]`
        : `'${normalizeSchemaPath(config.schema as string)}'`;

    // Format schemaFilter if present
    const schemaFilterLine = config.schemaFilter && config.schemaFilter.length > 0
        ? `\n    schemaFilter: ${JSON.stringify(config.schemaFilter)},`
        : '';

    // Format migrations if present
    const migrationsLine = config.migrations
        ? `\n    migrations: ${JSON.stringify(config.migrations)},`
        : '';

    return `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: ${schemaValue},
    out: '${config.out}',
    dialect: '${config.dialect}',
    dbCredentials: ${JSON.stringify(config.dbCredentials, null, 4)},${schemaFilterLine}${migrationsLine}
});
`;
}

/**
 * Generate drizzle.config.ts source from options: resolve the config, then render it
 *
 * @param options - Configuration options (see getDrizzleConfig)
 * @returns drizzle.config.ts source
 */
export function generateDrizzleConfigFile(options: DrizzleConfigOptions = {}): string
{
    return renderDrizzleConfig(getDrizzleConfig(options), options.cwd ?? process.cwd());
}
