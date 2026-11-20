import { execFileSync } from 'node:child_process';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import madge from 'madge';
import { afterAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONAL_PEERS = ['@google-cloud/kms', '@aws-sdk/client-kms'];

async function dependencyGraph(entry: string): Promise<Record<string, string[]>>
{
    const result = await madge(join(PACKAGE_ROOT, entry), {
        fileExtensions: ['ts'],
        includeNpm: true,
        tsConfig: join(PACKAGE_ROOT, 'tsconfig.json'),
    });

    return result.obj();
}

/** Every module the graph reaches, as one flat list of specifiers. */
function reached(graph: Record<string, string[]>): string[]
{
    return [...new Set(Object.values(graph).flat())];
}

const scratch = mkdtempSync(join(tmpdir(), 'spfn-signing-exports-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** One temporary out-dir per package root built, so each root builds once. */
const outDirs = new Map<string, string>();

/**
 * Build a package root into a temporary directory and name one built entry.
 *
 * Never the root's own `dist/`: reusing whatever is already there re-certifies
 * a build that may predate the change under test, which is the one thing this
 * file exists to catch. The declarations are skipped because the claim is
 * about what the JavaScript resolves at load time.
 *
 * `root` is a parameter so X3 can aim the same code at a package root carrying
 * a planted stale `dist/`, rather than planting one in the repository's.
 */
function built(entry: string, root: string = PACKAGE_ROOT): string
{
    return join(outDirs.get(root) ?? buildOnce(root), entry);
}

function buildOnce(root: string): string
{
    const outDir = mkdtempSync(join(scratch, 'build-'));

    execFileSync(
        join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsup'),
        ['--out-dir', outDir, '--no-dts', '--no-sourcemap'],
        { cwd: root, encoding: 'utf8' },
    );
    outDirs.set(root, outDir);

    return outDir;
}

/**
 * A second package root, sharing this one's sources, whose `dist/` holds an
 * artifact from before the change.
 *
 * Symlinks rather than copies: the build has to compile the same `src/` this
 * test run is about. The repository's own `dist/` is never written — a run
 * killed between the write and its restore would otherwise leave a poisoned
 * artifact in the directory `package.json` publishes.
 */
function rootWithStaleDist(): string
{
    const root = mkdtempSync(join(scratch, 'stale-root-'));

    for (const shared of ['src', 'node_modules', 'package.json', 'tsconfig.json', 'tsup.config.ts'])
    {
        symlinkSync(join(PACKAGE_ROOT, shared), join(root, shared));
    }

    mkdirSync(join(root, 'dist'));
    writeFileSync(
        join(root, 'dist', 'verify.js'),
        'export const verifyJws = "a build from before the change";\n',
    );

    return root;
}

/**
 * Import a built entry point from outside the repository, in a fresh Node
 * process given no help finding modules.
 *
 * Copying the build — the entry and the chunks it shares with the other
 * entry — to a temporary directory is the point: nothing above it has a
 * `node_modules`, so any bare specifier that is not a Node builtin fails to
 * resolve. That is stricter than uninstalling the optional peers —
 * this workspace's pnpm installs them for the developer's convenience
 * whatever the manifest says they are.
 */
function importInCleanProcess(entry: string, root: string = PACKAGE_ROOT): string[]
{
    const copy = join(mkdtempSync(join(scratch, 'import-')), basename(entry));

    cpSync(dirname(built(entry, root)), dirname(copy), { recursive: true });

    const script = `import(${JSON.stringify(pathToFileURL(copy).href)})`
        + '.then((m) => console.log(Object.keys(m).sort().join(",")))';
    const environment = { ...process.env };

    delete environment.NODE_PATH;
    delete environment.NODE_OPTIONS;

    return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: scratch,
        env: environment,
        encoding: 'utf8',
    }).trim().split(',');
}

describe('entry points', () =>
{
    it('X1: the verifier reaches nothing outside node: builtins', async () =>
    {
        expect(reached(await dependencyGraph('src/verify.ts')).filter((m) => m.includes('node_modules')))
            .toEqual([]);
    });

    it('X1: the main entry never reaches a KMS SDK statically', async () =>
    {
        const graph = reached(await dependencyGraph('src/index.ts'));

        expect(graph.filter((m) => m.includes('node_modules'))).toEqual([]);

        for (const peer of OPTIONAL_PEERS)
        {
            expect(graph.some((module) => module.includes(peer)), peer).toBe(false);
        }
    });

    it('X1: both entry points import where no dependency could be resolved', () =>
    {
        expect(importInCleanProcess('verify.js')).toContain('verifyJws');
        expect(importInCleanProcess('index.js')).toContain('createSigner');
    });

    it('X3: certifies a fresh build, not whatever is left in dist/', () =>
    {
        // The one test that guards "verify depends on node:crypto and nothing
        // else" is worthless if it re-certifies an artifact from before the
        // change under test. The stale dist/ that would pass it is planted in a
        // package root of this test's own making, and the build is aimed there.
        const exported = importInCleanProcess('verify.js', rootWithStaleDist());

        expect(exported).toContain('parseCompact');
        expect(exported).not.toEqual(['verifyJws']);
    });

    it('X1: the KMS SDKs are declared optional peers and required by nothing', () =>
    {
        const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

        for (const peer of OPTIONAL_PEERS)
        {
            expect(manifest.peerDependencies?.[peer], peer).toBeTruthy();
            expect(manifest.peerDependenciesMeta?.[peer]?.optional, peer).toBe(true);
            expect(manifest.dependencies?.[peer], peer).toBeUndefined();
            expect(manifest.devDependencies?.[peer], peer).toBeUndefined();
        }
    });
});
