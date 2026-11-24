/**
 * Everything a clientProofV1 server remembers between requests: issued
 * sessions, the replay ledger, revoked keys and the key directory.
 *
 * The admission order is the contract's, not this file's invention
 * (`clientProofV1.revocationRule` + the replay fixtures):
 *
 * 1. revoked keyId / invalid session → SESSION_REVOKED — before proof
 *    verification, so revocation stays distinguishable from a bad proof;
 * 2. issuedAtMillis outside the replay window (0 <= age <= window) → PROOF_EXPIRED;
 * 3. a repeated (clientId, nonce) pair inside the window → PROOF_REPLAYED;
 * 4. only then signature verification → PROOF_INVALID when it does not verify.
 *
 * A nonce is recorded as spent only on admission: a request refused for any
 * earlier reason has not spent anything, so a client that fixes the reason and
 * retries with the same nonce is not punished twice for one mistake. This is
 * why core's `NonceStore.checkAndSet` (which records on check) is not reused
 * here — its semantics would spend a nonce on a refused request.
 *
 * `admit` is synchronous, so on Node's single thread the whole sequence is
 * atomic: two requests presenting the same nonce cannot interleave inside it.
 *
 * @module server/client-proof/state
 */
import type { KeyObject } from 'node:crypto';

import {
    DEFAULT_REPLAY_WINDOW_MILLIS,
    parseClientProofPublicKey,
    verifyClientProof,
    type ClientProofInput,
} from './proof';
import { ClientProofRefusal, newHexId } from './refusal';
import { MemoryReplayLedger } from './replay-store';
import { optionKeys, readEntries, readOptions } from '../lib/stated-options';

/** Millisecond clock. Injectable so expiry paths are testable without waiting. */
export interface ClientProofClock
{
    nowMillis(): number;
}

export function systemClock(): ClientProofClock
{
    return { nowMillis: () => Date.now() };
}

/** A clock a test (or the dev control surface) can move forward. */
export class TestClock implements ClientProofClock
{
    constructor(private millis: number) 
    {}

    nowMillis(): number
    {
        return this.millis;
    }

    advance(byMillis: number): void
    {
        this.millis += byMillis;
    }
}

/** What `stats()` reports. Counters only; nothing a request carried. */
export interface ClientProofStats
{
    requestCount: number;
    handshakeCount: number;
    echoCount: number;
    itemsListCount: number;
    refusalCount: number;
    liveSessionCount: number;
    spentNonceCount: number;
}

interface ClientProofSession
{
    clientId: string;
    keyId: string;
    expiresAtMillis: number;
}

interface PathHold
{
    millis: number;
    remaining: number;
}

export interface ClientProofStateOptions
{
    /**
     * keyId → registered public key, as SPKI DER base64. The private half
     * never reaches the server: a client generates its keypair (hardware-held
     * on mobile) and only the public key is registered — at construction here,
     * or later through `registerPublicKey` (the dev `/control/register-key`
     * route).
     */
    publicKeys: Record<string, string>;

    clock?: ClientProofClock;

    /** @default 600000 */
    sessionTtlMillis?: number;

    /** The contract's replay window. @default 300000 */
    replayWindowMillis?: number;
}

export const DEFAULT_SESSION_TTL_MILLIS = 600_000;

/** Every option `ClientProofState` reads; `createClientProofDevHandler` hands it these of its own. */
export const CLIENT_PROOF_STATE_OPTIONS = optionKeys<ClientProofStateOptions>({
    publicKeys: true,
    clock: true,
    sessionTtlMillis: true,
    replayWindowMillis: true,
});

export class ClientProofState
{
    readonly replayWindowMillis: number;

    private readonly clock: ClientProofClock;
    private readonly initialPublicKeys: ReadonlyMap<string, KeyObject>;
    private readonly publicKeys = new Map<string, KeyObject>();
    private readonly sessions = new Map<string, ClientProofSession>();

    /** The replay ledger — the shared memory implementation, used dev-only here. */
    private readonly spentNonces = new MemoryReplayLedger();

    private readonly revokedKeyIds = new Set<string>();
    private readonly holds = new Map<string, PathHold>();

    private readonly initialSessionTtlMillis: number;
    private sessionTtlMillis: number;

    private requestCount = 0;
    private handshakeCount = 0;
    private echoCount = 0;
    private itemsListCount = 0;
    private refusalCount = 0;

