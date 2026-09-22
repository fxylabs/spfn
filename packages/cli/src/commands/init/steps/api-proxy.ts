import { existsSync } from 'fs';
import { join } from 'path';
import fse from 'fs-extra';
import { logger } from '../../../utils/logger.js';

const { ensureDirSync, writeFileSync } = fse;

/**
 * Create RPC proxy route in Next.js app directory
 * Enables HttpOnly session cookies to work in client components
 */
export async function setupApiProxy(cwd: string, includeAuth: boolean): Promise<void>
{
    // Determine app directory location (src/app takes priority over app)
    const srcAppDir = join(cwd, 'src', 'app');
    const rootAppDir = join(cwd, 'app');

    let appDir: string;
    if (existsSync(srcAppDir))
    {
        appDir = srcAppDir;
    }
    else if (existsSync(rootAppDir))
    {
        appDir = rootAppDir;
    }
    else
    {
        logger.error('Next.js app directory not found. Expected src/app or app directory.');
        process.exit(1);
    }

    const rpcDir = join(appDir, 'api', 'rpc', '[routeName]');
    const rpcRoutePath = join(rpcDir, 'route.ts');

    if (existsSync(rpcRoutePath))
    {
        logger.warn(`RPC proxy route already exists, skipping: ${rpcRoutePath.replace(cwd + '/', '')}`);

        return;
    }

    ensureDirSync(rpcDir);

    // The import is a side effect and stays: it registers the auth interceptor.
    // No route map is merged beside the generated one — that one already carries
    // the routes of every package router the app mounts with `.packages()`,
    // `@spfn/auth`'s included.
    const authImports = includeAuth ? `import '@spfn/auth/nextjs/api';\n` : '';

    const routeContent = `/**
 * SPFN RPC Proxy
 *
 * Resolves routeName to actual HTTP method and path from routeMap,
 * then forwards requests to SPFN API server with automatic:
 * - Cookie forwarding
 * - Interceptor execution
 * - Header manipulation
 *
 * Note: Uses generated route-map to avoid loading server code in Next.js process.
 * Run \`spfn codegen run\` if route-map.ts is missing.
 */

${authImports}import { routeMap } from '@/generated/route-map';
import { createRpcProxy } from '@spfn/core/nextjs/server';

export const { GET, POST } = createRpcProxy({ routeMap });
`;
    writeFileSync(rpcRoutePath, routeContent);

    const relativePath = rpcRoutePath.replace(cwd + '/', '');
    logger.success(`Created ${relativePath} (RPC proxy)`);
}
