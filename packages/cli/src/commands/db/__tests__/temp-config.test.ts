/**
 * The temporary drizzle config holds a database URL (#405)
 *
 * T1: it is created readable by its owner only, and never through a file
 * already at its path. T2: it is gone however the CLI process ends —
 * `process.exit` without the command removing it, or a SIGTERM no other
 * listener handles, after which the process still dies of the signal. T2 runs
 * a real node process, since an exit or a signal would end the test worker.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeTempDrizzleConfig } from '../utils/temp-config.js';

const MODULE = join(__dirname, '..', 'utils', 'temp-config.ts');
/** tsx's loader, for `node --import`: the tsx CLI would run the script in a child and relay the signal */
const TSX_LOADER = pathToFileURL(createRequire(__filename).resolve('tsx')).href;

describe('the temporary drizzle config', () =>
{
    const previousCwd = process.cwd();
    let dir: string;

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-temp-config-'));
        process.chdir(dir);
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
    });

    /** Run `body` in a tsx process in `dir`, after it wrote the config. */
    function runChild(body: string): ReturnType<typeof spawnSync>
    {
        const script = `const { writeTempDrizzleConfig } = await import(${JSON.stringify(MODULE)});\n`
            + `writeTempDrizzleConfig('export default {};');\n${body}\n`;

        return spawnSync(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    }

    it('T1 is written with mode 0600 and removed by remove()', () =>
    {
        const config = writeTempDrizzleConfig('export default {};');
        const path = join(dir, config.path);

        expect(statSync(path).mode & 0o777).toBe(0o600);

        config.remove();
        config.remove();
        expect(existsSync(path)).toBe(false);
    });

    it('T1 never writes through a file already at its path', () =>
    {
        vi.spyOn(Date, 'now').mockReturnValue(1);
        writeFileSync(join(dir, `drizzle.config.${process.pid}.1.temp.ts`), 'planted');

        expect(() => writeTempDrizzleConfig('export default {};')).toThrow(/EEXIST/);
        expect(readFileSync(join(dir, `drizzle.config.${process.pid}.1.temp.ts`), 'utf8')).toBe('planted');
    });

    it('T2 is gone after process.exit that the command did not see coming', () =>
    {
        const child = runChild('process.exit(3);');

        expect(child.status).toBe(3);
        expect(readdirSync(dir)).toEqual([]);
    });

    it('T2 is gone after a SIGTERM, and the process still dies of it', () =>
    {
        const child = runChild('setInterval(() => undefined, 1000); process.kill(process.pid, "SIGTERM");');

        expect(child.signal).toBe('SIGTERM');
        expect(readdirSync(dir)).toEqual([]);
    });
});