    /**
     * @throws Error when `options` or `publicKeys` is not a plain object,
     *   `options` carries a name that is not an option — a misspelt
     *   `replayWindowMilis` would otherwise run on the default window — or a
     *   key is not P-256 SPKI. Each is read once, by `readOptions` and
     *   `readEntries` (#477)
     */
    constructor(options: ClientProofStateOptions)
    {
        const read = readOptions<ClientProofStateOptions>('ClientProofState', options, CLIENT_PROOF_STATE_OPTIONS);

        this.clock = read.clock ?? systemClock();
        this.initialSessionTtlMillis = read.sessionTtlMillis ?? DEFAULT_SESSION_TTL_MILLIS;
        this.sessionTtlMillis = this.initialSessionTtlMillis;
        this.replayWindowMillis = read.replayWindowMillis ?? DEFAULT_REPLAY_WINDOW_MILLIS;
        // Parsed once here, so a key that is not P-256 SPKI fails loudly at
        // construction rather than as a PROOF_INVALID mystery at request time.
        this.initialPublicKeys = new Map(
            Object.entries(readEntries<string>('ClientProofState.publicKeys', read.publicKeys, 'naming each key id'))
                .map(([keyId, spki]) => [keyId, parseClientProofPublicKey(spki)]),
        );
        for (const [keyId, key] of this.initialPublicKeys)
        {
            this.publicKeys.set(keyId, key);
        }
    }

    // ---- key registration --------------------------------------------------

    /**
     * Registers (or replaces) the public key `keyId` presents proofs under.
     *
     * @throws when the key is not base64 SPKI DER naming a P-256 key.
     */
    registerPublicKey(keyId: string, publicKeySpkiDerBase64: string): void
    {
        this.publicKeys.set(keyId, parseClientProofPublicKey(publicKeySpkiDerBase64));
    }

    // ---- admission ---------------------------------------------------------

    /**
     * Runs the contract's checks in the contract's order and returns the
     * refusal, or null when the request is admitted (spending its nonce).
     */
    admit(args: {
        clientId: string;
        keyId: string;
        presentedSessionId: string | null;
        requiresSession: boolean;
        proofInput: ClientProofInput;
        presentedProof: string;
    }): ClientProofRefusal | null
    {
        const now = this.clock.nowMillis();
        this.prune(now);

        // 1. Revocation, before anything the proof could explain. A revoked key
        //    and a dropped session are the same answer on purpose: both are
        //    cleared by opening a new session.
        if (this.revokedKeyIds.has(args.keyId))
        {
            return ClientProofRefusal.sessionRevoked();
        }
        if (args.requiresSession)
        {
            const session = args.presentedSessionId === null ? undefined : this.sessions.get(args.presentedSessionId);
            if (session === undefined || session.expiresAtMillis <= now
                || session.keyId !== args.keyId || session.clientId !== args.clientId)
            {
                return ClientProofRefusal.sessionRevoked();
            }
        }

        // 2. The replay window, judged against this server's clock.
        const age = now - Number(args.proofInput.issuedAtMillis);
        if (age < 0 || age > this.replayWindowMillis)
        {
            return ClientProofRefusal.proofExpired();
        }

        // 3. One acceptance per (clientId, nonce) inside that window.
        if (this.spentNonces.isSpent(args.clientId, args.proofInput.nonce))
        {
            return ClientProofRefusal.proofReplayed();
        }

        // 4. The proof itself, last, so the three answers above stay
        //    distinguishable. An unregistered keyId lands here rather than in
        //    step 1, and shares PROOF_INVALID with a failed signature: it was
        //    never registered, so it was never revoked, there is nothing for a
        //    new session to fix, and whether a keyId exists is not inferable
        //    from the refusal — the same non-disclosure the revocation rule
        //    keeps.
        const publicKey = this.publicKeys.get(args.keyId);
        if (publicKey === undefined)
        {
            return ClientProofRefusal.proofInvalid();
        }
        if (!verifyClientProof(args.proofInput, args.presentedProof, publicKey))
        {
            return ClientProofRefusal.proofInvalid();
        }

        this.spentNonces.spend(args.clientId, args.proofInput.nonce, Number(args.proofInput.issuedAtMillis));

        return null;
    }

    // ---- sessions ----------------------------------------------------------

