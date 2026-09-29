/**
 * The `local` provider: the private key is in this process.
 *
 * Key material arrives as a `KeyObject`, from an environment variable, or
 * from a file. That is the whole list — sops, Secret Manager, Vault and the
 * rest are *delivery*: they put a value in an env var or a file before the
 * process starts. Nothing here decrypts anything at runtime.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { CompactSigner } from '../jws';
import { algorithmOf, assertKid } from '../keys';
import type { ProviderName, PublicKeyEntry, SigningAlgorithm } from '../types';

/** Where the private key comes from. */
export type LocalKeyMaterial =
    | KeyObject
    | { env: string }
    | { file: string };

export interface LocalSignerOptions
{
    kid: string;
    /**
     * The algorithm this key implements. Default: `EdDSA`.
     *
     * Worth stating rather than deriving: a bare 32-byte key is an Ed25519
     * seed and a P-256 scalar at the same time, and only you know which. It is
     * checked against the key once the key is loaded, so a wrong answer is an
     * error at construction and never a silently different key.
     */
    alg?: SigningAlgorithm;
    privateKey: LocalKeyMaterial;
}

/** What a key is when nobody says. Ed25519: smaller, faster, no nonce to get wrong. */
const DEFAULT_ALGORITHM: SigningAlgorithm = 'EdDSA';

const RAW_KEY_BYTES = 32;
const PEM_PREFIX = '-----BEGIN';

/** PKCS#8 for an Ed25519 private key: everything but the 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * SEC1 `ECPrivateKey` for P-256 carrying only the private scalar.
 *
 * The public point is omitted, which is legal, and OpenSSL derives it — that
 * is how a raw 32-byte scalar becomes a usable key without us doing curve
 * arithmetic by hand.
 */
const P256_SEC1_PREFIX = Buffer.from('3031020101' + '0420', 'hex');
const P256_SEC1_SUFFIX = Buffer.from('a00a06082a8648ce3d030107', 'hex');

/** Unpadded base64url, or standard base64 — both alphabets, nothing else. */
const BASE64_TEXT = /^(?:[A-Za-z0-9_-]+|[A-Za-z0-9+/]+={0,2})$/;

function privateKeyFromRaw(bytes: Buffer, alg: SigningAlgorithm): KeyObject
{
    if (alg === 'EdDSA')
    {
        return createPrivateKey({
            key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes]),
            format: 'der',
            type: 'pkcs8',
        });
    }

    return createPrivateKey({
        key: Buffer.concat([P256_SEC1_PREFIX, bytes, P256_SEC1_SUFFIX]),
        format: 'der',
        type: 'sec1',
    });
}

/** PKCS#8 PEM or DER, or a raw 32-byte `alg` key. Errors name `source`, never the bytes. */
export function privateKeyFromBytes(bytes: Buffer, alg: SigningAlgorithm, source: string): KeyObject
{
    if (bytes.subarray(0, PEM_PREFIX.length).toString('ascii') === PEM_PREFIX)
    {
        return createPrivateKey({ key: bytes.toString('utf8'), format: 'pem' });
    }

    if (bytes.length === RAW_KEY_BYTES)
    {
        return privateKeyFromRaw(bytes, alg);
    }

    if (bytes[0] === 0x30)
    {
        return createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
    }

    throw new Error(
        `LocalSigner: the key material in ${source} is not PKCS#8 PEM, PKCS#8 DER `
        + `or a raw ${RAW_KEY_BYTES}-byte key`,
    );
}

function privateKeyFromText(text: string, alg: SigningAlgorithm, source: string): KeyObject
{
    const trimmed = text.trim();

    if (trimmed.startsWith(PEM_PREFIX))
    {
        return createPrivateKey({ key: trimmed, format: 'pem' });
    }

    if (!BASE64_TEXT.test(trimmed))
    {
        throw new Error(
            `LocalSigner: the key material in ${source} is neither a PEM block nor base64url`,
        );
    }

    return privateKeyFromBytes(Buffer.from(trimmed, 'base64'), alg, source);
}

function readEnv(name: string, alg: SigningAlgorithm): KeyObject
{
    const value = process.env[name];

    if (!value)
    {
        throw new Error(`LocalSigner: environment variable ${name} is not set`);
    }

    return privateKeyFromText(value, alg, `environment variable ${name}`);
}

function readFile(path: string, alg: SigningAlgorithm): KeyObject
{
    let bytes: Buffer;

    try
    {
        bytes = readFileSync(path);
    }
    catch
    {
        throw new Error(`LocalSigner: cannot read the key file ${path}`);
    }

    return privateKeyFromBytes(bytes, alg, `file ${path}`);
}

/**
 * Load the key.
 *
 * Every failure names the environment variable or the path and stops there.
 * A message that quotes the value it could not parse is a message that puts
 * a private key in a log.
 */
function loadPrivateKey(material: LocalKeyMaterial, alg: SigningAlgorithm): KeyObject
{
    if ('env' in material)
    {
        return readEnv(material.env, alg);
    }

    if ('file' in material)
    {
        return readFile(material.file, alg);
    }

    if (material.type !== 'private')
    {
        throw new Error(`LocalSigner: expected a private KeyObject, got a ${material.type} key`);
    }

    return material;
}

/** Signs with a private key held in this process. */
export class LocalSigner extends CompactSigner
{
    readonly kid: string;

    readonly alg: SigningAlgorithm;

    readonly provider: ProviderName = 'local';

    readonly #privateKey: KeyObject;

    #publicKey: PublicKeyEntry | null = null;

    constructor(options: LocalSignerOptions)
    {
        super();

        this.kid = assertKid(options.kid);
        this.alg = options.alg ?? DEFAULT_ALGORITHM;
        this.#privateKey = loadPrivateKey(options.privateKey, this.alg);

        const actual = algorithmOf(this.#privateKey);

        if (actual !== this.alg)
        {
            throw new Error(`LocalSigner: key ${this.kid} is an ${actual} key, not ${this.alg}`);
        }
    }

    async signRaw(input: Buffer): Promise<Buffer>
    {
        if (this.alg === 'EdDSA')
        {
            return sign(null, input, this.#privateKey);
        }

        // `ieee-p1363` is JOSE's `r || s`. The default is DER, which JOSE forbids.
        return sign('sha256', input, { key: this.#privateKey, dsaEncoding: 'ieee-p1363' });
    }

    async publicKey(): Promise<PublicKeyEntry>
    {
        this.#publicKey ??= {
            kid: this.kid,
            alg: this.alg,
            public: createPublicKey(this.#privateKey),
            provider: this.provider,
        };

        return this.#publicKey;
    }

    /** What a signer says about itself — never the key. */
    toJSON(): { provider: ProviderName; kid: string; alg: SigningAlgorithm }
    {
        return { provider: this.provider, kid: this.kid, alg: this.alg };
    }

    toString(): string
    {
        return `LocalSigner(${this.kid}, ${this.alg})`;
    }

    [inspect.custom](): string
    {
        return this.toString();
    }
}

/** A fresh key pair, for bootstrapping a ring or for tests. Ed25519 by default. */
export function generateLocalKeyPair(
    alg: SigningAlgorithm = DEFAULT_ALGORITHM,
): { privateKey: KeyObject; publicKey: KeyObject }
{
    return alg === 'EdDSA'
        ? generateKeyPairSync('ed25519')
        : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}
