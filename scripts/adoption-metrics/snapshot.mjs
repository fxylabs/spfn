#!/usr/bin/env node
// Adoption-metrics snapshot: fetches every external adoption signal the project
// tracks and appends one dated row to snapshots.jsonl, then prints the latest
// rows side by side so a weekly review is one command.
//
//   node scripts/adoption-metrics/snapshot.mjs            fetch, append, show
//   node scripts/adoption-metrics/snapshot.mjs --dry      fetch and show, no append
//   node scripts/adoption-metrics/snapshot.mjs --view     show the record only
//
// Signals PostHog and Search Console cannot be fetched without credentials;
// enter them by hand when known:
//
//   --posthog <n>            LLM-referral visits since the last snapshot
//   --gsc-impressions <n>    Search Console impressions
//   --gsc-clicks <n>         Search Console clicks
//   --probe cited|not-cited|not-run   latest citation-probe reading
//
// The record is append-only: a bad row is corrected by appending a new row.

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = join(HERE, 'snapshots.jsonl');
const REPO = 'fxylabs/spfn';
// Accounts that belong to the project. GitHub's author_association alone cannot
// tell them apart: the maintainer authors from a personal account whose
// association is only CONTRIBUTOR, so it must be named here explicitly.
const INTERNAL_USERS = new Set(['tonite31']);

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argOf = (name) =>
{
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
};

async function getJson(url)
{
    const res = await fetch(url, { headers: { 'User-Agent': 'spfn-adoption-metrics' } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}

function packageNames()
{
    const pkgsDir = join(HERE, '..', '..', 'packages');
    return readdirSync(pkgsDir)
        .map((d) => join(pkgsDir, d, 'package.json'))
        .filter((p) => existsSync(p))
        .map((p) => JSON.parse(readFileSync(p, 'utf8')))
        .filter((pkg) => !pkg.private)
        .map((pkg) => pkg.name);
}

async function fetchGithub()
{
    const repo = await getJson(`https://api.github.com/repos/${REPO}`);
    const issues = await getJson(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=100`);
    const internalAssoc = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
    const external = issues.filter((i) => !internalAssoc.has(i.author_association) && !INTERNAL_USERS.has(i.user.login));
    return {
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        watchers: repo.subscribers_count,
        externalIssues: external.filter((i) => !i.pull_request).length,
        externalPRs: external.filter((i) => i.pull_request).length,
    };
}

// npm publishes a day's counts partway through the following day, so which
// seven-day window a run sees depends on when it runs. A run before the roll
// reads the same window yesterday's row read and every package repeats its
// previous number, which is indistinguishable from a day nobody downloaded
// anything. The window travels with the row so the two can be told apart.
async function fetchNpm(names)
{
    const downloads = {};
    let window = null;
    for (const name of names)
    {
        const encoded = name.replace('/', '%2F');
        const d = await getJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`)
            .catch(() => ({ downloads: null }));
        downloads[name] = d.downloads ?? 0;
        if (d.start && d.end) window = { start: d.start, end: d.end };
    }
    return { downloads, window };
}

// PostHog: one project (513406) receives events from several products, so the
// host filter is what scopes the count to superfunction.xyz. The personal API
// key (query:read only) lives in the macOS keychain; its value never reaches
// stdout. Missing key or a failed query degrades to null, and the --posthog
// flag still overrides.
const POSTHOG_PROJECT = 513406;
const LLM_DOMAINS = "'chatgpt.com','chat.openai.com','perplexity.ai','www.perplexity.ai','claude.ai','gemini.google.com','copilot.microsoft.com'";

async function fetchPosthogLlmReferrals()
{
    let key;
    try
    {
        key = execFileSync('security', ['find-generic-password', '-s', 'posthog', '-a', 'personal-api-key', '-w'],
            { encoding: 'utf8' }).trim();
    }
    catch
    {
        return null;
    }
    const query = `select count() from events where event='$pageview' and properties.$host='superfunction.xyz' and properties.$referring_domain in (${LLM_DOMAINS}) and timestamp > now() - interval 7 day`;
    const res = await fetch(`https://us.posthog.com/api/projects/${POSTHOG_PROJECT}/query/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data.results?.[0]?.[0] ?? null;
}

// Search Console: a service account (spfn-metrics@superselfs, added as a
// restricted user on the property) authenticates via a self-signed JWT. The
// key JSON sits base64-encoded in the keychain; like PostHog, a missing entry
// degrades to null and the value never reaches stdout.
const GSC_SITE = 'https://superfunction.xyz/';

function gscKeychainJson()
{
    try
    {
        const b64 = execFileSync('security', ['find-generic-password', '-s', 'gsc', '-a', 'service-account', '-w'],
            { encoding: 'utf8' }).trim();
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    }
    catch
    {
        return null;
    }
}

async function gscAccessToken(sa)
{
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
        aud: sa.token_uri,
        iat: now,
        exp: now + 600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    const res = await fetch(sa.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${signature}`,
    });
    if (!res.ok) return null;
    return (await res.json()).access_token ?? null;
}

