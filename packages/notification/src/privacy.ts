/**
 * @spfn/notification - Privacy helpers
 *
 * A recipient value (email address, phone number) identifies a person, and a
 * rendered body can carry a live credential (magic link, OTP code). These
 * helpers keep both out of places the sending application does not control:
 * logs always get a masked recipient, and history rows can store an HMAC of
 * the recipient and skip the payload columns entirely.
 */

import { createHmac } from 'node:crypto';
import { getHistoryRecipientMode, getHistoryHashSecret } from './config';
import type { SendResult } from './channels/types';

/**
 * Mask an email address for logging: `jo***@example.com`.
 * The domain stays visible — it identifies the provider, not the person,
 * and is what an operator needs to spot a bad domain in a failure log.
 */
export function maskEmail(address: string): string
{
    const at = address.indexOf('@');

    if (at <= 0)
    {
        return maskOpaque(address);
    }

    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);

    return `${visible}***@${domain}`;
}

/**
 * Mask a phone number for logging: `+8210******78`.
 */
export function maskPhone(phone: string): string
{
    // Below 8 characters the 5-char head and 2-char tail would overlap
    // (or leave nothing masked), so fall back to opaque masking.
    if (phone.length < 8)
    {
        return maskOpaque(phone);
    }

    const head = phone.slice(0, 5);
    const tail = phone.slice(-2);

    return `${head}${'*'.repeat(phone.length - 7)}${tail}`;
}

/**
 * Mask a value whose shape is unknown or too short to partially reveal.
 */
function maskOpaque(value: string): string
{
    return value.length === 0 ? '' : `${value.slice(0, 1)}***`;
}

/**
 * Mask a push token for logs and results: enough to tell tokens apart,
 * not enough to send to.
 */
export function maskToken(token: string): string
{
    return token.length <= 12 ? '***' : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/**
 * Mask a recipient of either kind by shape.
 */
export function maskRecipient(value: string): string
{
    return value.includes('@') ? maskEmail(value) : maskPhone(value);
}

/**
 * Mask a recipient list for logging.
 */
export function maskRecipients(values: string[]): string[]
{
    return values.map(maskRecipient);
}

/**
 * HMAC a recipient value. A plain hash of an email address is reversible by
 * dictionary — the input space is small — so a keyed HMAC is required.
 * Input is lowercased so lookups are case-insensitive, matching how email
 * addresses compare.
 */
function hmacRecipient(value: string, secret: string): string
{
    return createHmac('sha256', secret).update(value.trim().toLowerCase()).digest('hex');
}

/**
 * Produce the recipient value a history row stores, honouring the configured
 * mode. Multi-recipient sends store per-recipient HMACs joined with ',' so a
 * single-address lookup keeps working the same way it does for raw values.
 *
 * Throws when hashed mode is configured without a secret — the caller's
 * try/catch around history creation turns that into a logged warning and a
 * skipped row, never a stored raw value or a failed send.
 */
export function historyRecipient(recipients: string[]): string
{
    if (getHistoryRecipientMode() !== 'hashed')
    {
        return recipients.join(',');
    }

    const secret = requireHashSecret();

    return recipients.map(r => hmacRecipient(r, secret)).join(',');
}

/**
 * Transform a recipient filter value the same way stored values were
 * transformed, so exact-match history queries work in either mode.
 */
export function historyRecipientFilter(value: string): string
{
    if (getHistoryRecipientMode() !== 'hashed')
    {
        return value;
    }

    const secret = requireHashSecret();

    return value.split(',').map(r => hmacRecipient(r, secret)).join(',');
}

function requireHashSecret(): string
{
    const secret = getHistoryHashSecret();

    if (!secret)
    {
        throw new Error(
            'history.storeRecipient is "hashed" but no hash secret is configured '
            + '(set history.hashSecret or SPFN_NOTIFICATION_HISTORY_HASH_SECRET)',
        );
    }

    return secret;
}

/**
 * An email address anywhere in free text. The TLD is letters only, so a
 * sentence-ending period after the address (`...check: learner@example.com.`)
 * stays outside the match instead of being eaten as part of the domain.
 */
const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * A phone number anywhere in free text, deliberately conservative: an E.164
 * number, or a bare run of 10-15 digits that no letter or digit touches and
 * that is not one side of a decimal. The guards are what keep the diagnostic
 * parts of a provider message intact — `us-east-1` and the fields of an ISO
 * timestamp are short runs, a hex message id has letters in it, and a Slack
 * `ts` like `1725439200.123456` is excluded by the decimal lookahead.
 */
const PHONE_TOKEN = /\+[1-9]\d{6,14}|(?<![0-9A-Za-z])(?<!\d\.)\d{10,15}(?![0-9A-Za-z])(?!\.\d)/g;

/**
 * What this scrub itself writes: a filename label, a masked address, a masked
 * phone number. The text is scrubbed again with the same attachments — the
 * SES provider scrubs its result, the channel scrubs what it receives — and
 * a filename must not be matched inside these then.
 */
const SCRUBBED_TOKEN = /\[attachment \d+\]|[A-Za-z0-9._%+-]{1,2}\*\*\*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:\+\d{4}|\d{5})\*+\d{2}/g;

