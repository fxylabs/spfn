/**
 * A fake Redis pub/sub bus for transport tests: several `FakeRedis` clients
 * (one per simulated pod) share one `FakeBus`, and `createRedisPubSubCache`
 * runs on top of them unchanged. Delivery is synchronous within `publish`,
 * unless `deliverLater()` switched the bus to queueing — then nothing arrives
 * until `flush()`, the way a real Redis delivers a pod's own echo after the
 * calls that follow its publish.
 */

// ── Fake Redis bus (shared backend for several client connections) ──

export class FakeBus
{
    private channels = new Map<string, Set<(channel: string, message: string) => void>>();
    private queue: (() => void)[] | undefined;

    publish(channel: string, message: string): number
    {
        const subs = this.channels.get(channel);
        if (!subs)
        {
            return 0;
        }

        const deliver = () => subs.forEach(cb => cb(channel, message));
        if (this.queue)
        {
            this.queue.push(deliver);
        }
        else
        {
            deliver();
        }

        return subs.size;
    }

    /** Queue every later publish until `flush()`. */
    deliverLater(): void
    {
        this.queue ??= [];
    }

    /** Deliver the queued publishes in publish order (the bus stays in queueing mode). */
    flush(): void
    {
        this.queue?.splice(0).forEach(deliver => deliver());
    }

    subscribe(channel: string, cb: (channel: string, message: string) => void): void
    {
        let set = this.channels.get(channel);
        if (!set)
        {
            set = new Set();
            this.channels.set(channel, set);
        }

        set.add(cb);
    }
}

export class FakeRedis
{
    private listeners: ((channel: string, message: string) => void)[] = [];

    constructor(private bus: FakeBus)
    {}

    async publish(channel: string, message: string): Promise<number>
    {
        return this.bus.publish(channel, message);
    }

    duplicate(): FakeRedis
    {
        return new FakeRedis(this.bus);
    }

    async subscribe(channel: string): Promise<void>
    {
        this.bus.subscribe(channel, (ch, msg) =>
        {
            for (const l of this.listeners)
            {
                l(ch, msg);
            }
        });
    }

    on(event: string, listener: (channel: string, message: string) => void): void
    {
        if (event === 'message')
        {
            this.listeners.push(listener);
        }
    }
}