async function fetchGsc()
{
    const sa = gscKeychainJson();
    if (!sa) return { impressions: null, clicks: null, sitemapLastRead: null };
    const token = await gscAccessToken(sa);
    if (!token) return { impressions: null, clicks: null, sitemapLastRead: null };
    const site = encodeURIComponent(GSC_SITE);
    const auth = { Authorization: `Bearer ${token}` };

    // Search analytics lags about two days, so the window ends the day before
    // yesterday and covers the seven days up to it.
    const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    const query = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: day(8), endDate: day(2) }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const sitemap = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps/${encodeURIComponent(GSC_SITE + 'sitemap.xml')}`, { headers: auth })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);

    // A failed call (no permission yet, network) is null; a successful call
    // with no rows is a real measured zero.
    return {
        impressions: query === null ? null : (query.rows?.[0]?.impressions ?? 0),
        clicks: query === null ? null : (query.rows?.[0]?.clicks ?? 0),
        sitemapLastRead: sitemap?.lastDownloaded?.slice(0, 10) ?? null,
    };
}

function manualFields()
{
    const num = (name) => (argOf(name) === null ? null : Number(argOf(name)));
    return {
        posthogLlmReferrals: num('--posthog'),
        gscImpressions: num('--gsc-impressions'),
        gscClicks: num('--gsc-clicks'),
        probe: argOf('--probe'),
    };
}

function readRecord()
{
    if (!existsSync(RECORD)) return [];
    return readFileSync(RECORD, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function fmt(value)
{
    return value === null || value === undefined ? '—' : String(value);
}

function delta(curr, prev)
{
    if (typeof curr !== 'number' || typeof prev !== 'number') return '';
    const d = curr - prev;
    return d === 0 ? '' : d > 0 ? ` (+${d})` : ` (${d})`;
}

function printView(rows)
{
    if (rows.length === 0)
    {
        console.log('no snapshots recorded yet');
        return;
    }
    const curr = rows[rows.length - 1];
    const prev = rows.length > 1 ? rows[rows.length - 2] : null;
    console.log(`\nsnapshot ${curr.date}${prev ? ` (vs ${prev.date})` : ' (baseline)'}\n`);

    const line = (label, c, p) => console.log(`  ${label.padEnd(28)} ${fmt(c)}${p === undefined ? '' : delta(c, p)}`);
    line('GitHub stars', curr.github.stars, prev?.github.stars);
    line('GitHub forks', curr.github.forks, prev?.github.forks);
    line('GitHub watchers', curr.github.watchers, prev?.github.watchers);
    line('external issues (all time)', curr.github.externalIssues, prev?.github.externalIssues);
    line('external PRs (all time)', curr.github.externalPRs, prev?.github.externalPRs);
    console.log('');
    const window = curr.npmWindow;
    line('npm window', window ? `${window.start}..${window.end}` : '—');
    for (const [name, n] of Object.entries(curr.npm))
    {
        line(`npm ${name} /wk`, n, prev?.npm[name]);
    }
    if (window && prev?.npmWindow && prev.npmWindow.end === window.end)
    {
        console.log('  ^ same window as the previous row: these counts repeat, they did not stand still');
    }
    console.log('');
    line('PostHog LLM referrals', curr.manual.posthogLlmReferrals, prev?.manual.posthogLlmReferrals);
    line('GSC impressions', curr.manual.gscImpressions, prev?.manual.gscImpressions);
    line('GSC clicks', curr.manual.gscClicks, prev?.manual.gscClicks);
    line('citation probe', curr.manual.probe ?? 'not-run');
    line('sitemap last read', curr.sitemapLastRead ?? '—');
    console.log('');
}

if (has('--view'))
{
    printView(readRecord());
    process.exit(0);
}

// One row per date: a rerun on a day that already has its row (manual run after
// the scheduled one, or vice versa) must not duplicate it.
const today = new Date().toISOString().slice(0, 10);
if (!has('--dry') && readRecord().some((r) => r.date === today))
{
    console.log(`snapshot for ${today} already recorded; skipping`);
    process.exit(0);
}

const manual = manualFields();
if (manual.posthogLlmReferrals === null)
{
    manual.posthogLlmReferrals = await fetchPosthogLlmReferrals();
}
let sitemapLastRead = null;
if (manual.gscImpressions === null || manual.gscClicks === null)
{
    const gsc = await fetchGsc();
    manual.gscImpressions = manual.gscImpressions ?? gsc.impressions;
    manual.gscClicks = manual.gscClicks ?? gsc.clicks;
    sitemapLastRead = gsc.sitemapLastRead;
}

const npm = await fetchNpm(packageNames());
const row = {
    date: new Date().toISOString().slice(0, 10),
    github: await fetchGithub(),
    npm: npm.downloads,
    npmWindow: npm.window,
    manual,
    sitemapLastRead,
};

if (has('--dry'))
{
    printView([...readRecord(), row]);
    process.exit(0);
}

appendFileSync(RECORD, JSON.stringify(row) + '\n');
printView(readRecord());
