/**
 * An env schema entry states only what its schema type declares (#492) —
 * type rows: `pnpm type-check` fails when a directive below is unused, that
 * is, when the entry point it guards accepts a key its schema does not
 * declare.
 *
 * Every entry point takes the entry through a type parameter, which turns the
 * compiler's excess-property check off, and nothing at run time reads a key
 * it does not know. Without these rows the constraint removed from one entry
 * point compiles everywhere, and a misspelt `required` boots without the
 * variable, a misspelt `default` has none, an `envSecret` `sensitive: false`
 * is overwritten with `true`, and an `envEnum` `validator` is replaced by the
 * enum's own — all silently. Without the K rows below, widening a helper's own
 * declared list to admit `key` and `type` compiles everywhere too: `key`
 * reaches the entry (`defineEnvSchema` then overwrites it with the object's
 * key, so it looked harmless on `main`), and `type` is silently replaced by
 * the helper's own.
 *
 * Each directive sits on the line of the undeclared key: the error must land
 * there, not on the whole entry.
 *
 * | #   | entry point                                   | form                                 |
 * |-----|-----------------------------------------------|--------------------------------------|
 * | D1  | `envString`                                   | misspelt `required`                  |
 * | D2  | `envSecret`                                   | misspelt `required`                  |
 * | D3  | `envNumber`                                   | misspelt `default`                   |
 * | D4  | `envBoolean`                                  | misspelt `default`                   |
 * | D5  | `envUrl`                                      | misspelt `required`                  |
 * | D6  | `envEnum` (two type parameters)               | misspelt `default`                   |
 * | D7  | `envJson`, inferred                           | misspelt `required`                  |
 * | D8  | `envSecret`                                   | `sensitive`, which it overwrites     |
 * | D9  | `envEnum`                                     | `validator`, which it overwrites     |
 * | D10 | `envString`                                   | misspelt key in a variable           |
 * | D11 | `defineEnvSchema`                             | entry written without a helper       |
 * | D12 | `defineEnvSchema`                             | key beside a spread helper           |
 * | D13 | `createEnvRegistry`                           | entry handed straight in             |
 * | D14 | `new EnvRegistry`                             | entry handed straight in             |
 *
 * `key` and `type` are declared by `EnvVarSchema` itself, so a helper must
 * exclude both from its own option type — the type parameter it bounds its
 * call with admits every key `EnvVarSchema` declares unless the helper says
 * otherwise. The K rows pin that each helper's own `Omit<…, 'key' | 'type'>`
 * (or the wider exclusion `envSecret` / `envEnum` / `envJson` state) still
 * excludes both.
 *
 * | #   | entry point                                   | form                                 |
 * |-----|-----------------------------------------------|--------------------------------------|
 * | K1  | `envString`                                   | `key` inside the call                |
 * | K2  | `envString`                                   | `type` inside the call               |
 * | K3  | `envJson`, inferred                           | `key` inside the call                |
 * | K4  | `envJson`, inferred                           | `type` inside the call               |
 * | K5  | —                                             | documented spread form compiles      |
 *
 * An application's own generic wrapper around an entry point restates the
 * bound with the two exported types, `OnlyDeclared` and `OnlyDeclaredEntries`.
 * This repository has no such wrapper, so without the W rows a change to the
 * constraint that breaks the documented migration compiles everywhere here.
 * Each W row imports the types from the public entry, as an application does.
 *
 * | #   | wrapper                                       | form                                 |
 * |-----|-----------------------------------------------|--------------------------------------|
 * | W1  | around `envString`                            | restated, type argument inferred     |
 * | W2  | around `envString`                            | restated, type argument given        |
 * | W3  | around `envString`, adding a key by spread    | restated without the added key       |
 * | W4  | around `defineEnvSchema`                      | restated                             |
 * | W5  | around `createEnvRegistry`                    | restated                             |
 * | W6  | W1, W3                                        | misspelt key refused                 |
 * | W7  | W2, W3, W4                                    | result keeps its inference           |
 * | W8  | around `envString`                            | loose bound: refused (documented)    |
 */

import { describe, it } from 'vitest';

import type { EnvSchemaCollection, EnvVarSchema, OnlyDeclared, OnlyDeclaredEntries } from '../index';
import { createEnvRegistry, EnvRegistry } from '../registry';
import { defineEnvSchema, envBoolean, envEnum, envJson, envNumber, envSecret, envString, envUrl } from '../schema';

const parseLetter = (value: string) => value as 'a' | 'b';

type StringOptions = Omit<EnvVarSchema, 'key' | 'type'>;

type EntryOptions = Omit<EnvVarSchema<any>, 'key'>;

function appString<T extends StringOptions>(options: OnlyDeclared<T, StringOptions>)
{
    return envString(options);
}

function appStringGiven<T extends StringOptions>(options: OnlyDeclared<T, StringOptions>)
{
    return envString<T>(options);
}

