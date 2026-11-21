/**
 * `spfn init` step: the project's configuration and environment files.
 *
 * The environment reference is split by consumer, never combined. `.env.local`
 * and its committed `.env.local.example` hold what the Next.js process reads —
 * `SPFN_API_URL`, `NEXT_PUBLIC_*`, and the session secret its proxy verifies
 * cookies with. `.env.server` and `.env.server.example` hold what only the SPFN
 * backend reads — `DATABASE_URL`, `CACHE_URL`, OAuth and token secrets — and
 * Next.js never loads them. A key's file is decided by who consumes it, not by
 * whether it is secret: the session secret is secret and still belongs in
 * `.env.local`, because Next.js is what needs it.
 */

import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'path';
import fse from 'fs-extra';
import { logger } from '../../../utils/logger.js';
import { envKeyOf, collectDeclaredKeys, gitignoreCovers, restrictEnvFilePerms } from '../../../utils/env-file.js';
import type { ScaffoldMode } from '../mode.js';

const { writeFileSync } = fse;

// .env.local template — values required by the Next.js process.
const ENV_LOCAL_TEMPLATE = `# Next.js environment
# Loaded by Next.js (and the SPFN backend). Never prefix secrets with
# NEXT_PUBLIC_. Backend-only secrets belong in .env.server.

# SPFN API endpoint — browser + Next.js SSR/proxy target
SPFN_API_URL=http://localhost:8790
NEXT_PUBLIC_SPFN_API_URL=http://localhost:8790

# Next.js app URL (used by the SPFN server for CORS/redirects)
SPFN_APP_URL=http://localhost:3790
`;

// A new app has no legacy clients to break, so it starts enforcing rather than
// warning: the Next.js proxy refuses a cookie-session mutation that arrives
// without the CSRF header. Unset, the framework only warns.
const CSRF_ENV_LINES = `# CSRF for cookie-session mutations: off | warn | enforce (unset = warn)
SPFN_AUTH_CSRF=enforce`;

const FULL_ENV_LOCAL_EXAMPLE = `
# Full scaffold: auth session encryption (Next.js server only; never NEXT_PUBLIC_*)
SPFN_AUTH_SESSION_SECRET=replace-with-a-random-secret-at-least-32-characters
SPFN_AUTH_SESSION_TTL=7d
${CSRF_ENV_LINES}
NEXT_PUBLIC_SPFN_APP_URL=http://localhost:3790
`;

// .env.server template — SPFN backend only; secrets live here, never loaded by Next.js.
const ENV_SERVER_TEMPLATE = `# SPFN backend environment
# Loaded ONLY by the SPFN server, never by Next.js. Keep all server-only config
# and secrets here so they never reach the Next.js process.

# Environment
NODE_ENV=local

# Logging
SPFN_LOG_LEVEL=info

# Database (matches docker-compose.yml) — secret, server-only
DATABASE_URL=postgresql://spfn:spfn@localhost:5432/spfn_dev

# Cache — Redis/Valkey (optional)
CACHE_URL=redis://localhost:6379

# Database pool
DB_POOL_MAX=10
DB_POOL_IDLE_TIMEOUT=30

# --- Optional secrets (uncomment and set as needed) ---
# DATABASE_WRITE_URL=postgresql://user:password@master:5432/dbname
# DATABASE_READ_URL=postgresql://user:password@replica:5432/dbname
# CACHE_PASSWORD=your-redis-password
`;

const FULL_ENV_SERVER_EXAMPLE = `
# Full scaffold: authentication
SPFN_AUTH_VERIFICATION_TOKEN_SECRET=replace-with-a-random-secret-at-least-32-characters
SPFN_AUTH_TOKEN_ENCRYPTION_KEYS=v1:replace-with-a-base64-encoded-32-byte-key

# Enable the social providers you need.
# SPFN_AUTH_GOOGLE_CLIENT_ID=your-google-client-id
# SPFN_AUTH_GOOGLE_CLIENT_SECRET=your-google-client-secret
# SPFN_AUTH_GITHUB_CLIENT_ID=your-github-client-id
# SPFN_AUTH_GITHUB_CLIENT_SECRET=your-github-client-secret
# SPFN_AUTH_KAKAO_CLIENT_ID=your-kakao-rest-api-key
# SPFN_AUTH_KAKAO_CLIENT_SECRET=your-kakao-client-secret
# SPFN_AUTH_NAVER_CLIENT_ID=your-naver-client-id
# SPFN_AUTH_NAVER_CLIENT_SECRET=your-naver-client-secret

# Full scaffold: ops CLI (spfn ops)
# Ops commands need no variable of their own — they authenticate with a token
# issued by \`spfn ops token issue\`, and issuing one signs in as an administrator.
# Uncomment to seed that administrator on the next server start, then remove the
# password once the account exists.
# SPFN_AUTH_ADMIN_ACCOUNTS=[{"email":"admin@example.com","password":"replace-with-a-strong-password","role":"admin"}]
`;

