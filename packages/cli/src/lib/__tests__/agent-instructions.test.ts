import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { syncAgentInstructions } from '../agent-instructions.js';
import { BEGIN_MARKER, END_MARKER, renderAgentInstructions } from '../agent-instructions-template.js';

let projectRoot: string;
const savedEnv = process.env.SPFN_AGENT_FILES;

beforeEach(() =>
{
    projectRoot = mkdtempSync(join(tmpdir(), 'spfn-agent-instructions-'));
    delete process.env.SPFN_AGENT_FILES;
});

afterEach(() =>
{
    rmSync(projectRoot, { recursive: true, force: true });

    if (savedEnv === undefined)
    {
        delete process.env.SPFN_AGENT_FILES;
    }
    else
    {
        process.env.SPFN_AGENT_FILES = savedEnv;
    }
});

function agentsPath(): string
{
    return join(projectRoot, 'AGENTS.md');
}

function readAgents(): string
{
    return readFileSync(agentsPath(), 'utf8');
}

describe('syncAgentInstructions — case table', () =>
{
    it('AGENTS.md absent → creates a file containing only the block', () =>
    {
        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('created');
        expect(readAgents()).toBe(`${renderAgentInstructions()}\n`);
    });

    it('present without markers → appends the block after one blank line', () =>
    {
        writeFileSync(agentsPath(), '# House rules\n\nUse tabs.\n', 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('appended');
        expect(readAgents()).toBe(`# House rules\n\nUse tabs.\n\n${renderAgentInstructions()}\n`);
    });

    it('present but empty → appends the block with no leading blank lines', () =>
    {
        writeFileSync(agentsPath(), '', 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('appended');
        expect(readAgents()).toBe(`${renderAgentInstructions()}\n`);
    });

    it('present with markers and stale content → replaces between the markers only, rest byte-identical', () =>
    {
        const before = '# Mine\n\nKeep me.\n';
        const after = '\n## Trailing section\n\nKeep me too.\n';
        writeFileSync(agentsPath(), `${before}${BEGIN_MARKER}\nold and stale\n${END_MARKER}\n${after}`, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('replaced');
        expect(readAgents()).toBe(`${before}${renderAgentInstructions()}\n${after}`);
    });

    it('present with markers and current content → writes nothing at all (mtime untouched)', () =>
    {
        writeFileSync(agentsPath(), `${renderAgentInstructions()}\n`, 'utf8');
        const before = statSync(agentsPath());

        const result = syncAgentInstructions(projectRoot);
        const after = statSync(agentsPath());

        expect(result.action).toBe('unchanged');
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.ctimeMs).toBe(before.ctimeMs);
    });

    it('user edited inside the markers → replaced on the next sync', () =>
    {
        const edited = renderAgentInstructions().replace('**Auth.**', '**Auth (I changed this).**');
        writeFileSync(agentsPath(), `${edited}\n`, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('replaced');
        expect(readAgents()).toBe(`${renderAgentInstructions()}\n`);
    });

    it('begin marker without an end marker → file untouched, one warning naming the fix', () =>
    {
        const original = `# Mine\n\n${BEGIN_MARKER}\nhalf a block\n`;
        writeFileSync(agentsPath(), original, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('skipped');
        expect(result.warning).toContain('malformed');
        expect(result.warning).toContain(END_MARKER);
        expect(readAgents()).toBe(original);
    });

    it('reversed markers → file untouched, one warning', () =>
    {
        const original = `${END_MARKER}\nbackwards\n${BEGIN_MARKER}\n`;
        writeFileSync(agentsPath(), original, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('skipped');
        expect(result.warning).toBeDefined();
        expect(readAgents()).toBe(original);
    });

    it('CLAUDE.md absent → created with an @AGENTS.md reference line', () =>
    {
        syncAgentInstructions(projectRoot);

        expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    });

    it('CLAUDE.md present → never touched, whatever it contains', () =>
    {
        const mine = 'my own rules, no reference at all\n';
        writeFileSync(join(projectRoot, 'CLAUDE.md'), mine, 'utf8');
        const before = statSync(join(projectRoot, 'CLAUDE.md'));

        syncAgentInstructions(projectRoot);

        expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8')).toBe(mine);
        expect(statSync(join(projectRoot, 'CLAUDE.md')).mtimeMs).toBe(before.mtimeMs);
    });

    it('opt-out via SPFN_AGENT_FILES=0 → nothing written, skipped', () =>
    {
        process.env.SPFN_AGENT_FILES = '0';

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('skipped');
        expect(existsSync(agentsPath())).toBe(false);
        expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(false);
    });

    it('opt-out via --no-agent-files → nothing written, skipped', () =>
    {
        const result = syncAgentInstructions(projectRoot, { agentFiles: false });

        expect(result.action).toBe('skipped');
        expect(existsSync(agentsPath())).toBe(false);
        expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(false);
    });
});

describe('syncAgentInstructions — defect anticipation', () =>
{
    it('prose that merely mentions a marker string is not a boundary', () =>
    {
        const prose = `Our tool writes ${BEGIN_MARKER} into the file.\n`;
        writeFileSync(agentsPath(), prose, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('appended');
        expect(readAgents()).toBe(`${prose.trimEnd()}\n\n${renderAgentInstructions()}\n`);
    });

    it('a complete marker pair quoted inside a code fence is not the block → appends', () =>
    {
        const documentation = '# How the block works\n\n'
            + '```markdown\n'
            + BEGIN_MARKER + '\n'
            + 'the generated instructions land here\n'
            + END_MARKER + '\n'
            + '```\n';
        writeFileSync(agentsPath(), documentation, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('appended');
        expect(readAgents()).toBe(`${documentation}\n${renderAgentInstructions()}\n`);
    });

    it('a fenced begin marker beside a real pair → only the real pair is replaced', () =>
    {
        const quoted = '# How the block works\n\n'
            + '~~~markdown\n'
            + BEGIN_MARKER + '\n'
            + '~~~\n\n';
        writeFileSync(agentsPath(), `${quoted}${BEGIN_MARKER}\nold and stale\n${END_MARKER}\n`, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('replaced');
        expect(readAgents()).toBe(`${quoted}${renderAgentInstructions()}\n`);
    });

    it('an unterminated fence hides the markers → appends, and never destroys what is there', () =>
    {
        // CommonMark reads an unclosed fence as running to the end of the file,
        // so the markers below it really are code. Being conservative costs one
        // duplicate block and, on the next sync, the malformed warning — it
        // never costs the user a line of text.
        const original = '# Mine\n\n```text\nI forgot to close this\n'
            + BEGIN_MARKER + '\nmine, not the tool\'s\n'
            + END_MARKER + '\n';
        writeFileSync(agentsPath(), original, 'utf8');

        expect(syncAgentInstructions(projectRoot).action).toBe('appended');
        expect(readAgents().startsWith(original)).toBe(true);

        const second = syncAgentInstructions(projectRoot);
        expect(second.action).toBe('skipped');
        expect(second.warning).toContain('malformed');
        expect(readAgents().startsWith(original)).toBe(true);
    });

    it('a UTF-8 BOM does not make the file malformed, and is not written back', () =>
    {
        writeFileSync(agentsPath(), `\uFEFF${BEGIN_MARKER}\nold and stale\n${END_MARKER}\n`, 'utf8');

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('replaced');
        expect(readAgents()).toBe(`${renderAgentInstructions()}\n`);
    });

    it('a version bump rewrites the block exactly once', () =>
    {
        writeFileSync(agentsPath(), `${renderAgentInstructions('0.0.1-previous')}\n`, 'utf8');

        expect(syncAgentInstructions(projectRoot).action).toBe('replaced');
        expect(syncAgentInstructions(projectRoot).action).toBe('unchanged');
    });

    it('writes only under projectRoot — a parent AGENTS.md is never walked up to', () =>
    {
        const parentFile = join(projectRoot, 'AGENTS.md');
        writeFileSync(parentFile, 'monorepo root rules\n', 'utf8');
        const appRoot = join(projectRoot, 'apps', 'web');
        mkdirSync(appRoot, { recursive: true });

        const result = syncAgentInstructions(appRoot);

        expect(result.action).toBe('created');
        expect(readFileSync(parentFile, 'utf8')).toBe('monorepo root rules\n');
        expect(readFileSync(join(appRoot, 'AGENTS.md'), 'utf8')).toBe(`${renderAgentInstructions()}\n`);
    });

    it('a CRLF file round-trips without churn', () =>
    {
        const block = renderAgentInstructions().split('\n').join('\r\n');
        writeFileSync(agentsPath(), `# Mine\r\n\r\n${block}\r\n`, 'utf8');
        const before = statSync(agentsPath());

        const result = syncAgentInstructions(projectRoot);

        expect(result.action).toBe('unchanged');
        expect(statSync(agentsPath()).mtimeMs).toBe(before.mtimeMs);
    });
});

describe('renderAgentInstructions', () =>
{
    it('carries the markers, the version line and every pointer the block promises', () =>
    {
        const block = renderAgentInstructions('9.9.9');

        expect(block.startsWith(`${BEGIN_MARKER}\n`)).toBe(true);
        expect(block.endsWith(`\n${END_MARKER}`)).toBe(true);
        expect(block).toContain('<!-- spfn CLI v9.9.9 -->');
        expect(block).toContain('class OrderRepository extends BaseRepository');
        expect(block).toContain('its repository extends `TenantRepository` instead');
        expect(block).toContain('node_modules/@spfn/core/src/db/README.md');
        expect(block).toContain('node_modules/@spfn/auth/README.md');
        expect(block).toContain('https://superfunction.xyz/docs/packages/core/<module>');
        expect(block).toContain('https://superfunction.xyz/docs/guides/<guide>');
    });

    it('names only routes the site serves, and never invites a guess', () =>
    {
        const block = renderAgentInstructions('9.9.9');
        const flowed = block.replace(/\s+/g, ' ');

        // The served set from spfn.site.yaml: site/pages/docs/packages/core/*.md
        // and the docs/guides mount. An ellipsis here would have agents inventing
        // module names that 404.
        expect(flowed).toContain('for cache, codegen, config, db, env, errors, event, job, logger, middleware, nextjs, route, security and server');
        expect(flowed).toContain('for authentication, custom-generators, deployment, file-upload, monitoring and websockets');
        expect(block).not.toContain('…');
    });
});
