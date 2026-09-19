/**
 * The browser family a `user-agent` names — five badges, and nothing else.
 *
 * A bound session records the family it was sealed from and the Next.js proxy
 * compares every later request against it (#97). The comparison has to be coarse
 * on purpose: a version bump, a minor-version reduction, a platform token that
 * changes when someone taps "Request desktop site" must all still be the same
 * browser, or the check signs people out for ordinary acts instead of catching
 * the cookie that moved to another machine.
 *
 * A fixed table rather than a parsing dependency. `package.json` carries no
 * user-agent parser and adding one to answer a five-valued question would be out
 * of proportion; the table below is the whole of what this package needs to know
 * about user-agent strings.
 *
 * @module server/lib/ua-family
 */

/**
 * The five answers, and deliberately no sixth.
 *
 * There is no desktop/mobile axis. Android's "Request desktop site" flips the
 * platform token on the same browser in the same cookie jar, and a session that
 * refused after that would be a support ticket for a thing the user did on
 * purpose. What this check is looking for is a cookie that moved to a *different*
 * browser, and the browser is what the badge names.
 */
export const UA_FAMILIES = ['edge', 'chrome', 'firefox', 'safari', 'other'] as const;

export type UaFamily = typeof UA_FAMILIES[number];

/**
 * The markers, in the only order that works.
 *
 * Every entry below is a superstring of the next one's claim, which is why this
 * is a list and not a map: post-reduction Chrome sends `… Chrome/141.0.0.0
 * Safari/537.36`, and Edge sends that plus `Edg/`. Matched the other way round
 * every Edge user reads as chrome and every Chrome user risks reading as safari.
 *
 * iOS has no engines, only badges: `CriOS`, `FxiOS` and `EdgiOS` are the only
 * markers there and everything else on the platform is Safari's engine wearing
 * whatever name the app chose. An in-app `SFSafariViewController` shares the
 * Safari cookie jar and answers `safari`; Chrome on iOS has its own jar and
 * answers `chrome`, so moving a session between the two is a family change. That
 * is the intended reading — the two do not share cookies, so the move cannot
 * happen without someone copying one.
 */
const FAMILY_MARKERS: readonly { family: UaFamily; marker: RegExp }[] = [
    { family: 'edge', marker: /\bEdg(?:A|iOS)?\// },
    { family: 'chrome', marker: /\b(?:Chrome|CriOS)\// },
    { family: 'firefox', marker: /\b(?:Firefox|FxiOS)\// },
    { family: 'safari', marker: /\bSafari\// },
];

/**
 * Which family a `user-agent` belongs to.
 *
 * Total: an absent, empty or unrecognised string answers `'other'` rather than
 * throwing or answering null. `'other'` is a family like any other — two requests
 * from two different crawlers both read as `'other'` and compare equal — so a
 * caller that needs "no signal" has to check for the header's absence itself
 * rather than read it off this answer. The proxy does exactly that: no inbound
 * `user-agent` means no comparison, because a server component's call to the RPC
 * proxy carries no browser string to compare.
 *
 * @param userAgent - the header as it arrived, or nothing
 * @returns one of `UA_FAMILIES`
 */
export function uaFamily(userAgent: string | null | undefined): UaFamily
{
    if (!userAgent)
    {
        return 'other';
    }

    return FAMILY_MARKERS.find(entry => entry.marker.test(userAgent))?.family ?? 'other';
}
