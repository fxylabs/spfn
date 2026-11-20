import { existsSync } from 'fs';
import { join, sep } from 'path';
import ora from 'ora';
import fse from 'fs-extra';
import { logger } from '../../../utils/logger.js';
import { findTemplatesPath } from '../utils/templates.js';
import type { ScaffoldMode } from '../mode.js';

const { copySync, ensureDirSync } = fse;

/**
 * Copy server template files (routes, entities, examples)
 * and lib directory (contracts, types, etc.)
 */
export async function setupServerStructure(cwd: string, mode: ScaffoldMode): Promise<void>
{
    const spinner = ora('Setting up server structure...').start();

    try
    {
        // Find templates directory (works in both npm package and monorepo dev)
        const templatesDir = findTemplatesPath();
        const serverTemplateDir = join(templatesDir, 'server');
        const targetDir = join(cwd, 'src', 'server');

        if (!existsSync(serverTemplateDir))
        {
            spinner.fail('Failed to create server structure');
            logger.error(`Server templates not found at: ${serverTemplateDir}`);
            process.exit(1);
        }

        ensureDirSync(targetDir);

        // Copy all template files (includes tsconfig.json)
        copySync(serverTemplateDir, targetDir);

        // Copy lib directory (contracts, types, etc.)
        const libTemplateDir = join(templatesDir, 'lib');
        const libTargetDir = join(cwd, 'src', 'lib');

        if (existsSync(libTemplateDir))
        {
            ensureDirSync(libTargetDir);
            copySync(libTemplateDir, libTargetDir);
        }

        // Copy environment configuration template
        const envConfigTemplate = join(serverTemplateDir, 'config', 'env.config.ts');
        const envConfigTarget = join(targetDir, 'config', 'env.config.ts');

        if (existsSync(envConfigTemplate))
        {
            ensureDirSync(join(targetDir, 'config'));
            copySync(envConfigTemplate, envConfigTarget);
            logger.success('Created src/server/config/env.config.ts (environment management)');
        }

        // Apply the selected profile last so mode-specific files intentionally
        // override their core counterparts.
        if (mode === 'full')
        {
            const fullTemplateDir = join(templatesDir, 'modes', 'full');
            if (!existsSync(fullTemplateDir))
            {
                throw new Error(`Full scaffold templates not found at: ${fullTemplateDir}`);
            }

            // Server files are part of the selected scaffold and may replace the
            // just-copied core templates. App routes and catalogs are different:
            // an existing project may already own them, so merge those starter
            // files without overwriting user work.
            const fullAppTemplateDir = join(fullTemplateDir, 'src', 'app');
            const fullI18nTemplateDir = join(fullTemplateDir, 'src', 'i18n');
            const mergeOnlyDirs = [fullAppTemplateDir, fullI18nTemplateDir];
            copySync(fullTemplateDir, cwd, {
                filter: source => !mergeOnlyDirs.some(directory => source === directory
                    || source.startsWith(`${directory}${sep}`)),
            });

            const appTargetDir = existsSync(join(cwd, 'src', 'app'))
                ? join(cwd, 'src', 'app')
                : join(cwd, 'app');
            copySync(fullAppTemplateDir, appTargetDir, {
                overwrite: false,
                errorOnExist: false,
            });
            copySync(fullI18nTemplateDir, join(cwd, 'src', 'i18n'), {
                overwrite: false,
                errorOnExist: false,
            });
        }

        spinner.succeed('Server structure created');
    }
    catch (error)
    {
        spinner.fail('Failed to create server structure');
        logger.error(String(error));
        process.exit(1);
    }
}
