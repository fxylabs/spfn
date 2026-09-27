/**
 * `Accept-Language` parsing and locale matching, with no framework in sight so
 * the negotiation policy can be tested as plain data.
 *
 * The header is client input: it is read up to a fixed size and a fixed number
 * of entries, and anything that does not parse is skipped rather than thrown.
 */

const MAX_HEADER_LENGTH = 4096;
const MAX_ENTRIES = 32;
const LANGUAGE_TAG = /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i;

interface WeightedTag
{
    tag: string;
    q: number;
}

function parseQuality(params: string[]): number | null
{
    const quality = params.find(param => param.trim().toLowerCase().startsWith('q='));

    if (quality === undefined)
    {
        return 1;
    }

    const value = quality.trim().slice(2);
    const q = value === '' ? NaN : Number(value);

    return Number.isFinite(q) && q >= 0 && q <= 1 ? q : null;
}

function parseEntry(entry: string): WeightedTag | null
{
    const [rawTag = '', ...params] = entry.split(';');
    const tag = rawTag.trim();
    const q = parseQuality(params);

    if (q === null || q === 0 || !LANGUAGE_TAG.test(tag))
    {
        return null;
    }

    return { tag, q };
}

/**
 * The header's language tags, most preferred first. Entries of equal weight
 * keep the order the client sent them in; `q=0`, `*` and malformed entries are
 * dropped.
 */
export function parseAcceptLanguage(header: string): string[]
{
    return header
        .slice(0, MAX_HEADER_LENGTH)
        .split(',')
        .slice(0, MAX_ENTRIES)
        .map(parseEntry)
        .filter((entry): entry is WeightedTag => entry !== null)
        .map((entry, index) => ({ ...entry, index }))
        .sort((a, b) => b.q - a.q || a.index - b.index)
        .map(entry => entry.tag);
}

/**
 * Matches one requested tag against the supported locales, case-insensitively,
 * dropping trailing subtags until something matches: `zh-Hant-TW` tries
 * `zh-Hant`, then `zh`. The result is spelled as the app declared it.
 */
export function matchLocale<Locale extends string>(
    requested: string,
    locales: readonly Locale[],
): Locale | null
{
    const subtags = requested.toLowerCase().split('-');

    for (let length = subtags.length; length > 0; length--)
    {
        const candidate = subtags.slice(0, length).join('-');
        const match = locales.find(locale => locale.toLowerCase() === candidate);

        if (match !== undefined)
        {
            return match;
        }
    }

    return null;
}
