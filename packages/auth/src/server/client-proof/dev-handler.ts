/**
 * The mobile-contract dev surface: a fetch-style handler exposing the three
 * dev operations (handshake / echo.send / items.list) plus the `/control`
 * test hooks the spfn-mobile integration suites drive.
 *
 * Framework-free on purpose — `fetch(request) => Response` plugs into
 * `@hono/node-server`'s `serve({ fetch })` or any Web-standard runtime, and
 * the contract needs byte-exact control over bodies and envelopes that a
 * validating router would take away.
 *
 * This is a dev/test surface, not a production deployment target: keys are
 * injected at construction, state is in-memory, and `/control` mutates it.
 *
 * @module server/client-proof/dev-handler
 */
import { encodeCanonicalJson, type CanonicalValue } from './canonical-json';
import { admitClientProofRequest, type Admission } from './admission';
import {
    CONTRACT_OPERATIONS,
    ContractTypeError,
    decodeEchoRequest,
    decodeHandshakeRequest,
    decodeListItemsRequest,
    encodeEchoResponse,
    encodeHandshakeResponse,
    encodeListItemsResponse,
    type ContractItem,
    type ContractOperation,
    type ListItemsRequest,
} from './contract-types';
import { ClientProofRefusal, newHexId } from './refusal';
import { CLIENT_PROOF_STATE_OPTIONS, ClientProofState, type ClientProofStateOptions, TestClock } from './state';
import { handleControlRequest, CONTROL_PREFIX } from './dev-control';
import { serverContractHeaders } from './wire-version';
import { optionKeys, readOptions } from '@spfn/core/options';

/** Far above any contract request and far below anything worth buffering. */
const MAX_BODY_BYTES = 1 << 20;

const HTTP_OK = 200;

/**
 * The items `items.list` pages through — fixed and small on purpose, matching
 * the spfn-mobile reference catalogue byte for byte so an integration test can
 * assert exact values against either server.
 */
export const DEV_CATALOGUE: readonly ContractItem[] = [
    { id: 'item-0001', name: 'alpha', updatedAtMillis: 1_750_000_000_001n },
    { id: 'item-0002', name: 'bravo', updatedAtMillis: 1_750_000_000_002n },
    { id: 'item-0003', name: 'charlie', updatedAtMillis: 1_750_000_000_003n },
    { id: 'item-0004', name: 'delta', updatedAtMillis: 1_750_000_000_004n },
    { id: 'item-0005', name: 'echo', updatedAtMillis: 1_750_000_000_005n },
];

/** The largest `items.list` page this server will answer with. */
export const DEV_MAX_LIMIT = 100n;

export interface ClientProofDevHandlerOptions extends ClientProofStateOptions
{
    /**
     * Token the `/control` routes require (header `x-spfn-reference-control`).
     * Generated per construction when omitted; never logged.
     */
    controlToken?: string;

    /** Disables the `/control` surface entirely. @default true */
    enableControl?: boolean;

    /** One line per request: method, path, status. Nothing a request carried. */
    log?: (line: string) => void;
}

export interface ClientProofDevHandler
{
    fetch(request: Request): Promise<Response>;
    state: ClientProofState;
    controlToken: string;
}

const DEV_HANDLER_OPTIONS = optionKeys<ClientProofDevHandlerOptions>({
    publicKeys: true,
    clock: true,
    sessionTtlMillis: true,
    replayWindowMillis: true,
    controlToken: true,
    enableControl: true,
    log: true,
});

/**
 * @throws Error when `options` is not a plain object or carries a name that
 *   is not an option. It is read once, by `readOptions`, and the state is
 *   built from that snapshot, never from `options` (#477)
 */
