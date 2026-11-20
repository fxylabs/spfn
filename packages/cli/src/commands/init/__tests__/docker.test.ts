import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../../utils/logger.js';
import { setupDockerFiles } from '../steps/docker.js';

let testDirectory: string | undefined;

afterEach(async () =>
{
    vi.restoreAllMocks();
    await rm(testDirectory!, { recursive: true, force: true });
});

/** The Dockerfile `setupDockerFiles` writes for `pm`. */
async function dockerfileFor(pm: string): Promise<string>
{
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-docker-'));
    await setupDockerFiles(testDirectory, pm);

    return readFile(join(testDirectory, 'Dockerfile'), 'utf8');
}

describe('setupDockerFiles', () =>
{
    it('runs npm ci and prune in the image with no flag that would hide a peer conflict', async () =>
    {
        const dockerfile = await dockerfileFor('npm');

        expect(dockerfile).toContain('RUN npm ci --include=dev\n');
        expect(dockerfile).toContain('RUN npm prune --omit=dev\n');
    });

    it('copies bun\'s lockfile, text (bun.lock) or binary (bun.lockb)', async () =>
    {
        expect(await dockerfileFor('bun')).toContain('bun.lock*');
    });
});
