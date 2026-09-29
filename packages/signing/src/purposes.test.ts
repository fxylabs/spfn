import { createPublicKey, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseJwks } from './jwks';
import { encodeBase64Url, parseCompact } from './jws';
import { parsePublicKeys } from './keys';
import type { AwsKmsClient } from './providers/aws-kms';
import { generateLocalKeyPair } from './providers/local';
import { definePurposes } from './purposes';
import type { PurposeSpec } from './types';
import { purposeVerifier } from './verify';

const NOW = 1_800_000_000_000;

const SPECS = {
    api: { kidPrefix: 'api', audience: 'https://issuer.example/api', maxTtlSec: 300, typ: 'api+jwt' },
    webhook: {
        kidPrefix: 'whk',
        audience: 'https://issuer.example/webhook',
        maxTtlSec: 60,
        scoped: true,
    },
} satisfies Record<string, PurposeSpec>;

/** A `local` ref: base64url of PKCS#8 DER. */
function localRef(privateKey: KeyObject = generateLocalKeyPair('EdDSA').privateKey): string
{
    return encodeBase64Url(privateKey.export({ format: 'der', type: 'pkcs8' }));
}

function entry(kid: string, ref: string = localRef(), alg = 'EdDSA'): string
{
    return `${kid}:${alg}:local:${ref}`;
}

async function loaded(api = `${entry('api-1')},${entry('api-2')}`, webhook = entry('whk-1'))
{
    return definePurposes(SPECS).load({ api, webhook });
}

describe('definePurposes', () =>
{
    it('U1: refuses a spec that breaks the rules', () =>
    {
        const spec = SPECS.api;

        expect(() => definePurposes({ a: { ...spec, kidPrefix: 'API' } })).toThrow(/kidPrefix/);
        expect(() => definePurposes({ a: { ...spec, kidPrefix: 'a' } })).toThrow(/kidPrefix/);
        expect(() => definePurposes({ a: { ...spec, maxTtlSec: 0 } })).toThrow(/maxTtlSec/);
        expect(() => definePurposes({ a: { ...spec, audience: '' } })).toThrow(/audience/);
        expect(() => definePurposes({ a: { ...spec, maxKeys: 1.5 } })).toThrow(/maxKeys/);
        expect(() => definePurposes({})).toThrow(/no purposes/);
    });

    it('U2: refuses two purposes a token could pass between', () =>
    {
        const { api } = SPECS;

        expect(() => definePurposes({ a: api, b: { ...api, audience: 'https://issuer.example/b' } }))
            .toThrow(/share a kidPrefix or an audience/);
        expect(() => definePurposes({ a: api, b: { ...api, kidPrefix: 'bbb' } })).toThrow(/share/);
        expect(() => definePurposes({
            a: { ...api, scoped: true },
            b: { ...api, kidPrefix: 'bbb', audience: `${api.audience}:admin` },
        })).toThrow(/share/);
    });
});

