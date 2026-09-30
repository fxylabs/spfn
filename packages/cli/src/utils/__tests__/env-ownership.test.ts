/**
 * One owner per env variable across this monorepo's packages.
 *
 * Every package whose `package.json` exports `./config` is loaded from its
 * `src/config/index.ts`, and its `envSchema` — when it has one — joins the
 * list. A key two packages declare is two rule sets for one variable: an app
 * installing both would have `spfn env` refuse its list, and each package
 * would enforce its own rules at runtime. The second package reads the key
 * from the owner's `env` instead of declaring it again.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeEnvSources, type EnvSource } from '../env-list.js';
import type { EnvSchema } from '../env-schema.js';

const PACKAGES_DIR = fileURLToPath(new URL('../../../../', import.meta.url));

/** Directories under `packages/` whose package exports `./config`. */
function packagesWithConfig(): { name: string; dir: string }[]
{
    return readdirSync(PACKAGES_DIR)
        .map((entry) => join(PACKAGES_DIR, entry))
        .filter((dir) => existsSync(join(dir, 'package.json')))
        .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) }))
        .filter(({ manifest }) => manifest.exports?.['./config'])
        .map(({ dir, manifest }) => ({ name: manifest.name as string, dir }));
}

async function loadMonorepoSchemas(): Promise<EnvSource[]>
{
    const sources: EnvSource[] = [];

    for (const { name, dir } of packagesWithConfig())
    {
        const module = await import(pathToFileURL(join(dir, 'src/config/index.ts')).href);

        if (module.envSchema)
        {
            sources.push({ name, schema: module.envSchema as EnvSchema });
        }
    }

    return sources;
}

describe('env variable ownership across the monorepo', () =>
{
    it('no key is declared by two packages', async () =>
    {
        const sources = await loadMonorepoSchemas();
        const { declaredBy } = mergeEnvSources(sources);
        const shared = Object.entries(declaredBy)
            .filter(([, owners]) => owners.length > 1)
            .map(([key, owners]) => `${key}: ${owners.join(', ')}`);

        expect(sources.map((source) => source.name)).toEqual(expect.arrayContaining(['@spfn/core', '@spfn/auth']));
        expect(shared).toEqual([]);
    });
});
