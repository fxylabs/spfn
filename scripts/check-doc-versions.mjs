#!/usr/bin/env node
// Prose drifts away from package.json quietly. Five separate READMEs still told adopters
// that Next.js 15 was supported months after the peer ranges moved to ^16.2.11, and
// nothing failed — a version floor is a security surface, so a stale one ships a
// vulnerable range to every app that trusts the sentence.
//
// Two rules, both mechanical:
//   1. Every package declaring a `next` peer declares the same range.
//   2. Every prose sentence stating a Next.js requirement states that same version.
//
// Node is deliberately not checked: 18.18 and 20 are both correct depending on the
// package (@spfn/mcp needs 20), so there is no single value to compare against.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A requirement reads as a range (`^16.2.11`), a floor (`16.2.11+`) or a bound
// ("16.2.11 or later"). A bare number is not a requirement — the paragraph explaining
// why 15.0.5 and 15.1.9 are insufficient must not trip this. The lookbehind and the
// two-digit major keep port numbers out: "Next.js :3790 + SPFN API" is not a version.
const REQUIREMENT =
    /next(?:\.js)?[^\n]{0,30}?(\^[\d.]+|(?<![:.\d])\d{1,2}(?:\.\d+)*\s*(?:or later|\+))/gi;

function declaredFloor()
{
    const dir = join(ROOT, 'packages');
    const found = new Map();

    for (const name of readdirSync(dir))
    {
        const manifest = join(dir, name, 'package.json');
        if (!existsSync(manifest)) continue;

        const range = JSON.parse(readFileSync(manifest, 'utf8')).peerDependencies?.next;
        if (range) found.set(name, range);
    }

    const ranges = [...new Set(found.values())];
    if (ranges.length !== 1)
    {
        console.error('Packages disagree on the Next.js peer range:\n');
        for (const [name, range] of found) console.error(`  packages/${name}: ${range}`);
        console.error('\nOne floor, declared the same way everywhere.');
        process.exit(1);
    }

    return { range: ranges[0], version: ranges[0].replace(/^[^\d]*/, '') };
}

function proseFiles()
{
    const files = ['README.md', 'CONTRIBUTING.md', 'site/pages/docs.md'];

    for (const group of ['packages', 'examples'])
    {
        const dir = join(ROOT, group);
        if (!existsSync(dir)) continue;

        for (const name of readdirSync(dir))
        {
            const readme = `${group}/${name}/README.md`;
            if (existsSync(join(ROOT, readme))) files.push(readme);
        }
    }

    const docs = join(ROOT, 'docs');
    const walk = (dir) =>
    {
        for (const entry of readdirSync(dir, { withFileTypes: true }))
        {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith('.md')) files.push(relative(ROOT, path));
        }
    };
    if (existsSync(docs)) walk(docs);

    return files;
}

function lineOf(text, index)
{
    return text.slice(0, index).split('\n').length;
}

const floor = declaredFloor();
const problems = [];

for (const file of proseFiles())
{
    const text = readFileSync(join(ROOT, file), 'utf8');

    for (const match of text.matchAll(REQUIREMENT))
    {
        const stated = match[1].replace(/[\^+]|\s*or later/g, '').trim();
        if (stated === floor.version) continue;

        problems.push(`${file}:${lineOf(text, match.index)} states Next.js ${stated}, `
            + `but the packages require ${floor.range} — "${match[0].trim()}"`);
    }
}

if (problems.length)
{
    console.error(`Next.js version floor is ${floor.range}, and the docs disagree:\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('\nFix the prose, or change every package.json peer range first.');
    process.exit(1);
}

console.log(`Next.js floor ${floor.range} — every package and doc agrees.`);
