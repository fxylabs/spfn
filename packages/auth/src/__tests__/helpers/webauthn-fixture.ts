/**
 * A minimal authenticator, in software.
 *
 * Produces the two things a real one produces — an attestation object (`fmt`
 * `none`) and an assertion — over a real P-256 key. The happy-path rows of the
 * passkey case table therefore run the library's actual CBOR, COSE and ECDSA
 * verification instead of a stub that would agree with whatever we wrote.
 *
 * The refusal rows that cannot be produced this way (a signature the key did not
 * make) stub `server/lib/webauthn` instead; everything reachable by changing an
 * input — wrong origin, wrong rpId, a regressed counter — is produced here.
 */

import crypto from 'crypto';

const AAGUID = new Uint8Array(16);

/** CBOR: a definite-length header for `major` carrying `value`. */
function cborHead(major: number, value: number): Uint8Array
{
    if (value < 24)
    {
        return Uint8Array.from([(major << 5) | value]);
    }

    if (value < 256)
    {
        return Uint8Array.from([(major << 5) | 24, value]);
    }

    return Uint8Array.from([(major << 5) | 25, value >> 8, value & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array
{
    return new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
}

/** CBOR byte string. */
function cborBytes(value: Uint8Array): Uint8Array
{
    return concat(cborHead(2, value.length), value);
}

/** CBOR text string. */
function cborText(value: string): Uint8Array
{
    const bytes = new Uint8Array(Buffer.from(value, 'utf8'));

    return concat(cborHead(3, bytes.length), bytes);
}

/** CBOR small integer, negative ones included (`-1` is major 1, value 0). */
function cborInt(value: number): Uint8Array
{
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
}

/** COSE_Key for an EC2 P-256 public key: kty, alg, crv, x, y. */
function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array
{
    return concat(
        cborHead(5, 5),
        cborInt(1), cborInt(2),
        cborInt(3), cborInt(-7),
        cborInt(-1), cborInt(1),
        cborInt(-2), cborBytes(x),
        cborInt(-3), cborBytes(y),
    );
}

function sha256(value: Uint8Array): Uint8Array
{
    return new Uint8Array(crypto.createHash('sha256').update(value).digest());
}

function base64url(value: Uint8Array): string
{
    return Buffer.from(value).toString('base64url');
}

function counterBytes(counter: number): Uint8Array
{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, counter, false);

    return bytes;
}

/** `authenticatorData`, with attested credential data when a credential is given. */
function authenticatorData(
    rpId: string,
    flags: number,
    counter: number,
    attested?: { credentialId: Uint8Array; cose: Uint8Array },
): Uint8Array
{
    const head = concat(
        sha256(new Uint8Array(Buffer.from(rpId, 'utf8'))),
        Uint8Array.from([flags]),
        counterBytes(counter),
    );

    if (!attested)
    {
        return head;
    }

    return concat(
        head,
        AAGUID,
        Uint8Array.from([attested.credentialId.length >> 8, attested.credentialId.length & 0xff]),
        attested.credentialId,
        attested.cose,
    );
}

function clientData(type: string, challenge: string, origin: string): Uint8Array
{
    return new Uint8Array(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8'));
}

export interface CeremonyInput
{
    challenge: string;
    origin: string;
    rpId: string;
}

/** User present + user verified + attested credential data. */
const REGISTRATION_FLAGS = 0x45;

/** User present + user verified. */
const ASSERTION_FLAGS = 0x05;

/**
 * One software authenticator holding one discoverable credential.
 *
 * `create()` mints the key; `attest()` and `assert()` answer a ceremony the way
 * `@simplewebauthn/browser` would hand it to the server.
 */
export class FixtureAuthenticator
{
    private constructor(
        private readonly privateKey: crypto.KeyObject,
        private readonly cose: Uint8Array,
        readonly credentialIdBytes: Uint8Array,
    ) 
    {}

    static async create(): Promise<FixtureAuthenticator>
    {
        const pair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify'],
        );
        const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

        return new FixtureAuthenticator(
            // The two JsonWebKey declarations (webcrypto's and node:crypto's)
            // differ only in optionality; the value is the same key material.
            crypto.createPrivateKey({
                key: await crypto.subtle.exportKey('jwk', pair.privateKey) as crypto.JsonWebKey,
                format: 'jwk',
            }),
            coseKey(
                new Uint8Array(Buffer.from(jwk.x!, 'base64url')),
                new Uint8Array(Buffer.from(jwk.y!, 'base64url')),
            ),
            new Uint8Array(crypto.randomBytes(32)),
        );
    }

    get credentialId(): string
    {
        return base64url(this.credentialIdBytes);
    }

    /** The registration response for a `create()` ceremony. */
    attest(input: CeremonyInput): Record<string, unknown>
    {
        const authData = authenticatorData(input.rpId, REGISTRATION_FLAGS, 0, {
            credentialId: this.credentialIdBytes,
            cose: this.cose,
        });
        const attestationObject = concat(
            cborHead(5, 3),
            cborText('fmt'), cborText('none'),
            cborText('attStmt'), cborHead(5, 0),
            cborText('authData'), cborBytes(authData),
        );

        return {
            id: this.credentialId,
            rawId: this.credentialId,
            type: 'public-key',
            clientExtensionResults: {},
            response: {
                attestationObject: base64url(attestationObject),
                clientDataJSON: base64url(clientData('webauthn.create', input.challenge, input.origin)),
                transports: ['internal', 'hybrid'],
            },
        };
    }

    /** The authentication response for a `get()` ceremony at the given counter. */
    assert(input: CeremonyInput & { counter: number; tamper?: boolean }): Record<string, unknown>
    {
        const authData = authenticatorData(input.rpId, ASSERTION_FLAGS, input.counter);
        const clientDataJSON = clientData('webauthn.get', input.challenge, input.origin);
        const signature = new Uint8Array(crypto.sign(
            'sha256',
            concat(authData, sha256(clientDataJSON)),
            this.privateKey,
        ));

        if (input.tamper)
        {
            signature[signature.length - 1] ^= 0xff;
        }

        return {
            id: this.credentialId,
            rawId: this.credentialId,
            type: 'public-key',
            clientExtensionResults: {},
            response: {
                authenticatorData: base64url(authData),
                clientDataJSON: base64url(clientDataJSON),
                signature: base64url(signature),
            },
        };
    }
}
