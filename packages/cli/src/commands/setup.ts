import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import ora from 'ora';
import fse from 'fs-extra';
import chalk from 'chalk';

const { ensureDirSync, writeFileSync, readFileSync } = fse;

import { logger } from '../utils/logger.js';
import { detectPackageManager, getAddArgs, runInstall } from '../utils/package-manager.js';

interface PackageJson {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

/**
 * Setup SVGR for SVG icon management
 */
export async function setupIcons(): Promise<void>
{
    const cwd = process.cwd();

    logger.info('Setting up SVGR for SVG icon management...\n');

    // 1. Check if it's a Next.js project
    const packageJsonPath = join(cwd, 'package.json');

    if (!existsSync(packageJsonPath))
    {
        logger.error('No package.json found. Please run this in a Next.js project.');
        process.exit(1);
    }

    const packageJson = JSON.parse(
        readFileSync(packageJsonPath, 'utf-8'),
    ) as PackageJson;

    const hasNext = packageJson.dependencies?.next || packageJson.devDependencies?.next;

    if (!hasNext)
    {
        logger.error('Next.js not detected in dependencies. This setup is for Next.js projects only.');
        process.exit(1);
    }

    // 2. Check if already setup
    const hasSvgr = packageJson.devDependencies?.['@svgr/webpack'];
    if (hasSvgr)
    {
        logger.warn('@svgr/webpack is already installed.');
        logger.info('Skipping installation, but will create directory structure...\n');
    }

    // 3. Install @svgr/webpack
    if (!hasSvgr)
    {
        const pm = detectPackageManager(cwd);
        logger.step(`Detected package manager: ${pm}`);

        const spinner = ora('Installing @svgr/webpack...').start();
        const failure = await runInstall(pm, getAddArgs(pm, ['@svgr/webpack'], { dev: true }), { cwd });

        if (failure)
        {
            spinner.fail('Failed to install @svgr/webpack');
            logger.error(failure);
            process.exit(1);
        }

        spinner.succeed('@svgr/webpack installed');
    }

    // 4. Update next.config
    const spinner = ora('Updating next.config...').start();

    try
    {
        // Find next.config file
        const possibleConfigs = [
            'next.config.ts',
            'next.config.js',
            'next.config.mjs',
        ];

        let configPath: string | null = null;

        for (const config of possibleConfigs)
        {
            const path = join(cwd, config);
            if (existsSync(path))
            {
                configPath = path;
                break;
            }
        }

        if (!configPath)
        {
            spinner.warn('next.config not found, creating next.config.ts...');
            configPath = join(cwd, 'next.config.ts');

            // Create new config
            const newConfig = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config) {
    // SVGR: Import SVG as React components
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fileLoaderRule = (config.module.rules as any[])
      .find((rule: any) => Array.isArray(rule.oneOf))
      ?.oneOf.find((rule: any) => rule.test?.test?.('.svg'));

    if (fileLoaderRule) {
      fileLoaderRule.exclude = /\\.svg$/i;
    }

    config.module.rules.unshift({
      test: /\\.svg$/i,
      use: ['@svgr/webpack'],
    });

    return config;
  },
  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },
};

export default nextConfig;
`;
            writeFileSync(configPath, newConfig);
            spinner.succeed('Created next.config.ts with SVGR support');
        }
        else
        {
            // Update existing config
            let configContent = readFileSync(configPath, 'utf-8');

            // Check if SVGR is already configured
            if (configContent.includes('@svgr/webpack'))
            {
                spinner.warn('SVGR already configured in next.config');
            }
            else
            {
                // Try to automatically add SVGR configuration
                const hasWebpack = configContent.includes('webpack(');
                const hasTurbopack = configContent.includes('turbopack:');

                if (hasWebpack || hasTurbopack)
                {
                    // Config already has webpack/turbopack - manual update required
                    spinner.info('Manual update required for next.config');
                    logger.warn('\nYou need to manually add SVGR configuration to your next.config file.');
                    logger.info('See: https://react-svgr.com/docs/next/');
                    logger.info('\nAdd this to your next.config:\n');
                    console.log(chalk.gray(`
webpack(config) {
  const fileLoaderRule = config.module.rules
    .find(rule => rule.oneOf)
    ?.oneOf.find(rule => rule.test?.test?.('.svg'));

  if (fileLoaderRule) {
    fileLoaderRule.exclude = /\\.svg$/i;
  }

  config.module.rules.unshift({
    test: /\\.svg$/i,
    use: ['@svgr/webpack'],
  });

  return config;
},
turbopack: {
  rules: {
    '*.svg': {
      loaders: ['@svgr/webpack'],
      as: '*.js',
    },
  },
},
                `));
                }
                else
                {
                    // Auto-inject SVGR configuration
                    const webpackConfig = `  webpack(config) {
    // SVGR: Import SVG as React components
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fileLoaderRule = (config.module.rules as any[])
      .find((rule: any) => Array.isArray(rule.oneOf))
      ?.oneOf.find((rule: any) => rule.test?.test?.('.svg'));

    if (fileLoaderRule) {
      fileLoaderRule.exclude = /\\.svg$/i;
    }

    config.module.rules.unshift({
      test: /\\.svg$/i,
      use: ['@svgr/webpack'],
    });

    return config;
  },`;

                    const turbopackConfig = `  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },`;

                    // Check if config object is empty: NextConfig = {};
                    const emptyConfigPattern = /const\s+\w+:\s*NextConfig\s*=\s*\{\s*\};/;

                    if (emptyConfigPattern.test(configContent))
                    {
                        // Replace empty config with SVGR config
                        configContent = configContent.replace(
                            emptyConfigPattern,
                            `const nextConfig: NextConfig = {\n${webpackConfig}\n${turbopackConfig}\n};`,
                        );
                    }
                    else
                    {
                        // Insert webpack and turbopack before the closing brace of NextConfig object
                        // Find the NextConfig object and add properties
                        const configObjectPattern = /(const\s+\w+:\s*NextConfig\s*=\s*\{)([^}]*?)(\};)/s;

                        if (configObjectPattern.test(configContent))
                        {
                            configContent = configContent.replace(
                                configObjectPattern,
                                (_match, opening, content, closing) =>
                                {
                                    const trimmedContent = content.trim();
                                    if (trimmedContent)
                                    {
                                        // Has existing properties
                                        return `${opening}${content}\n${webpackConfig}\n${turbopackConfig}\n${closing}`;
                                    }
                                    else
                                    {
                                        // Empty object
                                        return `${opening}\n${webpackConfig}\n${turbopackConfig}\n${closing}`;
                                    }
                                },
                            );
                        }
                    }

                    writeFileSync(configPath, configContent);
                    spinner.succeed('Added SVGR configuration to next.config');
                }
            }
        }
    }
    catch (error)
    {
        spinner.fail('Failed to update next.config');
        logger.error(String(error));
    }

    // 5. Create directory structure
    const iconsSpinner = ora('Creating src/assets/icons/ directory...').start();

    try
    {
        const iconsDir = join(cwd, 'src', 'assets', 'icons');
        ensureDirSync(iconsDir);

        // Create README.md
        const readmePath = join(iconsDir, 'README.md');
        const readmeContent = `# Icons

