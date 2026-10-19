import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/**
 * Derived key types. Rows T1–T5 belong to the qualified-key case table in
 * `qualified-keys.test.tsx`:
 *
 * | #  | call                                                                     | expected                                                   |
 * |----|--------------------------------------------------------------------------|------------------------------------------------------------|
 * | T1 | registered shape: `t('network.reconnectin')`                             | compile error (`@ts-expect-error`)                         |
 * | T2 | registered shape with a namespace named `a.b`: its key, qualified        | compile error                                              |
 * | T3 | no registered shape                                                      | `QualifiedKey` is `string`; `getT('en')` / `useT()` return `Translator<string>` |
 * | T4 | registered shape: one-argument `getT('common')`, then `t('save')`        | compile error at the `t('save')` call                      |
 * | T5 | existing `useT(ns)` / `getT(ns, locale)` tests and type tests            | unchanged and green                                        |
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { useT } from '../client';
import { configureI18n, getT } from '../server';
import {
    createQualifiedTranslator,
    type MessageKey,
    type MessageKeyOf,
    type Namespace,
    type NamespaceOf,
    type QualifiedKey,
    type QualifiedKeyOf,
    type Translator,
} from '../index';

/**
 * Stands in for a catalog an application registers through
 * `declare module '@spfn/i18n'`. Augmenting the package's own module id from
 * inside its own sources is not possible, so the derived helpers are exercised
 * against this shape directly — the augmented path composes them the same way.
 */
interface DemoCatalog
{
    checkout: {
        'checkout.readTerms': string;
        'checkout.submit': string;
    };
    common: {
        'common.save': string;
    };
}

type DemoNamespace = NamespaceOf<DemoCatalog>;

type DemoKey<N extends DemoNamespace> = MessageKeyOf<DemoCatalog, N>;

type DemoGetT = <N extends DemoNamespace>(namespace: N) => Translator<DemoKey<N>>;

/**
 * Compile-time assertions: never called, `tsc --noEmit` is what runs them.
 * Every `@ts-expect-error` fails the build if the line stops being an error.
 */
export function registeredKeysAreChecked(getDemoT: DemoGetT): void
{
    const t = getDemoT('checkout');

    t('checkout.readTerms');
    t('checkout.submit', { name: 'Ada' });

    // @ts-expect-error a mistyped key is not a key of this namespace
    t('checkout.readTems');

    // @ts-expect-error another namespace's key is not a key of this one
    t('common.save');

    // @ts-expect-error an unregistered namespace is not selectable
    getDemoT('billing');

    // The escape hatch documented for dynamic keys.
    const sku: string = 'submit';
    t(`checkout.${sku}` as DemoKey<'checkout'>);
}

describe('derived key types', () =>
{
    it('degrades to plain string while no catalog is registered', () =>
    {
        expectTypeOf<Namespace>().toEqualTypeOf<string>();
        expectTypeOf<Namespace>().not.toBeNever();
        expectTypeOf<MessageKey<'anything'>>().toEqualTypeOf<string>();
        expectTypeOf<MessageKey<'anything'>>().not.toBeNever();
        expectTypeOf<MessageKey<string>>().toEqualTypeOf<string>();

        const translate = getT('anything', 'en');

        expectTypeOf(translate).parameter(0).toEqualTypeOf<string>();
        expect(translate('any.key')).toBe('any.key');
    });

    it('names the namespaces and keys of a registered catalog', () =>
    {
        expectTypeOf<DemoNamespace>().toEqualTypeOf<'checkout' | 'common'>();
        expectTypeOf<DemoKey<'checkout'>>()
            .toEqualTypeOf<'checkout.readTerms' | 'checkout.submit'>();
        expectTypeOf<DemoKey<'common'>>().toEqualTypeOf<'common.save'>();
        expectTypeOf<DemoKey<DemoNamespace>>()
            .toEqualTypeOf<'checkout.readTerms' | 'checkout.submit' | 'common.save'>();
    });
});

/** A registered shape whose keys do not repeat their namespace, plus one dotted namespace. */
interface QualifiedDemoCatalog
{
    network: {
        reconnecting: string;
    };
    workspace: {
        'session.ended.allow': string;
    };
    common: {
        save: string;
    };
    'a.b': {
        c: string;
    };
}

type DemoQualifiedKey = QualifiedKeyOf<QualifiedDemoCatalog>;

type DemoQualifiedNamespace = NamespaceOf<QualifiedDemoCatalog>;

/** Mirrors `getT`'s two public signatures over the demo shape. */
interface DemoOverloadedGetT
{
    (locale: string): Translator<DemoQualifiedKey>;
    <N extends DemoQualifiedNamespace>(namespace: N, locale: string): Translator<MessageKeyOf<QualifiedDemoCatalog, N>>;
}

describe('qualified key types', () =>
{
    const t = createQualifiedTranslator<DemoQualifiedKey>({});

    it('names namespace.key for every undotted namespace of a registered catalog', () =>
    {
        expectTypeOf<DemoQualifiedKey>().toEqualTypeOf<
            'network.reconnecting' | 'workspace.session.ended.allow' | 'common.save'
        >();
    });

    it('T1 a mistyped qualified key is a compile error', () =>
    {
        t('network.reconnecting');

        // @ts-expect-error a mistyped key is not a qualified key of the catalog
        t('network.reconnectin');
    });

    it('T2 a key of a namespace whose name contains a dot is a compile error', () =>
    {
        // @ts-expect-error `a.b.c` would split into namespace `a`, so it is left out
        t('a.b.c');
    });

    it('T3 degrades to plain string while no catalog is registered', () =>
    {
        const qualifiedHook = () => useT();

        configureI18n({ catalogs: {} });

        expectTypeOf<QualifiedKey>().toEqualTypeOf<string>();
        expectTypeOf(getT('en')).toEqualTypeOf<Translator<string>>();
        expectTypeOf<ReturnType<typeof qualifiedHook>>().toEqualTypeOf<Translator<string>>();
        expect(getT('en')('any.key')).toBe('any.key');
    });

    it('T4 a namespace passed to the one-argument form makes the namespaced key a compile error', () =>
    {
        const getDemoT = getT as DemoOverloadedGetT;
        const forgotLocale = getDemoT('common');

        forgotLocale('common.save');

        // @ts-expect-error `common` was taken as a locale, so keys are qualified
        forgotLocale('save');

        getDemoT('common', 'en')('save');
    });
});

const distDirectory = new URL('../../dist/', import.meta.url);

function readDist(name: string): string | undefined
{
    const path = fileURLToPath(new URL(name, distDirectory));

    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

describe('published type surface', () =>
{
    // These assertions describe dist, so they stand down before a build.
    it('routes the client and server entries through the root module', () =>
    {
        const index = readDist('index.d.ts');
        const client = readDist('client.d.ts');
        const server = readDist('server.d.ts');

        if (!index || !client || !server)
        {
            return;
        }

        // An inlined copy of the registry would be a separate declaration, and
        // an application's `declare module '@spfn/i18n'` would never reach it.
        expect(index).toContain('type I18nTypeRegistry');
        expect(client).toContain(`from './index.js'`);
        expect(client).not.toContain('interface I18nTypeRegistry');
        expect(client).toMatch(/import \{[^}]*\bQualifiedKey\b[^}]*\} from '\.\/index\.js'/);
        expect(server).toContain(`from './index.js'`);
        expect(server).not.toContain('interface I18nTypeRegistry');
    });
});
