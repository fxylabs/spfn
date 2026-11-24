/**
 * @spfn/core/options - the rule for reading an application's options (#477, #492)
 *
 * The rule's own rows, moved from `@spfn/auth`'s `stated-options.test.ts`
 * with the module: a value that is not a plain object refused (with the
 * prototype posing as `Object.prototype`, and a Proxy, whose names do not say
 * what a read finds), an unknown own name refused when it is not enumerable,
 * and a getter read exactly once, the snapshot holding what that read
 * answered — so the value a reader checks is the value it stores.
 * `readRecords`' rows: a list that is not an array, a Proxy array, and a
 * hole, refused. `readList`'s row: what it answers is a frozen copy, which a
 * later change to the application's array does not reach. Each reader's own
 * rows stay with its package.
 *
 * Then the host's Proxy test (#492): with `process.getBuiltinModule` absent,
 * as in a browser or edge bundle, a Proxy is read under every other part of
 * the rule; with it, a Proxy is refused. Without these rows the browser path
 * could throw on every call — a `node:util` import that a bundle replaces
 * with a userland `util` whose `types.isProxy` throws, or a
 * `getBuiltinModule` called where there is none — and no suite run under Node
 * would see it.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { readList, readOptions, readRecords } from '../index';

/** `readOptions` as a reader of two channels calls it. */
function readChannels(options: unknown): Partial<Record<string, unknown>>
{
    return readOptions<Record<string, unknown>>('channels', options, ['signup', 'deviceCode']);
}

/** An object whose every option is inherited, none its own. */
function inherited(options: object): object
{
    return Object.create(options);
}

describe('readOptions (#477)', () =>
{
    it('refuses a value that is not a plain object — an inherited option would be applied or lost unseen', () =>
    {
        class Options
        {
            signup = false;
        }

        expect(() => readChannels(new Options())).toThrow('channels must be a plain object');
        expect(() => readChannels(inherited({ sigup: false }))).toThrow('channels must be a plain object');
        expect(() => readChannels(inherited({ signup: false }))).toThrow('channels must be a plain object');
    });

    it('refuses a prototype posing as Object.prototype — the fake would apply an inherited option unchecked', () =>
    {
        const namesObject = Object.assign(Object.create(null), { constructor: Object, signup: false });
        const namedBack = Object.assign(Object.create(null), { signup: false });
        namedBack.constructor = Object.defineProperty(() => undefined, 'name', { value: 'Object' });
        namedBack.constructor.prototype = namedBack;

        expect(() => readChannels(Object.create(namesObject))).toThrow('channels must be a plain object');
        expect(() => readChannels(Object.create(namedBack))).toThrow('channels must be a plain object');
    });

    it('refuses a Proxy — its names do not say what a read finds, so its options would take their defaults unseen', () =>
    {
        const getOnly = new Proxy({}, { get: (_target, key) => (key === 'signup' ? false : undefined) });

        expect(() => readChannels(getOnly)).toThrow('channels must be a plain object');
    });

    it('refuses an unknown own name that is not enumerable — a misspelt option would be read as left out', () =>
    {
        expect(() => readChannels(Object.defineProperty({}, 'sigup', { value: false, enumerable: false })))
            .toThrow('channels.sigup is not an option.');
    });

    it('reads a getter once, and the snapshot holds what that read answered', () =>
    {
        const answers = [true, 'yes'];
        let reads = 0;
        const options = {
            get signup()
            {
                return answers[reads++];
            },
        };

        expect(readChannels(options)).toEqual({ signup: true });
        expect(reads).toBe(1);
    });
});

describe('readRecords (#477)', () =>
{
    const KEYS = ['name'] as const;

    it('refuses a list that is not an array — a Set has no length, and its records would be declared as none', () =>
    {
        expect(() => readRecords<{ name: string }>('roles', new Set([{ name: 'editor' }]), [...KEYS]))
            .toThrow('roles must be an array of plain objects');
    });

    it('refuses a Proxy array — the place it says it holds and the record a read of it finds can differ', () =>
    {
        const records = new Proxy(Array(1), {
            getOwnPropertyDescriptor: (target, key) => key === '0'
                ? { configurable: true, enumerable: true, value: { name: 'claimed' } }
                : Reflect.getOwnPropertyDescriptor(target, key),
            get: (target, key, receiver) => key === '0' ? { name: 'read-instead' } : Reflect.get(target, key, receiver),
        });

        expect(() => readRecords<{ name: string }>('roles', records, [...KEYS])).toThrow('roles must be an array');
    });

    it('refuses a hole — its read would find whatever Array.prototype holds at that place', () =>
    {
        Object.defineProperty(Array.prototype, '1', { value: { name: 'planted' }, configurable: true });

        try
        {
            expect(() => readRecords<{ name: string }>('roles', [{ name: 'editor' }, , { name: 'viewer' }], [...KEYS]))
                .toThrow('roles[1] is empty');
        }
        finally
        {
            delete (Array.prototype as unknown as Record<string, unknown>)['1'];
        }
    });
});

describe('readList (#477)', () =>
{
    it('reads a copy — a later push or index assignment on the application\'s array changes nothing checked', () =>
    {
        const scopes = ['read'];
        const read = readList<string>('defaultScopes', scopes, 'of scope names');

        scopes.push('write');
        scopes[0] = 'admin';

        expect(read).toEqual(['read']);
        expect(Object.isFrozen(read)).toBe(true);
    });
});

describe('the host\'s Proxy test (#492)', () =>
{
    const getBuiltinModule = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule')!;

    afterEach(() =>
    {
        Object.defineProperty(process, 'getBuiltinModule', getBuiltinModule);
    });

    it('reads a Proxy under every other part of the rule where the host cannot tell one', () =>
    {
        delete (process as { getBuiltinModule?: unknown }).getBuiltinModule;

        expect(readChannels(new Proxy({ signup: false }, {}))).toEqual({ signup: false });
        expect(() => readChannels(new Proxy({ sigup: false }, {}))).toThrow('channels.sigup is not an option.');
    });

    it('refuses a Proxy on Node, naming it', () =>
    {
        expect(() => readChannels(new Proxy({ signup: false }, {}))).toThrow('channels must be a plain object '
            + 'naming its options — signup, deviceCode; received a Proxy, whose names do not say what a read of it finds.');
    });
});
