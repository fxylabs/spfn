import { compareVersions, parseVersion } from '../../../kit/version.js';

/**
 * The Node range an SPFN app declares: a release on each supported line that
 * carries the fix for CVE-2026-111497, the remote code execution in the bundled
 * Brotli decoder patched on 2026-10-21. Node 20 reached end of life without that
 * fix, and the odd lines 23 and 25 are out of support, so neither is admitted.
 *
 * The repository root and every package that declares `engines.node` state the
 * same range; `pnpm check:versions` fails when one of them drifts.
 */
export const NODE_ENGINE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1';

/** The versions from `from` up to, not including, `to`; `to: null` is unbounded. */
interface Interval
{
    from: string;
    to: string | null;
}

/**
 * Whether every Node version `range` admits is also admitted by
 * {@link NODE_ENGINE_RANGE}, so an app's own stricter range can be kept.
 *
 * Only the shapes a person writes in `engines` are read: `^x.y.z`, `~x.y.z`,
 * `>=x.y.z` and `>=x.y.z <x.y.z`, joined by `||`. Anything else answers `false`
 * — an unreadable range is replaced, never trusted.
 */
export function admitsOnlyPatchedNode(range: string): boolean
{
    const allowed = intervalsOf(NODE_ENGINE_RANGE);
    const requested = intervalsOf(range);

    if (allowed === null || requested === null)
    {
        return false;
    }

    return requested.every(inner => allowed.some(outer => contains(outer, inner)));
}

function intervalsOf(range: string): Interval[] | null
{
    const intervals = range.split('||').map(intervalOf);

    return intervals.every(interval => interval !== null) ? intervals as Interval[] : null;
}

function intervalOf(alternative: string): Interval | null
{
    const tokens = alternative.trim().split(/\s+/).filter(token => token.length > 0);

    if (tokens.length === 1)
    {
        return singleComparatorInterval(tokens[0]);
    }

    if (tokens.length === 2)
    {
        const from = versionAfter(tokens[0], '>=');
        const to = versionAfter(tokens[1], '<');

        return from && to ? { from, to } : null;
    }

    return null;
}

function singleComparatorInterval(token: string): Interval | null
{
    const caret = versionAfter(token, '^');
    if (caret)
    {
        const { major } = parseVersion(caret)!;

        return { from: caret, to: `${major + 1}.0.0` };
    }

    const tilde = versionAfter(token, '~');
    if (tilde)
    {
        const { major, minor } = parseVersion(tilde)!;

        return { from: tilde, to: `${major}.${minor + 1}.0` };
    }

    const floor = versionAfter(token, '>=');

    return floor ? { from: floor, to: null } : null;
}

/** The plain `x.y.z` after `operator`, or null when the token is anything else. */
function versionAfter(token: string, operator: string): string | null
{
    if (!token.startsWith(operator))
    {
        return null;
    }

    const version = token.slice(operator.length).replace(/^v/, '');
    const parsed = parseVersion(version);

    return parsed && parsed.prerelease.length === 0 ? version : null;
}

function contains(outer: Interval, inner: Interval): boolean
{
    if (compareVersions(inner.from, outer.from) < 0)
    {
        return false;
    }

    if (outer.to === null)
    {
        return true;
    }

    return inner.to !== null && compareVersions(inner.to, outer.to) <= 0;
}