/**
 * The backend template's keys, commented-out ones included — every variable that
 * must never appear in a file the Next.js process loads. Exported so the
 * placement test can check the scaffold and the examples against one list
 * instead of restating it and drifting from the templates.
 */
export function serverOnlyEnvKeys(): string[]
{
    return [...collectDeclaredKeys(`${ENV_SERVER_TEMPLATE}${FULL_ENV_SERVER_EXAMPLE}`)];
}

/**
 * Committed backend reference. Placeholdered because it is committed
 * (CONTRIBUTING.md hard rule #4) and never carries a generated secret.
 */
function envServerExampleTemplate(mode: ScaffoldMode): string
{
    return withPlaceholderCreds(
        `${ENV_SERVER_TEMPLATE}${mode === 'full' ? FULL_ENV_SERVER_EXAMPLE : ''}`,
    );
}

function envLocalTemplate(mode: ScaffoldMode): string
{
    if (mode === 'bare')
    {
        return ENV_LOCAL_TEMPLATE;
    }

    return `${ENV_LOCAL_TEMPLATE}
# Full scaffold: auth session encryption (Next.js server only; never NEXT_PUBLIC_*)
SPFN_AUTH_SESSION_SECRET=${randomSecret('base64url')}
SPFN_AUTH_SESSION_TTL=7d
${CSRF_ENV_LINES}
NEXT_PUBLIC_SPFN_APP_URL=http://localhost:3790
`;
}

/**
 * Committed Next.js reference — the counterpart of envServerExampleTemplate, and
 * placeholdered on the same rule.
 */
function envLocalExampleTemplate(mode: ScaffoldMode): string
{
    return withPlaceholderCreds(
        `${ENV_LOCAL_TEMPLATE}${mode === 'full' ? FULL_ENV_LOCAL_EXAMPLE : ''}`,
    );
}

function envServerTemplate(mode: ScaffoldMode): string
{
    if (mode === 'bare')
    {
        return ENV_SERVER_TEMPLATE;
    }

    return `${ENV_SERVER_TEMPLATE}
# Full scaffold: authentication
SPFN_AUTH_VERIFICATION_TOKEN_SECRET=${randomSecret('base64url')}
SPFN_AUTH_TOKEN_ENCRYPTION_KEYS=v1:${randomSecret('base64')}

# Enable the social providers you need.
# SPFN_AUTH_GOOGLE_CLIENT_ID=your-google-client-id
# SPFN_AUTH_GOOGLE_CLIENT_SECRET=your-google-client-secret
# SPFN_AUTH_GITHUB_CLIENT_ID=your-github-client-id
# SPFN_AUTH_GITHUB_CLIENT_SECRET=your-github-client-secret
# SPFN_AUTH_KAKAO_CLIENT_ID=your-kakao-rest-api-key
# SPFN_AUTH_KAKAO_CLIENT_SECRET=your-kakao-client-secret
# SPFN_AUTH_NAVER_CLIENT_ID=your-naver-client-id
# SPFN_AUTH_NAVER_CLIENT_SECRET=your-naver-client-secret

# Full scaffold: ops CLI (spfn ops)
# Ops commands need no variable of their own — they authenticate with a token
# issued by \`spfn ops token issue\`, and issuing one signs in as an administrator.
# Uncomment to seed that administrator on the next server start, then remove the
# password once the account exists.
# SPFN_AUTH_ADMIN_ACCOUNTS=[{"email":"admin@example.com","password":"replace-with-a-strong-password","role":"admin"}]
`;
}

function randomSecret(encoding: 'base64' | 'base64url'): string
{
    return randomBytes(32).toString(encoding);
}

/**
 * Replace concrete DB credentials with a placeholder, for any example file that
 * may be committed (CONTRIBUTING.md hard rule #4: committed *.example carry placeholders).
 */
function withPlaceholderCreds(text: string): string
{
    return text.replace(/(postgresql:\/\/)[^@\s/]+@/g, '$1user:password@');
}

/**
 * Setup configuration files:
 * - .env.local (values needed by Next.js, including the full-mode session secret; gitignored)
 * - .env.server (SPFN backend env + secrets: DB, cache, pool — never loaded by Next.js, gitignored)
 * - .env.local.example and .env.server.example (committed, placeholder-only references,
 *   one per consumer, so a reader always knows which file a key belongs in)
 * - .spfnrc.ts (codegen configuration)
 * - .gitignore (add .spfn directory, env patterns, the temporary drizzle config)
 * - tsconfig.json (exclude src/server for Vercel)
 */
