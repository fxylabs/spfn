/**
 * Semantic Versioning 2.0.0 precedence (semver.org, §11), for deciding whether
 * a dist-tag may move to a version: `1.0.0-alpha.9 < 1.0.0-beta.1 <
 * 1.0.0-beta.10 < 1.0.0 < 1.1.0-alpha.1`. Dependency-free because the publish
 * workflow runs it without installing the workspace.
 */

const NUMERIC = /^\d+$/;

function parse(version)
{
    const [withoutBuild] = version.split("+");
    const dash = withoutBuild.indexOf("-");

    return {
        core: (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split(".").map(Number),
        prerelease: dash < 0 ? [] : withoutBuild.slice(dash + 1).split("."),
    };
}

/** Numeric identifiers compare as numbers and sort before alphanumeric ones, which compare in ASCII order. */
function compareIdentifiers(a, b)
{
    if (NUMERIC.test(a) && NUMERIC.test(b))
    {
        return Number(a) - Number(b);
    }
    if (NUMERIC.test(a) !== NUMERIC.test(b))
    {
        return NUMERIC.test(a) ? -1 : 1;
    }

    return a < b ? -1 : Number(a > b);
}

/** A version without pre-release identifiers is the newer; otherwise the first differing identifier decides, then the longer list. */
function comparePrereleases(a, b)
{
    if (a.length === 0 || b.length === 0)
    {
        return b.length - a.length;
    }

    const differing = a.findIndex((identifier, index) => index < b.length && compareIdentifiers(identifier, b[index]) !== 0);

    return differing < 0 ? a.length - b.length : compareIdentifiers(a[differing], b[differing]);
}

/** Negative, zero or positive as `a` is older than, as old as, or newer than `b`. Build metadata is ignored. */
export function compareVersions(a, b)
{
    const left = parse(a);
    const right = parse(b);
    const coreDifference = left.core.map((part, index) => part - right.core[index]).find((difference) => difference !== 0);

    return coreDifference ?? comparePrereleases(left.prerelease, right.prerelease);
}
