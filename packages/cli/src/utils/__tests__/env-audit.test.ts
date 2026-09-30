/**
 * `spfn env audit`.
 *
 * One test per case A1–A12: direct `process.env` reads are findings outside the
 * schema modules, root `*.config.*` files and `env.audit.ignore`, `NODE_ENV`
 * excepted, and only code counts — not comments or strings. An app schema name
 * no scanned file reads is a finding unless `readBy` vouches for it. Around
 * them: the scan's reach (symlinks, node_modules, build output, declaration
 * files), the syntaxes it parses, a list that cannot be built, and the command's
 * exit code and output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runEnvAudit } from '../env-audit/index.js';
import { auditEnv } from '../../commands/env.js';

let appDir: string;

function write(path: string, content: string): void
{
    const fullPath = join(appDir, path);

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
}

function writeAppConfig(env: Record<string, unknown>): void
{
    write('spfn.config.js', `export default ${JSON.stringify({ env })};\n`);
}

/** An app schema module declaring `names`, with extra fields per name. */
function writeSchema(names: Record<string, Record<string, unknown>>, path = 'src/env.schema.js'): void
{
    const entries = Object.entries(names).map(([key, extra]) =>
        `    ${key}: ${JSON.stringify({ key, type: 'string', description: key, ...extra })},`);

    write(path, `export const envSchema = {\n${entries.join('\n')}\n};\n`);
}

/** Findings as `file:line NAME` — the part of a line tests pin. */
function located(findings: Array<{ file: string; line: number; name: string }>): string[]
{
    return findings.map((finding) => `${finding.file}:${finding.line} ${finding.name}`);
}

beforeEach(() =>
{
    appDir = mkdtempSync(join(tmpdir(), 'spfn-env-audit-'));
    write('package.json', '{ "type": "module" }\n');
});

afterEach(() =>
{
    rmSync(appDir, { recursive: true, force: true });
});

describe('direct reads', () =>
{
    it('A1: flags process.env.X in a scanned file with its file and line', async () =>
    {
        write('src/client.ts', 'const timeout = 5;\nexport const token = process.env.API_TOKEN;\n');

        const report = await runEnvAudit(appDir);

        expect(located(report.directReads)).toEqual(['src/client.ts:2 API_TOKEN']);
        expect(report.directReads[0].reason).toBe('read from process.env');
    });

    it('A2: flags process.env[\'X\'] and process.env[expr]', async () =>
    {
        write('src/client.ts', [
            'export const token = process.env[\'API_TOKEN\'];',
            'export const read = (key: string) => process.env[key];',
        ].join('\n'));

        const report = await runEnvAudit(appDir);

        expect(located(report.directReads)).toEqual(['src/client.ts:1 API_TOKEN', 'src/client.ts:2 [key]']);
        expect(report.directReads[1].reason).toContain('computed key');
    });

    it('A3: flags each name destructured from process.env', async () =>
    {
        write('src/client.ts', 'const { API_TOKEN, REGION: region, ...rest } = process.env;\n');

        const report = await runEnvAudit(appDir);

        expect(report.directReads.map((read) => read.name)).toEqual(['API_TOKEN', 'REGION', '...rest']);
        expect(report.directReads[0].reason).toBe('destructured from process.env');
    });

    it('A4: allows process.env.NODE_ENV anywhere', async () =>
    {
        write('src/client.ts', 'export const dev = process.env.NODE_ENV !== \'production\';\nconst { NODE_ENV } = process.env;\n');

        expect((await runEnvAudit(appDir)).directReads).toEqual([]);
    });

    it('A5: allows direct reads in an env.schemas module and a root *.config.* file', async () =>
    {
        writeAppConfig({ schemas: ['src/env.schema.js'], audit: { include: ['.'] } });
        write('src/env.schema.js', 'export const envSchema = { API_TOKEN: { key: \'API_TOKEN\', type: \'string\', description: String(process.env.API_TOKEN) } };\n');
        write('next.config.mjs', 'export default { env: { API_TOKEN: process.env.API_TOKEN } };\n');
        write('tooling/deep.config.ts', 'export const token = process.env.API_TOKEN;\n');

        const report = await runEnvAudit(appDir);

        expect(located(report.directReads)).toEqual(['tooling/deep.config.ts:1 API_TOKEN']);
    });

    it('A6: allows direct reads in a file matching env.audit.ignore', async () =>
    {
        writeAppConfig({ audit: { ignore: ['src/legacy/**', 'src/**/*.test.ts'] } });
        write('src/legacy/old.ts', 'export const token = process.env.API_TOKEN;\n');
        write('src/client.test.ts', 'process.env.API_TOKEN = \'x\';\n');
        write('src/client.ts', 'export const token = process.env.API_TOKEN;\n');

        expect(located((await runEnvAudit(appDir)).directReads)).toEqual(['src/client.ts:1 API_TOKEN']);
    });

    it('A7: ignores process.env.X inside a comment or an unrelated string', async () =>
    {
        write('src/client.ts', [
            '// read process.env.API_TOKEN here',
            '/* process.env[\'API_TOKEN\'] */',
            'export const hint = \'set process.env.API_TOKEN first\';',
            'export const doc = `process.env.API_TOKEN`;',
        ].join('\n'));

        expect((await runEnvAudit(appDir)).directReads).toEqual([]);
    });

    it('flags optional chaining and reads through the global object', async () =>
    {
        write('src/client.ts', [
            'export const a = process?.env?.API_TOKEN;',
            'export const b = globalThis.process.env.API_TOKEN;',
            'export const c = (process.env as Record<string, string>).API_TOKEN;',
        ].join('\n'));

        expect(located((await runEnvAudit(appDir)).directReads)).toEqual([
            'src/client.ts:1 API_TOKEN',
            'src/client.ts:2 API_TOKEN',
            'src/client.ts:3 API_TOKEN',
        ]);
    });

    it('parses .tsx, .jsx, .mjs and .cjs files', async () =>
    {
        write('src/view.tsx', 'export const View = () => <div title={process.env.A_TSX}>{\'x\'}</div>;\n');
        write('src/view.jsx', 'export const View = () => <div title={process.env.A_JSX} />;\n');
        write('src/esm.mjs', 'export const value = process.env.A_MJS;\n');
        write('src/common.cjs', 'module.exports = { value: process.env.A_CJS };\n');

        const names = (await runEnvAudit(appDir)).directReads.map((read) => read.name).sort();

        expect(names).toEqual(['A_CJS', 'A_JSX', 'A_MJS', 'A_TSX']);
    });
});

