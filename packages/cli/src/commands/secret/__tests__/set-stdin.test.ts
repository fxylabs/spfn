/**
 * `spfn secret set --stdin` and `--instance`.
 *
 * Pinned: stdin is the whole value with exactly one trailing newline dropped and
 * inner newlines kept; `--stdin` never prompts; `--instance` writes
 * `secrets/<env>.<instance>.enc.json` through the same `.sops.yaml` rule as the
 * environment file — both on creation and on update. Runs real `sops` and `age`
 * with a throwaway key; values are asserted by decrypting, never printed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { execa } from 'execa';
import { sopsDecrypt } from '../../../utils/sops.js';

const prompts = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({ default: prompts }));

const { readValueFromStdin, secretSet, stripTrailingNewline } = await import('../set.js');

let keysDir: string;
let dir: string;
let previousCwd: string;
let previousStdin: NodeJS.ReadStream;

beforeAll(async () =>
{
    keysDir = mkdtempSync(join(tmpdir(), 'spfn-set-keys-'));
    await execa('age-keygen', ['-o', join(keysDir, 'key.txt')]);
});

afterAll(() =>
{
    rmSync(keysDir, { recursive: true, force: true });
});

beforeEach(async () =>
{
    dir = mkdtempSync(join(tmpdir(), 'spfn-set-'));
    const { stdout: recipient } = await execa('age-keygen', ['-y', join(keysDir, 'key.txt')]);
    writeFileSync(join(dir, '.sops.yaml'), `creation_rules:\n  - path_regex: secrets/.*\\.enc\\.json$\n    age: ${recipient}\n`);
    vi.stubEnv('SOPS_AGE_KEY_FILE', join(keysDir, 'key.txt'));
    previousCwd = process.cwd();
    previousStdin = process.stdin;
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() =>
{
    process.chdir(previousCwd);
    Object.defineProperty(process, 'stdin', { value: previousStdin, configurable: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    prompts.mockReset();
    rmSync(dir, { recursive: true, force: true });
});

function pipeStdin(...chunks: string[]): void
{
    Object.defineProperty(process, 'stdin', { value: Readable.from(chunks), configurable: true });
}

describe('stripTrailingNewline', () =>
{
    it('drops exactly one trailing newline and keeps inner ones', () =>
    {
        expect(stripTrailingNewline('value-one\n')).toBe('value-one');
        expect(stripTrailingNewline('line one\nline two\n\n')).toBe('line one\nline two\n');
        expect(stripTrailingNewline('line one\nline two')).toBe('line one\nline two');
        expect(stripTrailingNewline('value-one\r\n')).toBe('value-one');
    });
});

describe('readValueFromStdin', () =>
{
    it('reads the whole stream across chunks', async () =>
    {
        const value = await readValueFromStdin(Readable.from(['line one\nli', 'ne two\n']));

        expect(value).toBe('line one\nline two');
    });
});

describe('spfn secret set --stdin', () =>
{
    it('stores the piped value in the instance file and never prompts', async () =>
    {
        pipeStdin('-----BEGIN KEY-----\nvalue-one\n-----END KEY-----\n');

        await secretSet('SIGNING_KEY', { env: 'staging', instance: 'blue', stdin: true });

        expect(prompts).not.toHaveBeenCalled();
        expect(existsSync(join(dir, 'secrets/staging.enc.json'))).toBe(false);
        expect(await sopsDecrypt(join(dir, 'secrets/staging.blue.enc.json'))).toEqual({
            SIGNING_KEY: '-----BEGIN KEY-----\nvalue-one\n-----END KEY-----',
        });
    });

    it('updates an existing file with the value on stdin, not as an argument', async () =>
    {
        pipeStdin('value-one\n');
        await secretSet('API_KEY', { env: 'staging', stdin: true });
        pipeStdin('value-two\n\n');
        await secretSet('API_KEY', { env: 'staging', stdin: true });

        expect(prompts).not.toHaveBeenCalled();
        expect(await sopsDecrypt(join(dir, 'secrets/staging.enc.json'))).toEqual({ API_KEY: 'value-two\n' });
    });

    it('refuses an invalid instance name', async () =>
    {
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        pipeStdin('value-one\n');

        await expect(secretSet('API_KEY', { env: 'staging', instance: 'Blue_1', stdin: true })).rejects.toThrow('exit 1');
        expect(existsSync(join(dir, 'secrets'))).toBe(false);
    });
});