/**
 * A letter, mark or digit: what a filename match may not cut through. A
 * percent escape just before a match (`uploads%2Fa.pdf`) is an encoded
 * separator, not part of a word, though its hex digits are letters or digits.
 */
const WORD_EDGE_START = /^[\p{L}\p{M}\p{N}]/u;
const WORD_EDGE_END = /[\p{L}\p{M}\p{N}]$/u;
const NOT_WORD_BEFORE = '(?:(?<![\\p{L}\\p{M}\\p{N}])|(?<=%[0-9A-Fa-f]{2}))';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{M}\\p{N}])';

/**
 * A half of a surrogate pair standing alone: text with one has no
 * percent-encoded form.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * A stretch of the original text and what is written in its place
 */
interface Replacement
{
    start: number;
    end: number;
    by: string;
}

/**
 * Mask the recipient values a provider embedded in its own error text.
 *
 * Provider failures are free text and routinely quote the address that caused
 * them ("The following identities failed the check in region US-EAST-1:
 * learner@example.com"). That text is logged and persisted to
 * `history.error_message`, so without this it re-introduces the raw recipient
 * that masked logging and hashed history were configured to keep out.
 *
 * The same goes for the send's own attachment filenames (a rejected file type
 * is reported by name): each is replaced by `[attachment N]`, as written and
 * percent-encoded (`encodeURIComponent`, or with `+` for a space). Any other
 * rendering a provider might invent — re-cased, trimmed, MIME-encoded — is not
 * recognised. A filename is matched as a whole token only, never inside a
 * longer run of letters or digits; a percent escape just before it counts as
 * a separator.
 *
 * Every candidate is found in the original text first — each address, each
 * phone number not inside an address, and each spelling of each filename
 * scanned on its own, overlapping occurrences included — and only then
 * chosen: address and phone masks always stand, and so does text that looks
 * like this scrub's own output where it overlaps no mask. Among the filename
 * candidates, those that partly overlap a standing span are dropped; of the
 * rest, the longest is taken first, then the next longest that overlaps none
 * taken so far, and so on. A filename taken over a whole standing span
 * removes it with the rest of the name. The choice is replaced in one pass.
 * So a dropped candidate never hides a shorter one inside it, a filename
 * holding a whole address is removed whole, and where a filename only
 * overlaps an address or a phone number the recipient mask wins and the rest
 * of that filename stays. A filename is not matched inside what an earlier
 * scrub wrote, so scrubbing scrubbed text again changes nothing.
 *
 * Only these tokens are touched; the rest of the message — the error
 * name, the region, the request id — is the diagnostic value and survives.
 * Never throws: a scrubbed message is written on the failure path, where a
 * second failure would cost the operator the original error. A `null`
 * attachment list from a plain-JS caller means none.
 */
export function scrubProviderError(text: string, attachments: readonly { filename: string }[] | null = []): string
{
    if (typeof text !== 'string' || text.length === 0)
    {
        return '';
    }

    const standing = standingSpans(text);
    const filenames = chosenFilenames(filenameCandidates(text, attachments ?? []), standing);

    return applied(text, [
        ...standing.filter(span => !filenames.some(name => contains(name, span))),
        ...filenames,
    ]);
}

/**
 * The masks of every address in `text` and of every phone number not inside
 * one of those addresses, and the earlier scrub's output that overlaps none
 * of those masks, left as it is
 */
