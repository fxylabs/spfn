import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execa: vi.fn(),
    spinner: {
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn(),
        fail: vi.fn(),
    },
}));

vi.mock('execa', () => ({ execa: mocks.execa }));
vi.mock('ora', () => ({ default: () => mocks.spinner }));

import { setupIcons } from '../setup.js';
import { logger } from '../../utils/logger.js';
import { DRIZZLE_TYPEBOX_REFUSAL } from '../../utils/package-manager.js';
import { NPM_ERESOLVE_DRIZZLE_TYPEBOX } from '../../utils/__tests__/fixtures/npm-eresolve.js';

const originalCwd = process.cwd();
let app: string;

beforeEach(() =>
{
    app = mkdtempSync(join(tmpdir(), 'spfn-setup-icons-'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'next': '16', 'drizzle-typebox': '^0.3.3' } }));
    writeFileSync(join(app, 'package-lock.json'), '{}');
    process.chdir(app);
});

afterEach(() =>
{
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(app, { recursive: true, force: true });
});

describe('spfn setup icons in an npm app npm refuses over drizzle-typebox', () =>
{
    it('prints npm\'s lines and the explanation (npm 10.9.9 output, fixtures/npm-eresolve.ts), then exits non-zero', async () =>
    {
        mocks.execa.mockRejectedValueOnce(Object.assign(
            new Error(`Command failed with exit code 1: npm install --save-dev @svgr/webpack\n${NPM_ERESOLVE_DRIZZLE_TYPEBOX}`),
            { exitCode: 1, stdout: '', stderr: NPM_ERESOLVE_DRIZZLE_TYPEBOX },
        ));
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        vi.spyOn(logger, 'step').mockImplementation(() => undefined);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        await expect(setupIcons()).rejects.toThrow('process.exit(1)');

        expect(mocks.spinner.fail).toHaveBeenCalledWith('Failed to install @svgr/webpack');
        expect(error).toHaveBeenCalledWith(expect.stringContaining('npm error peer drizzle-orm@">=0.36.0" from drizzle-typebox@0.3.3'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining(DRIZZLE_TYPEBOX_REFUSAL));
    });
});