    /** Opens a session and returns its id and the expiry the server advertises. */
    openSession(clientId: string, keyId: string): { sessionId: string; expiresAtMillis: number }
    {
        const now = this.clock.nowMillis();
        this.prune(now);
        const sessionId = newHexId();
        const expiresAtMillis = now + this.sessionTtlMillis;
        this.sessions.set(sessionId, { clientId, keyId, expiresAtMillis });

        return { sessionId, expiresAtMillis };
    }

    /** Test hook: installs a session with a chosen id (wire-fixture replays). */
    seedSession(sessionId: string, clientId: string, keyId: string, expiresAtMillis: number): void
    {
        this.sessions.set(sessionId, { clientId, keyId, expiresAtMillis });
    }

    /** Drops every session, as a restart would. Advertised expiries stay told. */
    expireSessions(): void
    {
        this.sessions.clear();
    }

    /** Revokes a key and drops the sessions it opened. */
    revokeKey(keyId: string): void
    {
        this.revokedKeyIds.add(keyId);
        for (const [sessionId, session] of this.sessions)
        {
            if (session.keyId === keyId)
            {
                this.sessions.delete(sessionId);
            }
        }
    }

    setSessionTtlMillis(millis: number): void
    {
        this.sessionTtlMillis = millis;
    }

    /** Returns the state to how it started, counters and registered keys included. */
    reset(): void
    {
        this.publicKeys.clear();
        for (const [keyId, key] of this.initialPublicKeys)
        {
            this.publicKeys.set(keyId, key);
        }
        this.sessions.clear();
        this.spentNonces.clear();
        this.revokedKeyIds.clear();
        this.holds.clear();
        this.sessionTtlMillis = this.initialSessionTtlMillis;
        this.requestCount = 0;
        this.handshakeCount = 0;
        this.echoCount = 0;
        this.itemsListCount = 0;
        this.refusalCount = 0;
    }

    // ---- delays (dev/test only) --------------------------------------------

    /** Makes the next `count` requests to `path` wait `millis` before processing. */
    holdPath(path: string, millis: number, count: number): void
    {
        this.holds.set(path, { millis, remaining: count });
    }

    /** Consumes one configured delay for `path`; returns how long to wait, or 0. */
    takeHoldMillis(path: string): number
    {
        const hold = this.holds.get(path);
        if (hold === undefined)
        {
            return 0;
        }
        hold.remaining -= 1;
        if (hold.remaining <= 0)
        {
            this.holds.delete(path);
        }

        return hold.millis;
    }

    // ---- counters ----------------------------------------------------------

    recordRequest(): void
    {
        this.requestCount += 1;
    }

    recordOperation(operationId: string): void
    {
        if (operationId === 'auth.clientProof.handshake')
        {
            this.handshakeCount += 1;
        }
        else if (operationId === 'echo.send')
        {
            this.echoCount += 1;
        }
        else if (operationId === 'items.list')
        {
            this.itemsListCount += 1;
        }
    }

    recordRefusal(): void
    {
        this.refusalCount += 1;
    }

    stats(): ClientProofStats
    {
        this.prune(this.clock.nowMillis());

        return {
            requestCount: this.requestCount,
            handshakeCount: this.handshakeCount,
            echoCount: this.echoCount,
            itemsListCount: this.itemsListCount,
            refusalCount: this.refusalCount,
            liveSessionCount: this.sessions.size,
            spentNonceCount: this.spentNonces.size,
        };
    }

    nowMillis(): number
    {
        return this.clock.nowMillis();
    }

    /** The clock, exposed for the dev control surface's advance-clock route. */
    get clockRef(): ClientProofClock
    {
        return this.clock;
    }

    // ---- housekeeping ------------------------------------------------------

    /**
     * Drops what can no longer affect an answer. The nonce predicate is the
     * exact negation of the window check in `admit`: an entry is dropped only
     * once a proof carrying that issuedAtMillis would be refused as expired
     * anyway. Dropping one moment earlier would let a nonce inside the window
     * be spent twice.
     */
    private prune(nowMillis: number): void
    {
        for (const [sessionId, session] of this.sessions)
        {
            if (session.expiresAtMillis <= nowMillis)
            {
                this.sessions.delete(sessionId);
            }
        }
        this.spentNonces.prune(nowMillis, this.replayWindowMillis);
    }
}