function standingSpans(text: string): Replacement[]
{
    const addresses = replacementsOf(text, EMAIL_TOKEN, maskEmail);
    const masks = [
        ...addresses,
        ...replacementsOf(text, PHONE_TOKEN, maskPhone).filter(phone => !overlapsAny(phone, addresses)),
    ];

    return [
        ...masks,
        ...replacementsOf(text, SCRUBBED_TOKEN, token => token).filter(token => !overlapsAny(token, masks)),
    ];
}

/**
 * Every whole-token occurrence of every spelling of every filename in
 * `text`, labelled `[attachment N]`
 */
function filenameCandidates(text: string, attachments: readonly { filename: string }[]): Replacement[]
{
    return attachments.flatMap(({ filename }, index) => [...new Set(spellings(filename))]
        .filter(spelling => spelling.length > 0)
        .flatMap(spelling => occurrencesOf(text, spelling, `[attachment ${index + 1}]`)));
}

/**
 * The candidates that partly overlap no standing span, longest first, each
 * taken only if it overlaps none taken before it
 */
function chosenFilenames(candidates: Replacement[], standing: Replacement[]): Replacement[]
{
    return candidates
        .filter(name => standing.every(span => !overlaps(name, span) || contains(name, span)))
        .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
        .reduce<Replacement[]>((taken, name) => (overlapsAny(name, taken) ? taken : [...taken, name]), []);
}

/**
 * A filename as written and percent-encoded, with `%20` and with `+` for a
 * space. A name holding a lone surrogate has no encoded form.
 */
function spellings(filename: string): string[]
{
    if (LONE_SURROGATE.test(filename))
    {
        return [filename];
    }

    const encoded = encodeURIComponent(filename);

    return [filename, encoded, encoded.replaceAll('%20', '+')];
}

/**
 * A pattern for `spelling` that does not match inside a longer run of letters
 * or digits: an edge that is itself a letter or digit may not touch another.
 */
function asWholeToken(spelling: string): string
{
    const literal = spelling.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

    return (WORD_EDGE_START.test(spelling) ? NOT_WORD_BEFORE : '')
        + literal
        + (WORD_EDGE_END.test(spelling) ? NOT_WORD_AFTER : '');
}

/**
 * Every occurrence of `spelling` in `text`, overlapping ones included, so an
 * occurrence that is later dropped cannot hide the next one
 */
function occurrencesOf(text: string, spelling: string, by: string): Replacement[]
{
    const pattern = new RegExp(asWholeToken(spelling), 'gu');
    const found: Replacement[] = [];

    for (let match = pattern.exec(text); match; match = pattern.exec(text))
    {
        found.push({ start: match.index, end: match.index + match[0].length, by });
        // One code point on, not one unit: resumed inside a surrogate pair, a
        // `u` pattern restarts at the pair's first half and finds this match again.
        pattern.lastIndex = match.index + String.fromCodePoint(text.codePointAt(match.index)!).length;
    }

    return found;
}

function replacementsOf(text: string, pattern: RegExp, replace: (match: string) => string): Replacement[]
{
    return Array.from(text.matchAll(pattern), match => ({
        start: match.index!,
        end: match.index! + match[0].length,
        by: replace(match[0]),
    }));
}

function overlaps(a: Replacement, b: Replacement): boolean
{
    return a.start < b.end && b.start < a.end;
}

function overlapsAny(span: Replacement, others: Replacement[]): boolean
{
    return others.some(other => overlaps(span, other));
}

function contains(outer: Replacement, inner: Replacement): boolean
{
    return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * `text` with each of the non-overlapping `replacements` written in
 */
function applied(text: string, replacements: Replacement[]): string
{
    const { scrubbed, end } = [...replacements]
        .sort((a, b) => a.start - b.start)
        .reduce(
            (done, { start, end, by }) => ({ scrubbed: done.scrubbed + text.slice(done.end, start) + by, end }),
            { scrubbed: '', end: 0 },
        );

    return scrubbed + text.slice(end);
}

/**
 * Scrub the error a provider returned, at the boundary where the channel
 * receives it — so a custom adopter provider is covered by the same guarantee
 * as the built-in ones, before the channel logs it or writes it to history.
 * `attachments` are the send's own, whose filenames are removed as well.
 */
export function scrubSendResult(result: SendResult, attachments: readonly { filename: string }[] | null = []): SendResult
{
    if (!result.error)
    {
        return result;
    }

    return { ...result, error: scrubProviderError(result.error, attachments) };
}
