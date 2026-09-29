import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    BASE64URL_ALPHABET,
    buildVectorFile,
    respellSignature,
    serializeVectorFile,
    VECTORS_FILE,
    vectorKeys,
    verifyOptions,
    writeVectorFile,
    type VectorFile,
} from '../../../contracts/signing/record-vectors';
import { parseJwks } from './jwks';
import { verifyJws } from './verify';
import type { VerifyFailureReason } from './types';

/**
 * `contracts/signing/vectors.json` is the fixed point other implementations
 * check themselves against: forty tokens, the public keys that verify them,
 * the verdict each one must produce — and a block of JWK Sets with what
 * `parseJwks()` makes of each.
 *
 * The file is written by `contracts/signing/record-vectors.ts`, which asks
 * this package's own verifier what each token means and refuses to write
 * anything if a case does not exercise the rule it names. These tests are the
 * two halves of trusting that file: it still says what the verifier says, and
 * it is still exactly what the generator produces.
 *
 * Regenerate with `UPDATE_SIGNING_VECTORS=1 pnpm --filter @spfn/signing test
 * vectors`, and read the diff — a change here is a change to what every holder
 * of these vectors expects.
 *
 * Three of the verifier's behaviours cannot be a vector, because a vector is a
 * token judged at a fixed instant:
 *
 * - `now` defaulting to the system clock. Every vector passes `now: verifyAt`,
 *   because a file whose verdicts depend on the day it is replayed is not a
 *   fixed point. `jws.test.ts` covers the default.
 * - a token that is not a string. `verifyJws(42, keys)` is `malformed`, and a
 *   JSON `token` member cannot be 42 and still be a token.
 * - key configuration that throws — a malformed `publicKeys` string is the
 *   deployment's bug and not a verdict about a token, so there is nothing to
 *   record.
 *
 * They stay verifier tests. Forcing them into the contract file would only
 * teach a downstream port to expect something the file cannot express.
 */
const committedText = (): string => readFileSync(VECTORS_FILE, 'utf8');

const committedFile = (): VectorFile => JSON.parse(committedText()) as VectorFile;

/**
 * Every reason the verifier can give. One vector each, at least, is the point.
 *
 * Written as a record keyed by the union rather than as a list of strings: a
 * list is a hand-maintained copy that a tenth reason would not disturb, while
 * a `Record<VerifyFailureReason, true>` stops compiling the moment the union
 * grows. So the new reason fails `pnpm type-check` until it is named here, and
 * then fails the test below until it has a vector.
 */
const EVERY_REASON_WITNESS: Record<VerifyFailureReason, true> = {
    'malformed': true,
    'invalid-claims': true,
    'unknown-kid': true,
    'alg-mismatch': true,
    'bad-signature': true,
    'expired': true,
    'not-yet-valid': true,
    'too-old': true,
    'no-expiry': true,
    'wrong-audience': true,
    'no-audience': true,
    'wrong-issuer': true,
    'no-issuer': true,
};

const EVERY_REASON = Object.keys(EVERY_REASON_WITNESS) as VerifyFailureReason[];

/**
 * The six vectors this contract started with, pinned.
 *
 * Downstream repositories hold a byte copy of them as a fixture, refreshed by
 * copying the file again and reading the diff. Their tokens are therefore
 * frozen — an ES256 signature that silently re-randomised, or an Ed25519
 * payload that gained a space, is a diff nobody can review. Written out here
 * rather than read from the file so that the file cannot be its own witness.
 */
const FROZEN_KEYS = 'vector-ed25519:Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc,'
    + 'vector-es256:'
    + 'BFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q';

const FROZEN_TOKENS: Record<string, string> = {
    'ed25519-valid':
        'eyJhbGciOiJFZERTQSIsImtpZCI6InZlY3Rvci1lZDI1NTE5In0.eyJpc3MiOiJzcGZuLXNpZ25pbmctdmVjdG9ycyIsInN1YiI6InZlY3RvciIsImlhdCI6MTc5OTk5OTAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.e9BpxRC_8jlkdCUD-0iUa74iQv3XK7K3MzUwmTiysy-T7eFjtPv4L4WzDAAZ18PV3O89looYZZ3ji6E5dSC5CA',
    'ed25519-expired':
        'eyJhbGciOiJFZERTQSIsImtpZCI6InZlY3Rvci1lZDI1NTE5In0.eyJpc3MiOiJzcGZuLXNpZ25pbmctdmVjdG9ycyIsInN1YiI6InZlY3RvciIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMzAwfQ.4p56dXNiTMwFni0rIhoal9RVE1fUIuLEK2MNsFrtClpUDyBZT0E0eeiRpzQ8nPXBSLCXclKhkJe_bbd38RPbDg',
    'ed25519-bad-signature':
        'eyJhbGciOiJFZERTQSIsImtpZCI6InZlY3Rvci1lZDI1NTE5In0.eyJpc3MiOiJzcGZuLXNpZ25pbmctdmVjdG9ycyIsInN1YiI6InZlY3RvciIsImlhdCI6MTc5OTk5OTAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.etBpxRC_8jlkdCUD-0iUa74iQv3XK7K3MzUwmTiysy-T7eFjtPv4L4WzDAAZ18PV3O89looYZZ3ji6E5dSC5CA',
    'es256-valid':
        'eyJhbGciOiJFUzI1NiIsImtpZCI6InZlY3Rvci1lczI1NiJ9.eyJpc3MiOiJzcGZuLXNpZ25pbmctdmVjdG9ycyIsInN1YiI6InZlY3RvciIsImlhdCI6MTc5OTk5OTAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.M4VE2yRNI-hsdwXgPkd2ZjF998yGBqLz7jk7wuu0mHDdw0dPR_tZABKyv3-TrD6tdpT0Fpm85BY39FBVfYbRdg',
    'es256-expired':
        'eyJhbGciOiJFUzI1NiIsImtpZCI6InZlY3Rvci1lczI1NiJ9.eyJpc3MiOiJzcGZuLXNpZ25pbmctdmVjdG9ycyIsInN1YiI6InZlY3RvciIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMzAwfQ.eL9bvPC61f1TI5wyMiqgT0jnM1GL5nE_kCZPSBi_5QnsAMrjpPOwsZItZWF8DYPbiXn6GdRnH3nFdy4QeBmkxA',
    'es256-bad-signature':
        'eyJhbGciOiJFUzI1NiIsImtpZCI6InZlY3Rvci1lczI1NiJ9.eyJpc3MiOiJzcGZuLXNpZ25pbmctdmVjdG9ycyIsInN1YiI6InZlY3RvciIsImlhdCI6MTc5OTk5OTAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.MoVE2yRNI-hsdwXgPkd2ZjF998yGBqLz7jk7wuu0mHDdw0dPR_tZABKyv3-TrD6tdpT0Fpm85BY39FBVfYbRdg',
};

