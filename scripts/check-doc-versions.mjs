#!/usr/bin/env node
// Prose drifts away from package.json quietly. Five separate READMEs still told adopters
// that Next.js 15 was supported months after the peer ranges moved to ^16.2.11, and
// nothing failed — a version floor is a security surface, so a stale one ships a
// vulnerable range to every app that trusts the sentence.
//
// Four rules, all mechanical:
//   1. Every package declaring a `next` peer declares the same range.
//   2. Every prose sentence stating a Next.js requirement states that same version.
//   3. The root and every package declaring `engines.node` declare the same range.
//   4. Every prose sentence stating a Node requirement names one of that range's floors.
//
// Node joined on 2026-10-27. Node 20 reached end of life without the fix for
// CVE-2026-111497 (remote code execution in the bundled Brotli decoder), so every
// package moved to one range of patched releases, and a sentence still saying
// "Node 20+" now tells an adopter to run a runtime that will not be fixed.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A requirement reads as a range (`^16.4.1`), a comparison (`>= 16.4.1`), a floor (`16.4.1+`)
// or a bound ("16.4.1 or later"). A bare number is not a requirement — the paragraph explaining
// why 15.0.5 and 15.1.9 are insufficient must not trip this. The lookbehind and the
// two-digit major keep port numbers out: "Next.js :3790 + SPFN API" is not a version.
const REQUIREMENT =
    /next(?:\.js)?[^\n]{0,30}?(\^[\d.]+|>=\s*[\d.]+|(?<![:.\d])\d{1,2}(?:\.\d+)*\s*(?:or later|\+))/gi;

// A Node requirement reads as a comparison ("Node ≥ 22.23.4", "Node.js >= 22.23.4") or a
// floor ("Node.js 22.23.4+", "Node 22.23.4 or later", a table cell "| Node.js | 22.23.4+ |").
// "node:22-alpine" and "Node 20 left maintenance" are not requirements and do not match.
const NODE_REQUIREMENT =
    /node(?:\.js)?[^\n|]{0,6}?(?:>=|≥)\s*`?v?(\d{1,2}(?:\.\d+){0,2})|node(?:\.js)?[\s|`]{0,6}(\d{1,2}(?:\.\d+){0,2})\s*(?:\+|or (?:later|newer))/gi;

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

function declaredNodeRange()
{
    const found = new Map([['package.json', readManifest('package.json').engines?.node]]);

    for (const name of readdirSync(join(ROOT, 'packages')))
    {
        const manifest = `packages/${name}/package.json`;
        if (!existsSync(join(ROOT, manifest))) continue;

        const range = readManifest(manifest).engines?.node;
        if (range) found.set(manifest, range);
    }

    const ranges = [...new Set(found.values())];
    if (ranges.length !== 1 || !ranges[0])
    {
        console.error('The root and the packages disagree on engines.node:\n');
        for (const [manifest, range] of found) console.error(`  ${manifest}: ${range}`);
        console.error('\nOne Node range, declared the same way everywhere.');
        process.exit(1);
    }

    // `^22.23.4 || ^24.22.1 || >=26.12.1` → the floors a sentence may name.
    const floors = ranges[0].split('||').map(part => part.trim().replace(/^[^\d]*/, ''));

    return { range: ranges[0], floors };
}

function readManifest(path)
{
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function nextProblems(file, text, floor)
{
    const problems = [];

    for (const match of text.matchAll(REQUIREMENT))
    {
        const stated = match[1].replace(/>=\s*|[\^+]|\s*or later/g, '').trim();
        if (stated === floor.version) continue;

        problems.push(`${file}:${lineOf(text, match.index)} states Next.js ${stated}, `
            + `but the packages require ${floor.range} — "${match[0].trim()}"`);
    }

    return problems;
}

function nodeProblems(file, text, node)
{
    const problems = [];

    for (const match of text.matchAll(NODE_REQUIREMENT))
    {
        const stated = match[1] ?? match[2];
        if (node.floors.includes(stated)) continue;

        problems.push(`${file}:${lineOf(text, match.index)} states Node ${stated}, `
            + `but the packages require ${node.range} — "${match[0].trim()}"`);
    }

    return problems;
}

const floor = declaredFloor();
const node = declaredNodeRange();
const problems = [];

for (const file of proseFiles())
{
    const text = readFileSync(join(ROOT, file), 'utf8');

    problems.push(...nextProblems(file, text, floor), ...nodeProblems(file, text, node));
}

if (problems.length)
{
    console.error('The docs disagree with the declared version floors:\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`\nNext.js ${floor.range}, Node ${node.range}. Fix the prose, or change every package.json first.`);
    process.exit(1);
}

console.log(`Next.js floor ${floor.range} and Node range ${node.range} — every package and doc agrees.`);
