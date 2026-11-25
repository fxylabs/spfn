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
 * enum's own — all silently.
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
 */

import { describe, it } from 'vitest';

import { createEnvRegistry, EnvRegistry } from '../registry';
import { defineEnvSchema, envBoolean, envEnum, envJson, envNumber, envSecret, envString, envUrl } from '../schema';

const parseLetter = (value: string) => value as 'a' | 'b';

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
});
