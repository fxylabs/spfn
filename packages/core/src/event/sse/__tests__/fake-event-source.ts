/**
 * Fake EventSource
 *
 * The browser `EventSource` as the SSE client uses it, driven by the test:
 * `open()` fires `onopen`, `emit()` dispatches an event frame as the server
 * writes it (`{ event, data }`), `control()` a control frame whose data is the
 * payload itself (`subscription.revoked`), `fail()` drops the connection.
 */

interface FakeListener
{
    (e: { data: string }): void;
}

export class FakeEventSource
{
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    static instances: FakeEventSource[] = [];

    readyState = FakeEventSource.CONNECTING;
    onopen: (() => void) | null = null;
    onerror: ((e: Event) => void) | null = null;

    private listeners = new Map<string, FakeListener[]>();

    constructor(public url: string, public init?: { withCredentials?: boolean })
    {
        FakeEventSource.instances.push(this);
    }

    addEventListener(name: string, cb: FakeListener)
    {
        const list = this.listeners.get(name) ?? [];
        list.push(cb);
        this.listeners.set(name, list);
    }

    close()
    {
        this.readyState = FakeEventSource.CLOSED;
    }

    open()
    {
        this.readyState = FakeEventSource.OPEN;
        this.onopen?.();
    }

    /** Dispatch an SSE event as the server would (data = JSON SSEMessage). */
    emit(event: string, payload: unknown)
    {
        this.control(event, { event, data: payload });
    }

    /** Dispatch a frame whose data is `payload` as is; a closed source dispatches nothing, as a browser's. */
    control(event: string, payload: unknown)
    {
        if (this.readyState === FakeEventSource.CLOSED)
        {
            return;
        }

        const wire = { data: JSON.stringify(payload) };
        for (const cb of this.listeners.get(event) ?? [])
        {
            cb(wire);
        }
    }

    /** The connection drops for good; the client's own reconnect takes over. */
    fail()
    {
        this.readyState = FakeEventSource.CLOSED;
        this.onerror?.(new Event('error'));
    }

    static get live(): FakeEventSource[]
    {
        return FakeEventSource.instances.filter((es) => es.readyState !== FakeEventSource.CLOSED);
    }

    static get last(): FakeEventSource
    {
        return FakeEventSource.instances[FakeEventSource.instances.length - 1];
    }

    static install()
    {
        FakeEventSource.instances = [];
        (globalThis as any).EventSource = FakeEventSource;
    }

    static uninstall()
    {
        delete (globalThis as any).EventSource;
    }
}