This directory manages SVG icons for the project.

## Usage

Import SVG files as React components using SVGR:

\`\`\`tsx
import Logo from '@/assets/icons/logo.svg';

function MyComponent() {
  return (
    <Logo className="size-8 text-gray-900 dark:text-white" />
  );
}
\`\`\`

## Color Control

Use \`fill="currentColor"\` in your SVG files to control colors via Tailwind CSS:

\`\`\`tsx
// Light mode: gray-900, Dark mode: white
<Logo className="size-8 text-gray-900 dark:text-white" />

// Custom colors
<Icon className="size-6 text-blue-600" />
\`\`\`

## Adding New Icons

1. Add SVG file to this directory
2. Set \`fill="currentColor"\` for color control (optional)
3. Remove \`width\` and \`height\` attributes for flexible sizing
4. Import and use as React component

\`\`\`tsx
import NewIcon from '@/assets/icons/new-icon.svg';
\`\`\`

## Configuration

- **next.config.ts**: SVGR webpack loader configuration
- **Turbopack**: SVG loader rules for fast refresh

## Example SVG Structure

\`\`\`xml
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="..." fill="currentColor"/>
</svg>
\`\`\`

Note: Remove \`width\` and \`height\` for flexible sizing with Tailwind utilities.
`;

        writeFileSync(readmePath, readmeContent);

        iconsSpinner.succeed('Created src/assets/icons/ directory with README.md');
    }
    catch (error)
    {
        iconsSpinner.fail('Failed to create directory structure');
        logger.error(String(error));
    }

    // Done
    console.log('\n' + chalk.green.bold('✓ SVGR setup completed!\n'));

    console.log('Next steps:');
    console.log('  1. Add SVG files to ' + chalk.cyan('src/assets/icons/'));
    console.log('  2. Import them as React components:');
    console.log('     ' + chalk.gray('import Logo from \'@/assets/icons/logo.svg\';'));
    console.log('  3. Use with Tailwind classes:');
    console.log('     ' + chalk.gray('<Logo className="size-8 text-gray-900 dark:text-white" />'));
    console.log('\nDocumentation: ' + chalk.cyan('src/assets/icons/README.md'));
}

export const setupCommand = new Command('setup')
    .description('Setup additional features for your project');

setupCommand
    .command('icons')
    .description('Setup SVGR for SVG icon management')
    .action(setupIcons);
