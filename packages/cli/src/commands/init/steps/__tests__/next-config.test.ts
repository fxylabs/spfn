/**
 * `spfn init` writes the two @spfn/auth rewrites into next.config
 * (fxylabs/spfn#149, case A4 of the Sign in with Apple on Android design)
 *
 * | # | next.config before | outcome |
 * | --- | --- | --- |
 * | A4 | none (fresh) | created with both rewrites, each once |
 * | A4 | has the `/_auth/:path*` rewrite only | gains the assetlinks.json rewrite; both once, same destination |
 * | A4b | already has both rewrites | left byte-for-byte unchanged |
 * | A4c | a `rewrites()` without `/_auth` | not patched; the manual block prints both rewrites |
 * | A4d | `const nextConfig = {}` | patched with both rewrites |
 * | F1 | one-line `/_auth` rewrite followed by a later multi-line object at the same indent | only the assetlinks rewrite is added; the later object is untouched |
 * | F2 | one-line `/_auth` rewrite as the array's last element | assetlinks rewrite inserted, nothing else changed |
 * | F3 | one-line `/_auth` rewrite followed by a later `headers()` with multi-line objects at the same indent | only the assetlinks rewrite is added; `headers()` unchanged |
 * | F4 | the multi-line form `spfn init` itself writes | output unchanged from today |
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupNextConfig } from '../next-config.js';

const AUTH_ONLY = `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    reactCompiler: true,

    async rewrites()
    {
        return [
            {
                // Provider callbacks must return to the web origin.
                source: '/_auth/:path*',
                destination: \`\${process.env.SPFN_API_URL || 'http://localhost:8890'}/_auth/:path*\`,
            },
        ];
    },
};

export default nextConfig;
`;

const ONE_LINE_AUTH_THEN_DOCS = `const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/_auth/:path*', destination: \`\${process.env.SPFN_API_URL}/_auth/:path*\` },
      {
        source: '/docs',
        destination: '/documentation',
      },
    ];
  },
};
`;

const ONE_LINE_AUTH_LAST = `const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/_auth/:path*', destination: \`\${process.env.SPFN_API_URL}/_auth/:path*\` },
    ];
  },
};
`;

const ONE_LINE_AUTH_THEN_HEADERS = `const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/_auth/:path*', destination: \`\${process.env.SPFN_API_URL}/_auth/:path*\` },
    ];
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Custom', value: '1' },
        ],
      },
    ];
  },
};
`;

let cwd: string;

function occurrences(content: string, needle: string): number
{
    return content.split(needle).length - 1;
}

function readConfig(): string
{
    return readFileSync(join(cwd, 'next.config.ts'), 'utf-8');
}

beforeEach(() =>
{
    cwd = mkdtempSync(join(tmpdir(), 'spfn-next-config-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() =>
{
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('setupNextConfig', () =>
{
    it('A4: a fresh app gets next.config.ts with both rewrites, each once', async () =>
    {
        await setupNextConfig(cwd, true);

        const content = readConfig();
        expect(occurrences(content, "source: '/_auth/:path*'")).toBe(1);
        expect(occurrences(content, "source: '/.well-known/assetlinks.json'")).toBe(1);
        expect(content).toContain("|| 'http://localhost:8790'}/.well-known/assetlinks.json`");
    });

    it('A4: a config with the /_auth rewrite gains the assetlinks.json rewrite, forwarding to the same API', async () =>
    {
        writeFileSync(join(cwd, 'next.config.ts'), AUTH_ONLY);

        await setupNextConfig(cwd, true);

        const content = readConfig();
        expect(occurrences(content, "source: '/_auth/:path*'")).toBe(1);
        expect(occurrences(content, "source: '/.well-known/assetlinks.json'")).toBe(1);
        expect(content).toContain("|| 'http://localhost:8890'}/.well-known/assetlinks.json`");
        expect(occurrences(content, 'Provider callbacks must return')).toBe(1);
        expect(content).toContain(`            {
                source: '/.well-known/assetlinks.json',
                destination: \`\${process.env.SPFN_API_URL || 'http://localhost:8890'}/.well-known/assetlinks.json\`,
            },
            {
                // Provider callbacks must return to the web origin.
                source: '/_auth/:path*',`);
    });

    it('F1: a one-line /_auth rewrite followed by another object at the same indent only gains the assetlinks rewrite', async () =>
    {
        writeFileSync(join(cwd, 'next.config.ts'), ONE_LINE_AUTH_THEN_DOCS);

        await setupNextConfig(cwd, true);

        expect(readConfig()).toBe(`const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/.well-known/assetlinks.json', destination: \`\${process.env.SPFN_API_URL}/.well-known/assetlinks.json\` },
      { source: '/_auth/:path*', destination: \`\${process.env.SPFN_API_URL}/_auth/:path*\` },
      {
        source: '/docs',
        destination: '/documentation',
      },
    ];
  },
};
`);
    });

    it('F2: a one-line /_auth rewrite that is the array\'s last element gains the assetlinks rewrite', async () =>
    {
        writeFileSync(join(cwd, 'next.config.ts'), ONE_LINE_AUTH_LAST);

        await setupNextConfig(cwd, true);

        expect(readConfig()).toBe(`const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/.well-known/assetlinks.json', destination: \`\${process.env.SPFN_API_URL}/.well-known/assetlinks.json\` },
      { source: '/_auth/:path*', destination: \`\${process.env.SPFN_API_URL}/_auth/:path*\` },
    ];
  },
};
`);
    });

    it('F3: a later headers() with multi-line objects at the same indent is left untouched', async () =>
    {
        writeFileSync(join(cwd, 'next.config.ts'), ONE_LINE_AUTH_THEN_HEADERS);

        await setupNextConfig(cwd, true);

        expect(readConfig()).toBe(`const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/.well-known/assetlinks.json', destination: \`\${process.env.SPFN_API_URL}/.well-known/assetlinks.json\` },
      { source: '/_auth/:path*', destination: \`\${process.env.SPFN_API_URL}/_auth/:path*\` },
    ];
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Custom', value: '1' },
        ],
      },
    ];
  },
};
`);
    });

    it('A4b: a config that already has both rewrites is left unchanged, also on a second run', async () =>
    {
        writeFileSync(join(cwd, 'next.config.ts'), AUTH_ONLY);
        await setupNextConfig(cwd, true);
        const once = readConfig();

        await setupNextConfig(cwd, true);

        expect(readConfig()).toBe(once);
    });

    it('A4c: a rewrites() without /_auth is not patched, and the manual block prints both rewrites', async () =>
    {
        const custom = 'const nextConfig = {\n    async rewrites() { return []; },\n};\nexport default nextConfig;\n';
        writeFileSync(join(cwd, 'next.config.ts'), custom);

        await setupNextConfig(cwd, true);

        expect(readConfig()).toBe(custom);
        const printed = vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
        expect(printed).toContain("source: '/_auth/:path*'");
        expect(printed).toContain("source: '/.well-known/assetlinks.json'");
    });

    it('A4d: an empty nextConfig object is patched with both rewrites', async () =>
    {
        writeFileSync(join(cwd, 'next.config.ts'), 'const nextConfig = {};\nexport default nextConfig;\n');

        await setupNextConfig(cwd, true);

        const content = readConfig();
        expect(occurrences(content, "source: '/_auth/:path*'")).toBe(1);
        expect(occurrences(content, "source: '/.well-known/assetlinks.json'")).toBe(1);
    });

    it('without auth nothing is written', async () =>
    {
        await setupNextConfig(cwd, false);

        expect(() => readConfig()).toThrow();
    });
});