describe('scan scope', () =>
{
    it('skips node_modules, build output, declaration files and symbolic links', async () =>
    {
        const outside = mkdtempSync(join(tmpdir(), 'spfn-env-audit-outside-'));

        writeFileSync(join(outside, 'far.ts'), 'export const token = process.env.API_TOKEN;\n');
        write('src/node_modules/dep/index.js', 'module.exports = process.env.API_TOKEN;\n');
        write('src/dist/index.js', 'export const token = process.env.API_TOKEN;\n');
        write('src/types.d.ts', 'declare const token: typeof process.env.API_TOKEN;\n');
        write('src/client.ts', 'export {};\n');
        symlinkSync(outside, join(appDir, 'src/linked'));
        symlinkSync(join(outside, 'far.ts'), join(appDir, 'src/far.ts'));

        const report = await runEnvAudit(appDir);

        rmSync(outside, { recursive: true, force: true });
        expect(report.fileCount).toBe(1);
        expect(report.directReads).toEqual([]);
    });

    it('refuses a glob that reaches outside the project', async () =>
    {
        writeAppConfig({ audit: { include: ['../elsewhere'] } });

        await expect(runEnvAudit(appDir)).rejects.toThrow('stay inside it');
    });
});

describe('unused declarations', () =>
{
    beforeEach(() =>
    {
        writeAppConfig({ schemas: ['src/env.schema.js'] });
    });

    it('A8: passes a name read as env.X somewhere in scope', async () =>
    {
        writeSchema({ API_TOKEN: {} });
        write('src/client.ts', 'import { env } from \'./env\';\nexport const token = env.API_TOKEN;\n');

        expect((await runEnvAudit(appDir)).declarations).toEqual([]);
    });

    it('A9: reports a name read nowhere and without readBy as unused, at its declaration', async () =>
    {
        writeSchema({ API_TOKEN: {}, OLD_KEY: {} });
        write('src/client.ts', 'export const token = env.API_TOKEN;\n');

        const report = await runEnvAudit(appDir);

        expect(located(report.declarations)).toEqual(['src/env.schema.js:3 OLD_KEY']);
        expect(report.declarations[0].reason).toContain('unused');
    });

    it('A10: passes a name whose readBy lists an existing scanned file', async () =>
    {
        writeSchema({ PROVIDER_KEY: { readBy: ['src/providers.ts'] } });
        write('src/providers.ts', 'export const read = (name: string) => env[`${name}_KEY`];\n');

        expect((await runEnvAudit(appDir)).declarations).toEqual([]);
    });

    it('A11: reports a readBy file that does not exist, and one that is not scanned', async () =>
    {
        writeSchema({ PROVIDER_KEY: { readBy: ['src/missing.ts', 'scripts/seed.ts'] } });
        write('scripts/seed.ts', 'export {};\n');

        const reasons = (await runEnvAudit(appDir)).declarations.map((finding) => `${finding.name}: ${finding.reason}`);

        expect(reasons).toEqual([
            'PROVIDER_KEY: readBy file src/missing.ts does not exist',
            'PROVIDER_KEY: readBy file scripts/seed.ts is not scanned (see env.audit)',
        ]);
    });

    it('A12: without env.schemas, still checks direct reads and skips the unused check with a notice', async () =>
    {
        writeAppConfig({});
        write('src/client.ts', 'export const token = process.env.API_TOKEN;\n');

        const report = await runEnvAudit(appDir);

        expect(located(report.directReads)).toEqual(['src/client.ts:1 API_TOKEN']);
        expect(report.declarations).toEqual([]);
        expect(report.notices.join('\n')).toContain('unused-declaration check is skipped');
    });

    it('counts a name only the schema module mentions as unused', async () =>
    {
        writeSchema({ OLD_KEY: {} });
        write('src/client.ts', 'export {};\n');

        expect(located((await runEnvAudit(appDir)).declarations)).toEqual(['src/env.schema.js:2 OLD_KEY']);
    });

    it('leaves a name an installed package also declares to that package', async () =>
    {
        const shared = { key: 'SPFN_API_URL', type: 'string', description: 'SPFN_API_URL' };

        write('package.json', JSON.stringify({ type: 'module', dependencies: { '@spfn/fake': '*' } }));
        write('node_modules/@spfn/fake/package.json', JSON.stringify({ name: '@spfn/fake', type: 'module', exports: { './config': './config.js' } }));
        write('node_modules/@spfn/fake/config.js', `export const envSchema = { SPFN_API_URL: ${JSON.stringify(shared)} };\n`);
        writeSchema({ SPFN_API_URL: {} });
        write('src/client.ts', 'export {};\n');

        expect((await runEnvAudit(appDir)).declarations).toEqual([]);
    });

    it('fails with the list error when an app schema and a package declare a name differently', async () =>
    {
        write('package.json', JSON.stringify({ type: 'module', dependencies: { '@spfn/fake': '*' } }));
        write('node_modules/@spfn/fake/package.json', JSON.stringify({ name: '@spfn/fake', type: 'module', exports: { './config': './config.js' } }));
        write('node_modules/@spfn/fake/config.js', 'export const envSchema = { SHARED: { key: \'SHARED\', type: \'number\', description: \'x\' } };\n');
        writeSchema({ SHARED: {} });

        await expect(runEnvAudit(appDir)).rejects.toThrow('Env schemas declare a variable differently');
    });
});

