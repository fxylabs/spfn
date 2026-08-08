/**
 * @spfn/auth/crypto — the client half of SPFN's signed-request scheme
 *
 * SPFN authenticates a request with a JWT the client signs itself: it holds a
 * key pair, registers the public half at login, and signs each request with
 * the private half. These are the two functions a client needs to take part —
 * nothing here touches the database, so a non-server client (the `spfn` CLI,
 * a script) can import them without pulling in the auth server.
 *
 * The server side of the same scheme lives behind `@spfn/auth/server`.
 */

export {
    generateKeyPair,
    generateKeyPairES256,
    generateKeyPairRS256,
    generateClientToken,
    getKeySize,
    shouldRotateKey,
    type KeyPair,
} from './server/lib/crypto';

export type { KeyAlgorithmType } from './server/types';
