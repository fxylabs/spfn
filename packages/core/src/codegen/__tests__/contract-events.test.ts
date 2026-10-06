/**
 * The contract generator reading an event router
 *
 * Every fixture is a real router file and a real event router file written to a
 * temporary directory and loaded through the generator's own loader, as
 * `route-map.test.ts` does. Fixtures import from the source files — and
 * TypeBox — by absolute path, so the directory needs no node_modules link of
 * its own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createContractGenerator, type ContractGeneratorConfig } from '../generators/contract';
import { ConditionalRegistrationError } from '../generators/contract-guard';
import type { ContractDocument } from '@spfn/core/contract';

/** Absolute specifiers a fixture imports, with separators a TS string accepts. */
const ROUTER_MODULE = resolve(__dirname, '../../route/router').replace(/\\/g, '/');
const ROUTE_BUILDER_MODULE = resolve(__dirname, '../../route/route-builder').replace(/\\/g, '/');
const EVENT_MODULE = resolve(__dirname, '../../event/event').replace(/\\/g, '/');
const EVENT_ROUTER_MODULE = resolve(__dirname, '../../event/router').replace(/\\/g, '/');
const TYPEBOX_MODULE = createRequire(__filename).resolve('@sinclair/typebox').replace(/\\/g, '/');

const ROUTER = `import { defineRouter } from '${ROUTER_MODULE}';\n`
    + `import { route } from '${ROUTE_BUILDER_MODULE}';\n\n`
    + 'const health = route.get(\'/health\').handler(async () => ({ ok: true }));\n'
    + 'export const appRouter = defineRouter({ health });\n';

const EVENT_IMPORTS = `import { Type } from '${TYPEBOX_MODULE}';\n`
    + `import { defineEvent } from '${EVENT_MODULE}';\n`
    + `import { defineEventRouter } from '${EVENT_ROUTER_MODULE}';\n\n`
    + 'const sessionActivity = defineEvent(\'session.activity\', Type.Object({ at: Type.Number() }))\n'
    + '    .contract({ since: \'1.0.0\' });\n';

let projectDir: string;

function writeFile(relativePath: string, content: string): void
{
    const absolutePath = join(projectDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

function writeEvents(body: string): void
{
    writeFile('src/server/events.ts', EVENT_IMPORTS + body);
}

async function generate(options: Partial<ContractGeneratorConfig> = {}): Promise<ContractDocument>
{
    const generator = createContractGenerator({
        name: '@spfn/core:contract',
        routerPath: './src/server/router.ts',
        ...options,
    });

    await generator.generate({ cwd: projectDir, trigger: { type: 'manual' } });

    return JSON.parse(readFileSync(join(projectDir, 'contracts', 'current.json'), 'utf-8')) as ContractDocument;
}

beforeEach(() =>
{
    projectDir = mkdtempSync(join(tmpdir(), 'spfn-contract-events-'));
    writeFile('src/server/router.ts', ROUTER);
});

afterEach(() =>
{
    rmSync(projectDir, { recursive: true, force: true });
});

describe('the contract generator reading an event router', () =>
{
    it('X1 writes the events section from the eventRouter export', async () =>
    {
        writeEvents('export const eventRouter = defineEventRouter({ sessionActivity }).contract({ auth: \'none\' });\n');

        const document = await generate({ eventRouterPath: './src/server/events.ts' });

        expect(document.events).toMatchObject({
            streamPath: '/events/stream',
            tokenPath: '/events/token',
            auth: 'none',
            items: [{ name: 'sessionActivity', since: '1.0.0' }],
        });
    });

    it('X2 finds the event router under the default export', async () =>
    {
        writeEvents('export default defineEventRouter({ sessionActivity }).contract({ auth: \'none\' });\n');

        const document = await generate({ eventRouterPath: './src/server/events.ts' });

        expect(document.events?.items.map(item => item.name)).toEqual(['sessionActivity']);
    });

    it('X3 refuses a file with no event router export, naming the candidates tried', async () =>
    {
        writeEvents('export const events = { sessionActivity };\n');

        await expect(generate({ eventRouterPath: './src/server/events.ts' }))
            .rejects.toThrow(/No event router found in src\/server\/events\.ts\. Looked for: eventRouter, default\./);
    });

    it('X4 writes the document without events when eventRouterPath is unset', async () =>
    {
        writeEvents('export const eventRouter = defineEventRouter({ sessionActivity }).contract({ auth: \'none\' });\n');

        const document = await generate();

        expect(document).not.toHaveProperty('events');
    });

    it('X5 refuses an event router whose event set depends on a flag', async () =>
    {
        writeEvents(
            'const flag = process.env.BETA === \'1\';\n'
            + 'export const eventRouter = defineEventRouter({ ...(flag ? { sessionActivity } : {}) })\n'
            + '    .contract({ auth: \'none\' });\n',
        );

        const run = generate({ eventRouterPath: './src/server/events.ts' });

        await expect(run).rejects.toThrow(ConditionalRegistrationError);
        await expect(run).rejects.toThrow(/registers events conditionally/);
    });
});
