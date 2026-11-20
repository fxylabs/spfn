import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import fse from 'fs-extra';
import { logger } from '../../../utils/logger.js';
import { findTemplatesPath } from '../utils/templates.js';

const { copySync, writeFileSync } = fse;

/**
 * Dockerfile template is written for pnpm; rewrite the pnpm-specific lines
 * for the package manager the project actually uses.
 */
const PM_DOCKERFILE_ADAPTATIONS: Record<string, [string, string][]> = {
    npm: [
        ['# Install pnpm\nRUN corepack enable pnpm\n\n', ''],
        ['pnpm-lock.yaml*', 'package-lock.json*'],
        ['RUN pnpm install --frozen-lockfile --prod=false', 'RUN npm ci --include=dev'],
        ['RUN pnpm run spfn:build', 'RUN npm run spfn:build'],
        ['RUN pnpm prune --prod', 'RUN npm prune --omit=dev'],
        ['CMD ["pnpm", "run", "spfn:start"]', 'CMD ["npm", "run", "spfn:start"]'],
    ],
    yarn: [
        ['RUN corepack enable pnpm', 'RUN corepack enable yarn'],
        ['pnpm-lock.yaml*', 'yarn.lock*'],
        ['RUN pnpm install --frozen-lockfile --prod=false', 'RUN yarn install --frozen-lockfile'],
        ['RUN pnpm run spfn:build', 'RUN yarn run spfn:build'],
        ['# Remove dev dependencies (optional, reduces image size)\nRUN pnpm prune --prod\n\n', ''],
        ['CMD ["pnpm", "run", "spfn:start"]', 'CMD ["yarn", "run", "spfn:start"]'],
    ],
    bun: [
        ['# Install pnpm\nRUN corepack enable pnpm', '# Install bun\nRUN npm install -g bun'],
        ['pnpm-lock.yaml*', 'bun.lock*'],
        ['RUN pnpm install --frozen-lockfile --prod=false', 'RUN bun install --frozen-lockfile'],
        ['RUN pnpm run spfn:build', 'RUN bun run spfn:build'],
        ['# Remove dev dependencies (optional, reduces image size)\nRUN pnpm prune --prod\n\n', ''],
        ['CMD ["pnpm", "run", "spfn:start"]', 'CMD ["bun", "run", "spfn:start"]'],
    ],
};

function adaptDockerfileForPm(content: string, pm: string): string
{
    const adaptations = PM_DOCKERFILE_ADAPTATIONS[pm];

    if (!adaptations)
    {
        return content;
    }

    return adaptations.reduce((acc, [from, to]) => acc.replace(from, to), content);
}

/**
 * Copy Docker configuration files to project root
 * Includes docker-compose.yml, Dockerfile, .dockerignore, and docker-compose.production.yml
 */
export async function setupDockerFiles(cwd: string, pm: string = 'pnpm'): Promise<void>
{
    const templatesDir = findTemplatesPath();

    // Copy docker-compose.yml (development)
    const dockerComposePath = join(cwd, 'docker-compose.yml');
    if (!existsSync(dockerComposePath))
    {
        try
        {
            const dockerComposeTemplate = join(templatesDir, 'docker-compose.yml');

            if (existsSync(dockerComposeTemplate))
            {
                copySync(dockerComposeTemplate, dockerComposePath);
                logger.success('Created docker-compose.yml (PostgreSQL + Redis)');
            }
        }
        catch (error)
        {
            // Not critical, continue without docker-compose.yml
            logger.warn('Could not copy docker-compose.yml');
        }
    }

    // Copy Docker production files
    try
    {
        // Copy Dockerfile (adapted for the project's package manager)
        const dockerfilePath = join(cwd, 'Dockerfile');
        if (!existsSync(dockerfilePath))
        {
            const dockerfileTemplate = join(templatesDir, 'Dockerfile');
            if (existsSync(dockerfileTemplate))
            {
                const content = adaptDockerfileForPm(readFileSync(dockerfileTemplate, 'utf-8'), pm);
                writeFileSync(dockerfilePath, content);
                logger.success(`Created Dockerfile (${pm})`);
            }
        }

        // Copy .dockerignore
        const dockerignorePath = join(cwd, '.dockerignore');
        if (!existsSync(dockerignorePath))
        {
            const dockerignoreTemplate = join(templatesDir, '.dockerignore');
            if (existsSync(dockerignoreTemplate))
            {
                copySync(dockerignoreTemplate, dockerignorePath);
                logger.success('Created .dockerignore');
            }
        }

        // Copy docker-compose.production.yml
        const dockerComposeProdPath = join(cwd, 'docker-compose.production.yml');
        if (!existsSync(dockerComposeProdPath))
        {
            const dockerComposeProdTemplate = join(templatesDir, 'docker-compose.production.yml');
            if (existsSync(dockerComposeProdTemplate))
            {
                copySync(dockerComposeProdTemplate, dockerComposeProdPath);
                logger.success('Created docker-compose.production.yml');
            }
        }
    }
    catch (error)
    {
        // Not critical, continue
        logger.warn('Could not copy Docker files (you can create them manually)');
    }
}