export async function setupConfigFiles(cwd: string, mode: ScaffoldMode): Promise<void>
{
    // Update .gitignore first so the secret-bearing .env.server is written under
    // an existing ignore rule, never tracked even briefly.
    updateGitignore(cwd);
    generateEnvFiles(cwd, mode);

    // Create .spfnrc.ts for codegen configuration
    const spfnrcPath = join(cwd, '.spfnrc.ts');
    if (!existsSync(spfnrcPath))
    {
        const spfnrcContent = `import { defineConfig, defineGenerator } from '@spfn/core/codegen';

/**
 * SPFN Codegen Configuration
 *
 * Configure code generators here. Generators run during \`spfn dev\` and \`spfn codegen run\`.
 */

export default defineConfig({
    generators: [
        // Route map generator - generates routeName → {method, path} mappings
        // Used by RPC proxy to resolve routes without importing server code
        defineGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: './src/generated/route-map.ts',
        }),
    ]
});
`;
        writeFileSync(spfnrcPath, spfnrcContent);
        logger.success('Created .spfnrc.ts (codegen configuration)');
    }

    updateTsconfig(cwd);
}

/**
 * Generate the env files, split by which process loads them.
 *
 * .env.local is loaded by Next.js (and also the SPFN backend), so it holds URLs
 * plus secrets Next.js itself needs, such as auth cookie encryption. .env.server
 * is loaded ONLY by the SPFN backend and holds DB and OAuth secrets. Both are
 * gitignored; secrets are never prefixed NEXT_PUBLIC_.
 *
 * The two committed references come first, so the warning a conflicting real file
 * triggers can point at a reference that is already on disk.
 */
function generateEnvFiles(cwd: string, mode: ScaffoldMode): void
{
    writeReferenceEnv(cwd, '.env.local.example', envLocalExampleTemplate(mode));
    writeReferenceEnv(cwd, '.env.server.example', envServerExampleTemplate(mode));

    // Create .env.local or merge only absent keys, preserving user values.
    writeLocalEnv(cwd, envLocalTemplate(mode));
    writeServerEnv(cwd, envServerTemplate(mode));
}

/**
 * Write or extend .env.local only when Git does not track it. Adding generated
 * secrets to a tracked file would make the next commit leak them even after an
 * ignore rule is added, because .gitignore never untracks an indexed file.
 */
function writeLocalEnv(cwd: string, template: string): void
{
    const filename = '.env.local';
    const filePath = join(cwd, filename);

    if (isGitTracked(cwd, filename))
    {
        logger.warn(`${filename} is tracked by Git — left it untouched; its keys are listed in .env.local.example. Untrack ${filename}, then add the missing keys with freshly generated values`);

        return;
    }

    writeEnvFile(cwd, filename, template);
    restrictEnvFilePerms(filePath);
}

function isGitTracked(cwd: string, filename: string): boolean
{
    const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', filename], {
        cwd,
        stdio: 'ignore',
    });

    return result.status === 0;
}

/**
 * Write .env.server only when absent. If the user already has one it holds their
 * real secrets, so never touch it — point them at the .env.server.example written
 * above and let them reconcile the keys themselves.
 */
function writeServerEnv(cwd: string, template: string): void
{
    const filePath = join(cwd, '.env.server');

    if (!existsSync(filePath))
    {
        writeFileSync(filePath, template);
        restrictEnvFilePerms(filePath);
        logger.success('Created .env.server');

        return;
    }

    logger.warn('.env.server already exists — left it untouched; SPFN\'s reference is in .env.server.example, add any missing keys manually');
}

/**
 * Write a committed reference file, but never clobber one the project already has:
 * an older scaffold's or a hand-maintained reference is the user's to keep.
 */
function writeReferenceEnv(cwd: string, filename: string, content: string): void
{
    const filePath = join(cwd, filename);

    if (existsSync(filePath))
    {
        return;
    }

    writeFileSync(filePath, content);
    logger.success(`Created ${filename} (committed reference)`);
}

/**
 * Write .env.local, or merge any missing SPFN keys into an existing one.
 */
function writeEnvFile(cwd: string, filename: string, content: string): void
{
    const filePath = join(cwd, filename);

    if (!existsSync(filePath))
    {
        writeFileSync(filePath, content);
        logger.success(`Created ${filename}`);

        return;
    }

    mergeMissingEnvKeys(filePath, filename, content);
}

