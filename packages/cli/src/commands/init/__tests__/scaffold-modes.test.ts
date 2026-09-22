import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupApiProxy } from '../steps/api-proxy.js';
import { setupConfigFiles } from '../steps/config-files.js';
import { setupServerStructure } from '../steps/server-structure.js';
import type { ScaffoldMode } from '../mode.js';

const spinner = {
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn(),
    fail: vi.fn(),
};

vi.mock('ora', () => ({ default: () => spinner }));

let testDirectory: string | undefined;

afterEach(async () =>
{
    vi.clearAllMocks();
    if (testDirectory)
    {
        await rm(testDirectory, { recursive: true, force: true });
        testDirectory = undefined;
    }
});

describe('scaffold modes', () =>
{
    it('scaffolds a core-only bare application', async () =>
    {
        const directory = await scaffold('bare');
        const router = await readFile(join(directory, 'src/server/router.ts'), 'utf8');
        const proxy = await readFile(
            join(directory, 'src/app/api/rpc/[routeName]/route.ts'),
            'utf8',
        );
        const localExample = await readFile(join(directory, '.env.local.example'), 'utf8');

        expect(router).not.toContain('@spfn/auth');
        expect(router).not.toContain('opsRouter');
        expect(proxy).toContain('createRpcProxy({ routeMap })');
        expect(proxy).not.toContain('authRouteMap');
        expect(localExample).not.toContain('SPFN_AUTH_SESSION_SECRET');
        await expect(readFile(join(directory, 'src/server/routes/ops.ts'), 'utf8'))
            .rejects.toThrow();
    });

    it('scaffolds auth, i18n, and the ops surface as a working full baseline', async () =>
    {
        const directory = await scaffold('full');
        const router = await readFile(join(directory, 'src/server/router.ts'), 'utf8');
        const serverConfig = await readFile(join(directory, 'src/server/server.config.ts'), 'utf8');
        const proxy = await readFile(
            join(directory, 'src/app/api/rpc/[routeName]/route.ts'),
            'utf8',
        );
        const localEnv = await readFile(join(directory, '.env.local'), 'utf8');
        const serverEnv = await readFile(join(directory, '.env.server'), 'utf8');
        const localExample = await readFile(join(directory, '.env.local.example'), 'utf8');
        const serverExample = await readFile(join(directory, '.env.server.example'), 'utf8');

        expect(router).toContain('.packages([authRouter, opsRouter])');
        expect(router).toContain('.use([authenticate])');
        expect(serverConfig).toContain('.lifecycle(createAuthLifecycle())');
        expect(serverConfig).toContain("import '@/i18n/server'");
        expect(proxy).toContain("import '@spfn/auth/nextjs/api'");
        // No map is merged by hand: the generated one carries the routes of
        // every package router `.packages()` mounts, `@spfn/auth`'s included.
        expect(proxy).toContain('createRpcProxy({ routeMap })');
        expect(proxy).not.toContain('authRouteMap');
        const ops = await readFile(join(directory, 'src/server/routes/ops.ts'), 'utf8');
        expect(ops).toContain("from '@spfn/core/ops'");
        expect(ops).toContain('createOpsRouter(');
        expect(ops).toContain('auth: opsTokenAuth');
        // Ops needs no env variable, so full mode keeps the core env template
        // instead of shipping a profile-specific one.
        expect(await readFile(join(directory, 'src/server/config/env.config.ts'), 'utf8'))
            .toContain('defineEnvSchema({');
        expect(await readFile(join(directory, 'src/i18n/catalogs.ts'), 'utf8'))
            .toContain('LocaleCatalogs');
        expect(await readFile(join(directory, 'src/app/auth/callback/page.tsx'), 'utf8'))
            .toContain('OAuthCallback');
        expect(await readFile(join(directory, 'src/app/login/page.tsx'), 'utf8'))
            .toContain('getProviderOAuthUrl');
        expect(localEnv).toMatch(/SPFN_AUTH_SESSION_SECRET=.{32,}/);
        // A new app has no legacy client to break, so CSRF starts enforced
        // rather than warning.
        expect(localEnv).toContain('SPFN_AUTH_CSRF=enforce');
        expect(localExample).toContain('SPFN_AUTH_CSRF=enforce');
        expect((await stat(join(directory, '.env.local'))).mode & 0o777).toBe(0o600);
        expect(serverEnv).not.toContain('SPFN_MCP_API_KEY');
        // The ops surface needs no variable — only the administrator that issues
        // the first token, offered commented out so no privileged account is
        // seeded without the operator saying so.
        expect(serverEnv).toContain('# SPFN_AUTH_ADMIN_ACCOUNTS=');
        expect(serverExample).toContain('# SPFN_AUTH_ADMIN_ACCOUNTS=');
        expect(serverEnv).toMatch(/SPFN_AUTH_VERIFICATION_TOKEN_SECRET=.{32,}/);
        expect(serverExample).not.toContain(
            serverEnv.match(/SPFN_AUTH_VERIFICATION_TOKEN_SECRET=(.+)/)?.[1] ?? 'generated-secret-not-found',
        );
    });

    it('does not append generated secrets to a tracked .env.local', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-full-tracked-env-'));
        const localEnvPath = join(testDirectory, '.env.local');
        const original = 'NEXT_PUBLIC_EXISTING=value\n';
        await writeFile(localEnvPath, original);
        execFileSync('git', ['init', '-q'], { cwd: testDirectory });
        execFileSync('git', ['add', '-f', '.env.local'], { cwd: testDirectory });

        await setupConfigFiles(testDirectory, 'full');

        await expect(readFile(localEnvPath, 'utf8')).resolves.toBe(original);
        const reference = await readFile(
            join(testDirectory, '.env.local.example'),
            'utf8',
        );
        expect(reference).toContain(
            'SPFN_AUTH_SESSION_SECRET=replace-with-a-random-secret-at-least-32-characters',
        );
    });

    it('does not overwrite app routes owned by an existing project', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-full-existing-app-'));
        const loginPath = join(testDirectory, 'src/app/login/page.tsx');
        const catalogsPath = join(testDirectory, 'src/i18n/catalogs.ts');
        await mkdir(join(testDirectory, 'src/app/login'), { recursive: true });
        await mkdir(join(testDirectory, 'src/i18n'), { recursive: true });
        await writeFile(loginPath, 'export default function ExistingLogin() {}\n');
        await writeFile(catalogsPath, 'export const existingCatalogs = {};\n');

        await setupServerStructure(testDirectory, 'full');

        await expect(readFile(loginPath, 'utf8'))
            .resolves.toContain('ExistingLogin');
        await expect(readFile(catalogsPath, 'utf8'))
            .resolves.toContain('existingCatalogs');
        await expect(readFile(join(testDirectory, 'src/app/auth/callback/page.tsx'), 'utf8'))
            .resolves.toContain('OAuthCallback');
    });
});

async function scaffold(mode: ScaffoldMode): Promise<string>
{
    testDirectory = await mkdtemp(join(tmpdir(), `spfn-${mode}-scaffold-`));
    await mkdir(join(testDirectory, 'src/app'), { recursive: true });
    await writeFile(join(testDirectory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

    await setupServerStructure(testDirectory, mode);
    await setupApiProxy(testDirectory, mode === 'full');
    await setupConfigFiles(testDirectory, mode);

    return testDirectory;
}