describe('spfn env audit (command)', () =>
{
    let previousCwd: string;
    let output: string[];

    beforeEach(() =>
    {
        previousCwd = process.cwd();
        process.chdir(appDir);
        output = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        writeAppConfig({ schemas: ['src/env.schema.js'] });
        write('.env.server', 'API_TOKEN=value-that-must-not-print\n');
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        vi.restoreAllMocks();
    });

    it('exits 1 and prints file:line  NAME  reason, names only', async () =>
    {
        writeSchema({ API_TOKEN: { default: 'default-that-must-not-print' }, OLD_KEY: {} });
        write('src/client.ts', 'export const token = process.env.API_TOKEN ?? \'fallback-that-must-not-print\';\n');

        await expect(auditEnv()).rejects.toThrow('exit 1');

        const text = output.join('\n');

        expect(text).toMatch(/src\/client\.ts:1\S*\s+\S*API_TOKEN\S*\s+\S*read from process\.env/);
        expect(text).toMatch(/src\/env\.schema\.js:3\S*\s+\S*OLD_KEY/);
        expect(text).not.toContain('must-not-print');
    });

    it('exits 0 without findings', async () =>
    {
        writeSchema({ API_TOKEN: {} });
        write('src/client.ts', 'export const token = env.API_TOKEN;\n');

        await auditEnv();

        expect(process.exit).not.toHaveBeenCalled();
        expect(output.join('\n')).toContain('2 file(s) scanned');
    });

    it('exits 1 with the list error when the list cannot be built', async () =>
    {
        writeAppConfig({ schemas: ['src/missing.schema.js'] });

        await expect(auditEnv()).rejects.toThrow('exit 1');
        expect(output.join('\n')).toContain('src/missing.schema.js does not exist');
    });
});