function appPaymentKey<T extends Omit<StringOptions, 'description'>>(
    options: OnlyDeclared<T, Omit<StringOptions, 'description'>>,
)
{
    return envString({ description: 'Payment provider key', ...options });
}

function appSchema<T extends Record<string, EntryOptions>>(schema: OnlyDeclaredEntries<T>)
{
    return defineEnvSchema(schema);
}

function appRegistry<T extends EnvSchemaCollection>(schemas: OnlyDeclaredEntries<T>)
{
    return createEnvRegistry(schemas);
}

describe('an env schema entry states only what its schema declares (#492)', () =>
{
    it('D1-D7 a misspelt key through each helper signature', () =>
    {
        // @ts-expect-error -- D1 `requried` is not `required`
        envString({ description: 'x', requried: true });
        // @ts-expect-error -- D2
        envSecret({ description: 'x', requried: true });
        // @ts-expect-error -- D3 `defualt` is not `default`
        envNumber({ description: 'x', defualt: 3000 });
        // @ts-expect-error -- D4
        envBoolean({ description: 'x', defualt: true });
        // @ts-expect-error -- D5
        envUrl({ description: 'x', requried: true });
        // @ts-expect-error -- D6
        envEnum(['a', 'b'] as const, { description: 'x', defualt: 'a' });
        // @ts-expect-error -- D7
        envJson({ description: 'x', requried: true });
    });

    it('D8-D9 an option the helper overwrites', () =>
    {
        // @ts-expect-error -- D8 an `envSecret` is sensitive; a non-secret is `envString`
        envSecret({ description: 'x', sensitive: false });
        // @ts-expect-error -- D9 an enum's validator is its own
        envEnum(['a', 'b'] as const, { description: 'x', validator: parseLetter });
    });

    it('D10 a misspelt key in a variable passed to a helper', () =>
    {
        const options = { description: 'x', requried: true };

        // @ts-expect-error -- D10
        envString(options);
    });

    it('D11-D12 an entry inside defineEnvSchema', () =>
    {
        defineEnvSchema({
            // @ts-expect-error -- D11
            X: { type: 'string', description: 'x', requried: true },
            Y: {
                ...envString({ description: 'y' }),
                // @ts-expect-error -- D12
                category: 'cms',
            },
        });
    });

    it('D13-D14 an entry handed straight to the registry', () =>
    {
        createEnvRegistry({
            // @ts-expect-error -- D13
            X: { key: 'X', type: 'string', description: 'x', requried: true },
        });
        new EnvRegistry({
            // @ts-expect-error -- D14
            X: { key: 'X', type: 'string', description: 'x', requried: true },
        });
    });

    it('K1-K4 `key` and `type` inside a helper call are refused', () =>
    {
        // `key` reaches the entry only through `defineEnvSchema`, or a spread beside the call
        // @ts-expect-error -- K1
        envString({ description: 'x', key: 'API_KEY' });
        // @ts-expect-error -- K2 `type` is the helper's own
        envString({ description: 'x', type: 'number' });
        // @ts-expect-error -- K3
        envJson({ description: 'x', key: 'API_KEY' });
        // @ts-expect-error -- K4
        envJson({ description: 'x', type: 'number' });
    });

    it('K5 the documented spread form compiles where an EnvVarSchema is expected', () =>
    {
        const entry: EnvVarSchema = { ...envString({ description: 'x' }), key: 'API_KEY' };

        void entry;
    });

    it('W1-W5 an application wrapper that restates the bound compiles', () =>
    {
        appString({ description: 'x', required: true });
        appStringGiven({ description: 'x', required: true });
        appPaymentKey({ required: true });
        appSchema({ X: envString({ description: 'x' }) });
        appRegistry({ X: { key: 'X', type: 'string', description: 'x' } });
    });

    it('W6 a misspelt key handed to a restated wrapper', () =>
    {
        // @ts-expect-error -- W6
        appString({ description: 'x', requried: true });
        // @ts-expect-error -- W6 the key the wrapper adds is not the caller's
        appPaymentKey({ description: 'x' });
    });

    it('W7 the result of a restated wrapper keeps its inference', () =>
    {
        // a `default` makes the value present: `string`, not `string | undefined`
        const fallback: string = appStringGiven({ description: 'x', default: 'a' }).default;
        const paymentFallback: string = appPaymentKey({ default: 'k' }).default;
        const key: 'X' = appSchema({ X: envString({ description: 'x' }) }).X.key;

        void fallback;
        void paymentFallback;
        void key;
    });

    it('W8 a wrapper whose own bound admits any key is refused', () =>
    {
        function looseString<T extends StringOptions>(options: T)
        {
            // @ts-expect-error -- W8 its `T` may carry any key; restate the bound
            return envString(options);
        }

        void looseString;
    });
});