export function createClientProofDevHandler(options: ClientProofDevHandlerOptions): ClientProofDevHandler
{
    const read = readOptions<ClientProofDevHandlerOptions>('createClientProofDevHandler', options, DEV_HANDLER_OPTIONS);
    const state = new ClientProofState(stateOptionsOf(read));
    const controlToken = read.controlToken ?? newHexId();
    const enableControl = read.enableControl ?? true;
    const log = read.log ?? (() => undefined);

    async function dispatch(request: Request): Promise<Response>
    {
        state.recordRequest();
        const url = new URL(request.url);

        if (enableControl && url.pathname.startsWith(CONTROL_PREFIX))
        {
            return handleControlRequest(state, controlToken, url.pathname, request);
        }

        // A query string is refused by omission: no contract path carries one,
        // and a proof is taken over the path alone.
        const operation = url.search === ''
            ? CONTRACT_OPERATIONS.find((op) => op.path === url.pathname && op.method === request.method)
            : undefined;
        if (operation === undefined)
        {
            return refuse(ClientProofRefusal.unroutable());
        }

        const body = await readBodyCapped(request);
        if (body === null)
        {
            return refuse(ClientProofRefusal.bodyTooLarge());
        }

        // Before verification, so a request a test is holding open has not
        // spent its nonce by the time the client gives up waiting for it.
        await waitOutHold(url.pathname);

        const admission = admitClientProofRequest({
            state,
            headers: request.headers,
            method: operation.method,
            path: operation.path,
            requiresSession: operation.requiresSession,
            body,
        });
        if (!admission.admitted)
        {
            return refuse(admission.refusal);
        }

        return apply(operation, admission);
    }

    function apply(operation: ContractOperation, admission: Extract<Admission, { admitted: true }>): Response
    {
        let value: CanonicalValue;
        try
        {
            if (operation.id === 'auth.clientProof.handshake')
            {
                const request = decodeHandshakeRequest(admission.value);
                // The proof already binds the header identity to the key that
                // signed it, so a body naming a different client is a request
                // whose two halves disagree about who sent it.
                if (request.clientId !== admission.credentials.clientId
                    || request.keyId !== admission.credentials.keyId)
                {
                    return refuse(ClientProofRefusal.bodyNotTheDeclaredType());
                }
                const opened = state.openSession(request.clientId, request.keyId);
                value = encodeHandshakeResponse(opened.sessionId, BigInt(opened.expiresAtMillis));
            }
            else if (operation.id === 'echo.send')
            {
                const request = decodeEchoRequest(admission.value);
                value = encodeEchoResponse(request.message, request.sequence, BigInt(state.nowMillis()));
            }
            else
            {
                const listed = listItems(decodeListItemsRequest(admission.value));
                if (listed === null)
                {
                    return refuse(ClientProofRefusal.bodyNotTheDeclaredType());
                }
                value = listed;
            }
        }
        catch (error)
        {
            if (error instanceof ContractTypeError)
            {
                return refuse(ClientProofRefusal.bodyNotTheDeclaredType());
            }

            return refuse(ClientProofRefusal.unprocessable());
        }

        state.recordOperation(operation.id);

        return contractResponse(HTTP_OK, encodeCanonicalJson(value));
    }

    function refuse(refusal: ClientProofRefusal): Response
    {
        state.recordRefusal();

        return contractResponse(refusal.httpStatus, refusal.envelopeBytes(newHexId()));
    }

    async function waitOutHold(path: string): Promise<void>
    {
        const millis = state.takeHoldMillis(path);
        if (millis > 0)
        {
            await new Promise((resolve) => setTimeout(resolve, millis));
        }
    }

    return {
        state,
        controlToken,
        fetch: async (request: Request): Promise<Response> =>
        {
            try
            {
                const response = await dispatch(request);
                log(`${request.method} ${new URL(request.url).pathname} -> ${response.status}`);

                return response;
            }
            catch
            {
                // A contract answer rather than a stack trace: an exception
                // message can quote the request that produced it.
                return refuse(ClientProofRefusal.unprocessable());
            }
        },
    };
}

/**
 * The options of `read` that `ClientProofState` reads, as they were stated —
 * `publicKeys` too when it was left out, for the state's own refusal.
 */
function stateOptionsOf(read: Partial<ClientProofDevHandlerOptions>): ClientProofStateOptions
{
    const stated: Partial<ClientProofStateOptions> = Object.fromEntries(CLIENT_PROOF_STATE_OPTIONS
        .filter(key => Object.hasOwn(read, key))
        .map(key => [key, read[key]]));

    return stated as ClientProofStateOptions;
}

/**
 * One page of the catalogue, or null when the request is not one this
 * contract describes. An unknown cursor and a limit outside 1…MAX are refused
 * rather than clamped — a server that quietly repaired a request would hide
 * the client bug that produced it.
 */
function listItems(request: ListItemsRequest): CanonicalValue | null
{
    if (request.limit < 1n || request.limit > DEV_MAX_LIMIT)
    {
        return null;
    }
    let start = 0;
    if (request.cursor !== undefined)
    {
        const index = DEV_CATALOGUE.findIndex((item) => item.id === request.cursor);
        if (index < 0)
        {
            return null;
        }
        start = index + 1;
    }
    const end = Math.min(DEV_CATALOGUE.length, start + Number(request.limit));
    const page = DEV_CATALOGUE.slice(start, end);
    // Present only when a further page exists, so "nextCursor is absent" is a
    // fact about the data rather than a value the client has to interpret.
    const nextCursor = end < DEV_CATALOGUE.length && page.length > 0 ? page[page.length - 1].id : null;

    return encodeListItemsResponse([...page], nextCursor);
}

function contractResponse(status: number, body: Uint8Array): Response
{
    return new Response(toArrayBuffer(body), {
        status,
        headers: { 'content-type': 'application/json', ...serverContractHeaders() },
    });
}

/** The body, or null when it is larger than this server will read. */
async function readBodyCapped(request: Request): Promise<Uint8Array | null>
{
    if (request.body === null)
    {
        return new Uint8Array(0);
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        total += value.length;
        if (total > MAX_BODY_BYTES)
        {
            await reader.cancel();

            return null;
        }
        chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks)
    {
        body.set(chunk, offset);
        offset += chunk.length;
    }

    return body;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer
{
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export { TestClock };
