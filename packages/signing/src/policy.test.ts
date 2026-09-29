import { beforeAll, describe, expect, it } from 'vitest';
import { encodeBase64Url } from './jws';
import type { LocalSigner } from './providers/local';
import { testKey } from './test-support';
import type { PublicKeyEntry, VerifyOptions } from './types';
import { verifyJws } from './verify';

const NOW = 1_800_000_000_000;

const NOW_SEC = NOW / 1000;

const API = 'https://issuer.example/api';

const REGISTER = 'https://issuer.example/register/';

const NONCE = '0123456789abcdef0123456789abcdef';

const HEX = { prefix: REGISTER, rest: /^[0-9a-f]{32}$/ };

let signer: LocalSigner;
let keys: PublicKeyEntry[];

beforeAll(async () =>
{
    const key = await testKey('policy', 'EdDSA');

    signer = key.signer;
    keys = [key.entry];
});

/** A token issued ten seconds ago for five minutes, with `claims` on top. */
function issue(claims: Record<string, unknown> = {}): Promise<string>
{
    return signer.sign({
        iss: 'https://issuer.example',
        sub: 'user',
        iat: NOW_SEC - 10,
        exp: NOW_SEC + 300,
        ...claims,
    });
}

async function verdict(claims: Record<string, unknown>, options: VerifyOptions): Promise<unknown>
{
    return verifyJws(await issue(claims), keys, { now: NOW, ...options });
}

describe('options absent', () =>
{
    it('P1: aud and iss are not read, and the verdict has exactly the members it always had', async () =>
    {
        const token = await issue({ aud: 5, iss: { not: 'a string' } });
        const result = verifyJws(token, keys, { now: NOW });

        expect(result.ok).toBe(true);
        expect(Object.keys(result)).toEqual(['ok', 'header', 'payload']);
    });
});