/**
 * Append the assignment lines from `template` whose keys are absent from the
 * existing file, preserving everything the user already has.
 */
function mergeMissingEnvKeys(filePath: string, filename: string, template: string): void
{
    const existing = readFileSync(filePath, 'utf-8');
    // Count commented keys as present too: a user who commented out DATABASE_URL
    // did so deliberately — don't re-append an active default over their choice.
    const existingKeys = collectDeclaredKeys(existing);

    const missing = template
        .split('\n')
        .filter((line) =>
        {
            const key = envKeyOf(line);

            return key !== null && !existingKeys.has(key);
        });

    if (missing.length === 0)
    {
        return;
    }

    const block = `\n# Added by spfn init\n${missing.join('\n')}\n`;
    writeFileSync(filePath, existing.replace(/\n*$/, '\n') + block);
    logger.success(`Updated ${filename} (added ${missing.length} SPFN key(s))`);
}

/**
 * Update .gitignore with SPFN patterns, creating the file if it doesn't exist.
 *
 * The env files generated above are real, secret-bearing files (.env.server holds
 * DB/cache credentials), so the ignore rules must be guaranteed even in a project
 * that ships without a .gitignore.
 */
function updateGitignore(cwd: string): void
{
    const gitignorePath = join(cwd, '.gitignore');
    const existed = existsSync(gitignorePath);

    try
    {
        const content = existed ? readFileSync(gitignorePath, 'utf-8') : '';
        const additions = pendingIgnoreRules(content);

        if (additions.length === 0)
        {
            return;
        }

        writeFileSync(gitignorePath, content + additions.join(''));
        logger.success(existed
            ? 'Updated .gitignore with .spfn directory and env patterns'
            : 'Created .gitignore with .spfn directory and env patterns');
    }
    catch
    {
        logger.warn('Could not update .gitignore — add .env.local and .env.server manually before committing, so the generated .env.server secrets are not tracked');
    }
}

/**
 * The ignore blocks not already covered by the .gitignore, ready to append.
 */
function pendingIgnoreRules(content: string): string[]
{
    const lines = content.split('\n');
    const rules: string[] = [];

    if (!gitignoreCovers(lines, '.spfn'))
    {
        rules.push('\n# spfn\n/.spfn/\n');
    }

    if (!gitignoreCovers(lines, '.env.local'))
    {
        rules.push('\n# environment secrets (local overrides)\n.env.local\n');
    }

    // Checked independently: a project may already ignore .env.local but not the
    // .env.*.local glob (e.g. a future .env.production.local with real secrets).
    if (!gitignoreCovers(lines, '.env.*.local'))
    {
        rules.push('\n# environment secrets (env-specific local overrides)\n.env.*.local\n');
    }

    if (!gitignoreCovers(lines, '.env.server'))
    {
        rules.push('\n# spfn server env (secrets)\n.env.server\n');
    }

    // `spfn db generate`, `check` and `studio` write one when the project has
    // no drizzle.config.ts and remove it on exit; a SIGKILL leaves it behind,
    // with a database URL in it.
    if (!gitignoreCovers(lines, 'drizzle.config.*.temp.ts'))
    {
        rules.push('\n# spfn db temporary drizzle config (holds a database URL)\ndrizzle.config.*.temp.ts\n');
    }

    // Keep the committed references tracked even when a broad `.env*` glob
    // (create-next-app ships one) would otherwise ignore them. Checked
    // independently: a project may already negate one name and not the other.
    if (!lines.some((line) => line.trim() === '!.env.local.example'))
    {
        rules.push('\n# spfn env reference, Next.js keys (committed)\n!.env.local.example\n');
    }

    if (!lines.some((line) => line.trim() === '!.env.server.example'))
    {
        rules.push('\n# spfn env reference, backend keys (committed)\n!.env.server.example\n');
    }

    return rules;
}

/**
 * Update tsconfig.json to exclude src/server
 */
function updateTsconfig(cwd: string): void
{
    const tsconfigPath = join(cwd, 'tsconfig.json');

    if (!existsSync(tsconfigPath))
    {
        return;
    }

    try
    {
        const tsconfigContent = readFileSync(tsconfigPath, 'utf-8');
        const tsconfig = JSON.parse(tsconfigContent);

        if (!tsconfig.exclude)
        {
            tsconfig.exclude = [];
        }

        if (!tsconfig.exclude.includes('src/server'))
        {
            tsconfig.exclude.push('src/server');
            writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
            logger.success('Updated tsconfig.json (excluded src/server for Vercel compatibility)');
        }
    }
    catch
    {
        logger.warn('Could not update tsconfig.json (you can add "src/server" to exclude manually)');
    }
}
