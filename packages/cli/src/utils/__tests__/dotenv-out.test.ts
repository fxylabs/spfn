/**
 * Writing an env map as a secret-bearing dotenv file.
 *
 * Pinned: every awkward value — newlines, `#`, each quote character, `=`, edge
 * spaces, backslashes — parses back unchanged through `dotenv` and through
 * `loadEnv`; a value no dotenv form can hold is refused by name; the file lands
 * by rename with mode 0600 and a failed write leaves the old file alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { loadEnv } from '@spfn/core/env/loader';
import { formatDotenv, writePrivateFileAtomic } from '../dotenv-out.js';

const AWKWARD: Record<string, string> = {
    RT_PLAIN: 'value-one',
    RT_EMPTY: '',
    RT_NEWLINES: 'line one\nline two\n\nline four',
    RT_HASH: 'before # after',
    RT_SINGLE_QUOTE: 'it\'s',
    RT_DOUBLE_QUOTE: 'say "hi"',
    RT_BACKTICK: 'run `cmd`',
    RT_TWO_QUOTES: 'it\'s "quoted"',
    RT_EQUALS: 'a=b==c',
    RT_EDGE_SPACES: '  padded  ',
    RT_BACKSLASH_N: 'literal \\n stays',
    RT_TRAILING_BACKSLASH: 'ends-with\\',
    RT_PEM: '-----BEGIN KEY-----\nabc+/=\n-----END KEY-----\n',
    RT_JSON: '{"a":"b\\"c","n":1}',
};

let dir: string;

beforeEach(() =>
{
    dir = mkdtempSync(join(tmpdir(), 'spfn-dotenv-out-'));
});

afterEach(() =>
{
    rmSync(dir, { recursive: true, force: true });
});

describe('formatDotenv', () =>
{
    it('round-trips awkward values through dotenv', () =>
    {
        expect(parse(formatDotenv(AWKWARD))).toEqual(AWKWARD);
    });

    it('round-trips awkward values through loadEnv', () =>
    {
        writeFileSync(join(dir, '.env'), formatDotenv(AWKWARD));

        try
        {
            loadEnv({ cwd: dir, nodeEnv: 'test', server: false });

            for (const [name, value] of Object.entries(AWKWARD))
            {
                expect(process.env[name], name).toBe(value);
            }
        }
        finally
        {
            Object.keys(AWKWARD).forEach((name) => delete process.env[name]);
        }
    });

    it('refuses a value dotenv cannot hold, naming it and not the value', () =>
    {
        const format = () => formatDotenv({ OK: 'value-one', ALL_QUOTES: 'a\'b"c`d\ne' });

        expect(format).toThrow(/ALL_QUOTES/);
        expect(format).not.toThrow(/a'b/);
    });
});

describe('writePrivateFileAtomic', () =>
{
    it('creates the file with mode 0600 and leaves no temp file behind', () =>
    {
        const out = join(dir, 'app.env');
        writeFileSync(out, 'OLD=1\n', { mode: 0o644 });

        writePrivateFileAtomic(out, 'NEW=1\n');

        expect(readFileSync(out, 'utf-8')).toBe('NEW=1\n');
        expect(statSync(out).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir)).toEqual(['app.env']);
    });

    it('leaves the destination untouched when the rename fails', () =>
    {
        const out = join(dir, 'taken');
        // A non-empty directory at the destination makes the rename fail after the temp file is written.
        mkdirSync(join(out, 'child'), { recursive: true });

        expect(() => writePrivateFileAtomic(out, 'NEW=1\n')).toThrow();
        expect(statSync(out).isDirectory()).toBe(true);
        expect(readdirSync(dir)).toEqual(['taken']);
    });
});
