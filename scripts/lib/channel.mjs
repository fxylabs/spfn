/**
 * The dist-tag a version goes out on, read from the version string:
 * `-alpha` -> alpha, `-beta` -> beta, otherwise latest. Both registries use
 * it — `publish-changed.mjs` for Gitea, `republish.mjs` for npmjs.
 */
export function channelOf(version)
{
    if (version.includes("-alpha"))
    {
        return "alpha";
    }
    if (version.includes("-beta"))
    {
        return "beta";
    }

    return "latest";
}