describe('signing vectors', () =>
{
    // Rewriting before the first assertion rather than inside one: every test
    // below reads the committed file, and a regeneration halfway through the
    // suite would leave half of them judging the file they replaced.
    beforeAll(async () =>
    {
        if (process.env.UPDATE_SIGNING_VECTORS)
        {
            await writeVectorFile();
        }
    });

    it('X2: every committed vector still produces its recorded verdict', () =>
    {
        const file = committedFile();

        expect(file.vectors.length).toBeGreaterThanOrEqual(40);

        for (const vector of file.vectors)
        {
            const result = verifyJws(
                vector.token,
                vectorKeys(file, vector),
                verifyOptions(file.verifyAt, vector.options),
            );

            expect(result, `${vector.name}: ${vector.why ?? 'a frozen vector'}`)
                .toMatchObject(vector.expect);
        }
    });

    it('X2: a vector without an audience option has no audience in its verdict', () =>
    {
        const file = committedFile();

        for (const vector of file.vectors.filter((item) => item.options?.audience === undefined))
        {
            const options = verifyOptions(file.verifyAt, vector.options);

            expect(verifyJws(vector.token, vectorKeys(file, vector), options))
                .not.toHaveProperty('audience');
        }
    });

    it('X2: every committed JWK Set still parses to its recorded keys, or is still refused', () =>
    {
        const file = committedFile();

        expect(file.jwks.length).toBeGreaterThanOrEqual(10);

        for (const item of file.jwks)
        {
            if ('throws' in item.expect)
            {
                expect(() => parseJwks(item.set), `${item.name}: ${item.why}`).toThrow();
                continue;
            }

            const parsed = parseJwks(item.set);

            expect([...parsed.keys.keys()], item.name).toEqual(item.expect.kids);
            expect(parsed.skipped, item.name).toEqual(item.expect.skipped);
        }
    });

    it('X2: every failure reason the verifier can give has a vector', () =>
    {
        const recorded = new Set(
            committedFile().vectors.flatMap(
                (vector) => (vector.expect.ok ? [] : [vector.expect.reason]),
            ),
        );

        expect(EVERY_REASON.filter((reason) => !recorded.has(reason))).toEqual([]);
    });

    it('X2: regenerating reproduces the committed file exactly', async () =>
    {
        const fresh = await buildVectorFile();

        expect(fresh).toEqual(committedFile());
        expect(serializeVectorFile(fresh)).toBe(committedText());
    });

    /**
     * The generator's own helper, not the verifier's behaviour — but it decides
     * what vector 7 IS, and it used to walk off the end of the alphabet: the
     * character after `_` does not exist, so a signature ending there produced
     * the string "undefined" instead of a respelling.
     */
    it('X2: every signature has a respelling that decodes to the same bytes', () =>
    {
        const signatureOf = (token: string): Buffer => Buffer.from(token.split('.')[2], 'base64url');

        expect(respellSignature(`h.b.${'A'.repeat(85)}_`).slice(-1)).toBe('-');

        for (const last of BASE64URL_ALPHABET)
        {
            const token = `h.b.${'A'.repeat(85)}${last}`;
            const respelt = respellSignature(token);

            expect(respelt.slice(-1), `${last} respells to a character of the alphabet`)
                .toMatch(/^[A-Za-z0-9\-_]$/);
            expect(respelt.slice(-1), `${last} respells to something else`).not.toBe(last);
            expect(signatureOf(respelt), `${last} respells to the same 64 bytes`)
                .toEqual(signatureOf(token));
        }
    });

    it('X2: the six original vectors are byte-for-byte what a downstream copied', async () =>
    {
        const fresh = await buildVectorFile();
        const tokens = Object.fromEntries(
            fresh.vectors
                .filter((vector) => vector.name in FROZEN_TOKENS)
                .map((vector) => [vector.name, vector.token]),
        );

        expect(tokens).toEqual(FROZEN_TOKENS);
        expect(fresh.publicKeys).toBe(FROZEN_KEYS);
    });
});