describe('parseKeyConfig', () =>
{
    const registry = definePurposes(SPECS);

    it('U3: reads kid:alg:provider:ref, keeping the colons of an ARN', () =>
    {
        const arn = 'arn:aws:kms:eu-west-1:123456789012:key/9d8e7c6b';

        expect(registry.parseKeyConfig('api', `api-1:EdDSA:local:AAAA,\n api-2:ES256:aws-kms:${arn}`))
            .toEqual([
                { kid: 'api-1', alg: 'EdDSA', provider: 'local', ref: 'AAAA' },
                { kid: 'api-2', alg: 'ES256', provider: 'aws-kms', ref: arn },
            ]);
    });

    it('U4: refuses a kid without prefix and dash, a third key, a duplicate, an unknown field', () =>
    {
        expect(() => registry.parseKeyConfig('api', 'whk-1:EdDSA:local:AAAA'))
            .toThrow(/do not start with "api-"/);
        expect(() => registry.parseKeyConfig('api', 'apix-1:EdDSA:local:AAAA')).toThrow(/"api-"/);
        expect(() => registry.parseKeyConfig('api', 'api-:EdDSA:local:AAAA')).toThrow(/"api-"/);
        const threeKeys = 'api-1:EdDSA:local:A,api-2:EdDSA:local:B,api-3:EdDSA:local:C';

        expect(() => registry.parseKeyConfig('api', threeKeys))
            .toThrow(/at most 2/);
        expect(() => registry.parseKeyConfig('api', 'api-1:EdDSA:local:A,api-1:EdDSA:local:B'))
            .toThrow(/twice/);
        expect(() => registry.parseKeyConfig('api', 'api-1:RS256:local:A')).toThrow(/alg must be/);
        expect(() => registry.parseKeyConfig('api', 'api-1:EdDSA:vault:A')).toThrow(/provider/);
        expect(() => registry.parseKeyConfig('api', 'api-1:EdDSA:local'))
            .toThrow(/kid:alg:provider:ref/);
        expect(() => registry.parseKeyConfig('api', '')).toThrow(/no key configured/);
        expect(() => registry.parseKeyConfig('nope' as never, 'api-1:EdDSA:local:A'))
            .toThrow(/unknown purpose/);
    });

    it('U5: no message quotes the key material', () =>
    {
        const secret = localRef();
        const attempts = [secret, `${secret}:EdDSA:local:x`, `api-1:EdDSA:vault:${secret}`];

        for (const text of attempts)
        {
            expect(() => registry.parseKeyConfig('api', text)).toThrow();
            expect(() => registry.parseKeyConfig('api', text)).not.toThrow(secret.slice(0, 16));
        }
    });
});

describe('load', () =>
{
    it('U6: signs with aud, iat, exp and typ, and each verifier accepts only its purpose', async () =>
    {
        const purposes = await loaded();
        const token = await purposes.signer('api').sign({ sub: 'user' }, { now: NOW });
        const parsed = parseCompact(token)!;

        expect(parsed.header).toMatchObject({ alg: 'EdDSA', kid: 'api-1', typ: 'api+jwt' });
        expect(parsed.payload)
            .toEqual({ sub: 'user', aud: SPECS.api.audience, iat: NOW / 1000, exp: NOW / 1000 + 300 });
        expect(purposes.verifier('api')(token, NOW))
            .toMatchObject({ ok: true, audience: SPECS.api.audience });
        expect(purposes.verifier('webhook', { scope: 'one' })(token, NOW))
            .toEqual({ ok: false, reason: 'unknown-kid' });
    });

    it('U7: a scoped purpose puts the scope in aud; a verifier for another scope refuses it', async () =>
    {
        const purposes = await loaded();
        const token = await purposes.signer('webhook').sign({}, { scope: 'one', now: NOW });

        expect(parseCompact(token)!.payload.aud).toBe(`${SPECS.webhook.audience}:one`);
        expect(purposes.verifier('webhook', { scope: 'one' })(token, NOW).ok).toBe(true);
        expect(purposes.verifier('webhook', { scope: 'two' })(token, NOW))
            .toEqual({ ok: false, reason: 'wrong-audience' });
        await expect(purposes.signer('webhook').sign({})).rejects.toThrow(/scope/);
        await expect(purposes.signer('api').sign({}, { scope: 'one' })).rejects.toThrow(/not scoped/);
        expect(() => purposes.verifier('webhook')).toThrow(/scope/);
    });

    it('U8: the signer caps the TTL and owns aud, iat and exp', async () =>
    {
        const signer = (await loaded()).signer('api');

        await expect(signer.sign({}, { ttlSec: 301 })).rejects.toThrow(/1 to 300/);
        await expect(signer.sign({}, { ttlSec: 0 })).rejects.toThrow(/1 to 300/);
        await expect(signer.sign({ aud: 'https://issuer.example/webhook' }))
            .rejects.toThrow(/writes aud/);
        await expect(signer.sign({ exp: 1 })).rejects.toThrow(/writes exp/);
        expect(parseCompact(await signer.sign({}, { ttlSec: 10, now: NOW }))!.payload.exp)
            .toBe(NOW / 1000 + 10);
    });

    it('U9: refuses one public key in two purposes, or twice in one', async () =>
    {
        const shared = localRef();

        await expect(loaded(entry('api-1', shared), entry('whk-1', shared)))
            .rejects.toThrow(/same public key/);
        await expect(loaded(`${entry('api-1', shared)},${entry('api-2', shared)}`))
            .rejects.toThrow(/same public key/);
    });

    it('U10: exclude takes a retired kid out of the public set and the verifier', async () =>
    {
        const purposes = await loaded();
        const old = await purposes.signer('api', { kid: 'api-2' }).sign({}, { now: NOW });

        expect([...parsePublicKeys(purposes.publicKeys('api')).keys()]).toEqual(['api-1', 'api-2']);
        expect([...parsePublicKeys(purposes.publicKeys('api', { exclude: ['api-2'] })).keys()])
            .toEqual(['api-1']);
        expect([...parseJwks(purposes.jwks('api', { exclude: ['api-2'] })).keys.keys()])
            .toEqual(['api-1']);
        expect(purposes.verifier('api')(old, NOW).ok).toBe(true);
        expect(purposes.verifier('api', { exclude: ['api-2'] })(old, NOW))
            .toEqual({ ok: false, reason: 'unknown-kid' });
        expect(() => purposes.publicKeys('api', { exclude: ['api-1', 'api-2'] }))
            .toThrow(/every key is excluded/);
        expect(() => purposes.signer('api', { kid: 'api-9' })).toThrow(/no key api-9/);
    });

    it('U11: refuses configuration for an unknown purpose, and a key of another algorithm', async () =>
    {
        const registry = definePurposes(SPECS);

        await expect(registry.load({ api: entry('api-1'), webhook: entry('whk-1'), extra: '' } as never))
            .rejects.toThrow(/unknown purposes: extra/);
        await expect(loaded(entry('api-1', localRef(generateLocalKeyPair('ES256').privateKey))))
            .rejects.toThrow(/ES256 key, not EdDSA/);
    });

    it('U12: builds KMS signers through the injected client', async () =>
    {
        const { privateKey } = generateLocalKeyPair('EdDSA');
        const client: AwsKmsClient = {
            sign: async ({ Message }) => ({ Signature: sign(null, Buffer.from(Message), privateKey) }),
            getPublicKey: async () => ({
                PublicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
                KeySpec: 'ECC_NIST_EDWARDS25519',
            }),
        };
        const purposes = await definePurposes(SPECS).load(
            { api: 'api-1:EdDSA:aws-kms:arn:aws:kms:eu-west-1:1:key/k', webhook: entry('whk-1') },
            { providers: { awsKms: { client } } },
        );
        const token = await purposes.signer('api').sign({}, { now: NOW });

        expect(purposes.verifier('api')(token, NOW).ok).toBe(true);
        await expect(definePurposes(SPECS).load(
            { api: 'api-1:ES256:aws-kms:arn:aws:kms:eu-west-1:1:key/k', webhook: entry('whk-1') },
            { providers: { awsKms: { client } } },
        )).rejects.toThrow();
    });
});

