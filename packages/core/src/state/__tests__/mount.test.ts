/**
 * Mount — the state router reaches the app through `.packages()` and the app's
 * own event router, with no special support anywhere.
 *
 * | #  | situation                                                     | expected                                                  |
 * |----|---------------------------------------------------------------|-----------------------------------------------------------|
 * | M1 | `appRouter.packages([states.router])` through the route-map generator | `getConsentState`, `putConsentState`, `getStates` listed under the package section |
 * | M2 | `defineEventRouter({ ...appEvents, ...states.events })`       | `eventNames` contains `state.consent.changed`; the stream accepts it in `events=` |
 * | M3 | an app route named `getConsentState`                          | the existing duplicate-name refusal fires (no new rule)   |
 *
 * M1 and M3 load a real router file through the generator, as
 * `codegen/__tests__/route-map.test.ts` does; the fixture imports the state
 * module from source by absolute path.
 */

import { Type } from '@sinclair/typebox';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteMapGenerator } from '../../codegen/generators/route-map';
import { defineEvent } from '../../event/event';
import { defineEventRouter } from '../../event/router';
import { closeAllStreams, createStreamApp } from '../../event/sse/__tests__/stream-harness';
import { defineStateRouter } from '../state-router';
import { consentState } from './state-harness';

const specifier = (path: string) => resolve(__dirname, path).replace(/\\/g, '/');
const TYPEBOX_MODULE = createRequire(__filename).resolve('@sinclair/typebox').replace(/\\/g, '/');

const IMPORTS = `import { Type } from '${TYPEBOX_MODULE}';\n`
    + `import { defineRouter } from '${specifier('../../route/router')}';\n`
    + `import { route } from '${specifier('../../route/route-builder')}';\n`
    + `import { defineState } from '${specifier('../state-builder')}';\n`
    + `import { defineStateRouter } from '${specifier('../state-router')}';\n\n`
    + 'const consent = defineState(\'consent\')\n'
    + '    .value(Type.Union([Type.Literal(\'pending\'), Type.Literal(\'agreed\')]))\n'
    + '    .read(async () => ({ value: \'agreed\' as const }))\n'
    + '    .write(Type.Object({ termsVersion: Type.String() }), async () => {});\n'
    + 'const states = defineStateRouter({ consent });\n'
    + 'const getRoot = route.get(\'/\').handler(async () => ({}));\n';

const OUTPUT_PATH = 'src/generated/route-map.ts';

let projectDir: string;

function writeRouter(body: string): void
{
    const path = join(projectDir, 'src/server/router.ts');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, IMPORTS + body, 'utf-8');
}

async function generate(): Promise<string>
{
    await createRouteMapGenerator({
        name: '@spfn/core:route-map',
        routerPath: './src/server/router.ts',
        outputPath: `./${OUTPUT_PATH}`,
    }).generate({ cwd: projectDir, trigger: { type: 'manual' } });

    return readFileSync(join(projectDir, OUTPUT_PATH), 'utf-8');
}

beforeEach(() =>
{
    projectDir = mkdtempSync(join(tmpdir(), 'spfn-state-mount-'));
});

afterEach(async () =>
{
    rmSync(projectDir, { recursive: true, force: true });
    await closeAllStreams();
});

describe('mount', () =>
{
    it('M1 .packages([states.router]) lists getConsentState, putConsentState and getStates under the package section', async () =>
    {
        writeRouter('export const appRouter = defineRouter({ getRoot }).packages([states.router]);\n');

        const content = await generate();
        const packageSection = content.slice(content.indexOf('// From the package routers'));

        expect(content.indexOf('getRoot:')).toBeLessThan(content.indexOf('// From the package routers'));
        expect(packageSection).toContain('getConsentState: { method: \'GET\', path: \'/state/consent\' },');
        expect(packageSection).toContain('putConsentState: { method: \'PUT\', path: \'/state/consent\' },');
        expect(packageSection).toContain('getStates: { method: \'GET\', path: \'/state\' },');
    });

    it('M2 the app event router spreading states.events names state.consent.changed, and the stream accepts it', async () =>
    {
        const states = defineStateRouter({ consent: consentState().state });
        const appEvents = { 'app.ping': defineEvent('app.ping', Type.Object({ n: Type.Number() })) };
        const eventRouter = defineEventRouter({ ...appEvents, ...states.events });

        const stream = await createStreamApp(eventRouter).connect('s', { query: 'events=app.ping,state.consent.changed' });

        expect(eventRouter.eventNames).toEqual(['app.ping', 'state.consent.changed']);
        expect((await stream.frame('connected')).data.subscribedEvents).toEqual(['app.ping', 'state.consent.changed']);
    });

    it('M3 an app route named getConsentState meets the existing duplicate-name refusal', async () =>
    {
        writeRouter(
            'const getConsentState = route.get(\'/my-consent\').handler(async () => ({}));\n'
            + 'export const appRouter = defineRouter({ getConsentState }).packages([states.router]);\n',
        );

        await expect(generate()).rejects.toThrow(
            'The app route "getConsentState" (router.getConsentState) is also registered by a package router',
        );
    });
});