describe('audience', () =>
{
    it('P2: a string or an array aud, against a string or a list', async () =>
    {
        expect(await verdict({ aud: API }, { audience: API }))
            .toMatchObject({ ok: true, audience: API });
        expect(await verdict({ aud: ['https://issuer.example/other', API] }, { audience: API }))
            .toMatchObject({ ok: true, audience: API });
        expect(await verdict({ aud: API }, { audience: ['https://issuer.example/other', API] }))
            .toMatchObject({ ok: true, audience: API });
        expect(await verdict({ aud: `${API}/` }, { audience: API }))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('P3: an empty array names nobody; a non-string member breaks the claim', async () =>
    {
        expect(await verdict({ aud: [] }, { audience: API }))
            .toEqual({ ok: false, reason: 'no-audience' });
        expect(await verdict({ aud: [API, 7] }, { audience: API }))
            .toEqual({ ok: false, reason: 'invalid-claims' });
        expect(await verdict({ aud: null }, { audience: API }))
            .toEqual({ ok: false, reason: 'invalid-claims' });
        expect(await verdict({ aud: { API } }, { audience: API }))
            .toEqual({ ok: false, reason: 'invalid-claims' });
    });

    it('P4: runs after every older check, so it never changes an older verdict', async () =>
    {
        const expired = await issue({ aud: 'elsewhere', iat: NOW_SEC - 1000, exp: NOW_SEC - 500 });
        const [head, body, signature] = (await issue({ aud: 'elsewhere' })).split('.');
        const flipped = Buffer.from(signature, 'base64url');

        flipped[0] ^= 0x01;

        const forged = `${head}.${body}.${encodeBase64Url(flipped)}`;

        expect(verifyJws(expired, keys, { now: NOW, audience: API }))
            .toEqual({ ok: false, reason: 'expired' });
        expect(verifyJws(forged, keys, { now: NOW, audience: API }))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('P5: a prefix audience matches at the boundary the remainder pattern draws', async () =>
    {
        const short = { prefix: 'https://issuer.example/a', rest: /^[0-9a-f]{32}$/ };

        expect(await verdict({ aud: `${REGISTER}${NONCE}` }, { audience: HEX }))
            .toMatchObject({ ok: true, audience: `${REGISTER}${NONCE}` });
        expect(await verdict({ aud: `https://issuer.example/ab${NONCE}` }, { audience: short }))
            .toEqual({ ok: false, reason: 'wrong-audience' });
        expect(await verdict({ aud: `${REGISTER}${NONCE}\n` }, { audience: HEX }))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('P6: a top-level alternation cannot slip out of the anchors', async () =>
    {
        const alternation = { prefix: REGISTER, rest: /^[0-9a-f]{32}|x$/ };

        expect(await verdict({ aud: `${REGISTER}../report/x` }, { audience: alternation }))
            .toEqual({ ok: false, reason: 'wrong-audience' });
        expect(await verdict({ aud: `${REGISTER}${NONCE}/x` }, { audience: alternation }))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('P7: an unanchored rest, or one with a flag but u or v, is a config error, thrown before the token is read', () =>
    {
        const unanchored = [/[0-9a-f]{32}/, /^[0-9a-f]{32}/, /[0-9a-f]{32}$/, /^[0-9a-f]{32}\$/];
        const flagged = [/^a$/g, /^a$/m, /^a$/y, /^a$/s, /^a$/i, /^a$/d, /^a$/gu];

        for (const rest of [...unanchored, ...flagged])
        {
            expect(
                () => verifyJws('not a token', keys, { audience: { prefix: REGISTER, rest } }),
                String(rest),
            ).toThrow(/anchored/);
        }

        for (const rest of [/^a$/u, new RegExp('^a$', 'v')])
        {
            expect(verifyJws('x', keys, { audience: { prefix: REGISTER, rest } }), String(rest))
                .toEqual({ ok: false, reason: 'malformed' });
        }

        expect(() => verifyJws('x', keys, { audience: { prefix: '', rest: /^a$/ } })).toThrow(/prefix/);
        expect(() => verifyJws('x', keys, { audience: [] })).toThrow(/non-empty/);
        expect(() => verifyJws('x', keys, { audience: '' })).toThrow(/non-empty/);
        expect(() => verifyJws('x', keys, { audience: null as never })).toThrow(/prefix/);
    });

    it('P8: an escaped backslash before the final $ still anchors', async () =>
    {
        const rest = /^[0-9a-f]+\\$/;

        expect(await verdict({ aud: `${REGISTER}ab\\` }, { audience: { prefix: REGISTER, rest } }))
            .toMatchObject({ ok: true });
    });
});

describe('issuer', () =>
{
    it('P9: one issuer or a list; missing, wrong and non-string iss are three verdicts', async () =>
    {
        const example = 'https://issuer.example';

        expect(await verdict({}, { issuer: example })).toMatchObject({ ok: true });
        expect(await verdict({}, { issuer: ['https://other.example', example] }))
            .toMatchObject({ ok: true });
        expect(await verdict({ iss: 'https://other.example' }, { issuer: example }))
            .toEqual({ ok: false, reason: 'wrong-issuer' });
        expect(await verdict({ iss: undefined }, { issuer: example }))
            .toEqual({ ok: false, reason: 'no-issuer' });
        expect(await verdict({ iss: 1 }, { issuer: example }))
            .toEqual({ ok: false, reason: 'invalid-claims' });
        expect(() => verifyJws('x', keys, { issuer: [] })).toThrow(/issuer must be/);
    });
});

describe('issuedWithinSec', () =>
{
    it('P10: bounds the issue date, with the skew, whatever the expiry says', async () =>
    {
        expect(await verdict({ iat: NOW_SEC - 300 }, { issuedWithinSec: 270 }))
            .toMatchObject({ ok: true });
        expect(await verdict({ iat: NOW_SEC - 301 }, { issuedWithinSec: 270 }))
            .toEqual({ ok: false, reason: 'too-old' });
        expect(await verdict({ iat: undefined }, { issuedWithinSec: 300 }))
            .toEqual({ ok: false, reason: 'no-expiry' });
    });

    it('P11: a future iat inside the skew is accepted; beyond it is not-yet-valid', async () =>
    {
        expect(await verdict({ iat: NOW_SEC + 30 }, { issuedWithinSec: 60 }))
            .toMatchObject({ ok: true });
        expect(await verdict({ iat: NOW_SEC + 31 }, { issuedWithinSec: 60 }))
            .toEqual({ ok: false, reason: 'not-yet-valid' });
        expect(() => verifyJws('x', keys, { issuedWithinSec: -1 })).toThrow(/issuedWithinSec/);
        expect(() => verifyJws('x', keys, { issuedWithinSec: Number.NaN })).toThrow(/issuedWithinSec/);
    });
});

describe('order', () =>
{
    it('P12: issuedWithinSec, then issuer, then audience', async () =>
    {
        const all = { issuedWithinSec: 1, issuer: 'https://other.example', audience: API };

        expect(await verdict({ iat: NOW_SEC - 100, aud: 'x' }, all))
            .toEqual({ ok: false, reason: 'too-old' });
        expect(await verdict({ aud: 'x' }, { ...all, issuedWithinSec: 60 }))
            .toEqual({ ok: false, reason: 'wrong-issuer' });
        expect(await verdict({ aud: 'x' }, { issuedWithinSec: 60, audience: API }))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('P13: a malformed token is still malformed under every option', () =>
    {
        const header = encodeBase64Url('{"alg":"EdDSA","kid":"policy"}');

        expect(verifyJws(`${header}.e30`, keys, { audience: API, issuer: 'x', issuedWithinSec: 1 }))
            .toEqual({ ok: false, reason: 'malformed' });
    });
});
