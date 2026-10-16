/**
 * Bounded SSE outbound writer
 *
 * Serializes writes to one SSE stream through a single drain loop that `await`s
 * each `writeSSE` — so a slow client applies real backpressure instead of letting
 * frames pile up unbounded in memory (OOM under a fast producer + slow consumer).
 *
 * The queue is per-connection, so a slow stream never blocks other connections.
 * When the queue exceeds `maxQueue`, the connection is closed (via `onClose`)
 * rather than silently dropping frames — dropping a chunk would corrupt an
 * ordered token/chat stream; the client reconnects and re-fetches instead.
 */

/** A frame to write to the SSE stream (subset of Hono's SSEMessage). */
export interface SSEFrame
{
    data: string;
    event?: string;
    id?: string;
}

/** Minimal stream surface this writer needs (Hono's SSEStreamingApi satisfies it). */
export interface SSEWritable
{
    writeSSE(message: SSEFrame): Promise<void>;
}

export interface BoundedWriter
{
    /** Queue a frame for delivery; closes the connection if the queue overflows. */
    enqueue(frame: SSEFrame): void;

    /**
     * Count one frame held outside the queue against `maxQueue`, until
     * `clearReserved()`; closes the connection as a slow consumer when it does
     * not fit. `false` when it did not fit or the writer is closed.
     */
    reserve(): boolean;

    /** Stop counting the reserved frames — their writer is about to enqueue them. */
    clearReserved(): void;

    /** Stop draining and drop any queued frames (called on connection cleanup). */
    close(): void;

    /** Current queue depth (for tests/diagnostics). */
    readonly queued: number;
}

/**
 * Create a bounded, backpressure-aware writer for one SSE stream.
 *
 * @param stream   the SSE stream (`writeSSE` returns a promise that resolves when
 *                 the socket has drained — that is what gives us backpressure)
 * @param maxQueue max frames buffered before the connection is closed
 * @param onClose  called once when the writer closes the connection (overflow or
 *                 a write error); the caller cleans up and logs
 */
export function createBoundedWriter(
    stream: SSEWritable,
    maxQueue: number,
    onClose: (reason: string) => void,
): BoundedWriter
{
    const pending: SSEFrame[] = [];
    let flushing = false;
    let reserved = 0;
    let closed = false;

    // Slow consumer: the drain loop can't keep up, so the queue — with the frames
    // reserved for it — grew past the bound. Close rather than buffer unboundedly
    // or drop silently.
    const overflows = (): boolean =>
    {
        if (pending.length + reserved <= maxQueue)
        {
            return false;
        }

        onClose('outbound queue overflow (slow consumer)');

        return true;
    };

    const flush = async (): Promise<void> =>
    {
        if (flushing || closed)
        {
            return;
        }

        flushing = true;

        while (pending.length > 0 && !closed)
        {
            const frame = pending.shift() as SSEFrame;
            try
            {
                await stream.writeSSE(frame);
            }
            catch (err)
            {
                flushing = false;
                onClose(err instanceof Error ? err.message : String(err));

                return;
            }
        }

        flushing = false;
    };

    return {
        enqueue(frame: SSEFrame): void
        {
            if (closed)
            {
                return;
            }

            pending.push(frame);

            if (!overflows())
            {
                void flush();
            }
        },

        reserve(): boolean
        {
            if (closed)
            {
                return false;
            }

            reserved++;

            return !overflows();
        },

        clearReserved(): void
        {
            reserved = 0;
        },

        close(): void
        {
            closed = true;
            pending.length = 0;
        },

        get queued(): number
        {
            return pending.length;
        },
    };
}