describe('purposeVerifier', () =>
{
    it('U13: refuses keys of another purpose and a scope that does not fit the spec', async () =>
    {
        const purposes = await loaded();
        const webhookKeys = purposes.publicKeys('webhook');

        expect(() => purposeVerifier(SPECS.api, webhookKeys)).toThrow(/do not start with "api-"/);
        expect(() => purposeVerifier(SPECS.api, purposes.publicKeys('api'), { scope: 'x' }))
            .toThrow(/not scoped/);
        expect(() => purposeVerifier(SPECS.webhook, webhookKeys, { scope: 'has space' }))
            .toThrow(/scope/);
        expect(purposeVerifier(SPECS.webhook, webhookKeys, { scope: 'one' })('garbage'))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('U14: pins maxAgeSec to maxTtlSec', async () =>
    {
        const { privateKey } = generateLocalKeyPair('EdDSA');
        const long = await definePurposes({ api: { ...SPECS.api, maxTtlSec: 3600 } })
            .load({ api: entry('api-1', localRef(privateKey)) });
        const token = await long.signer('api').sign({}, { ttlSec: 3600, now: NOW });

        expect(long.verifier('api')(token, NOW).ok).toBe(true);
        expect(purposeVerifier(SPECS.api, long.publicKeys('api'))(token, NOW))
            .toEqual({ ok: false, reason: 'too-old' });
        expect(definePurposes(SPECS).names).toEqual(['api', 'webhook']);
    });
});
