# @spfn/i18n

> **One set of translations, used the same way on the server and in the browser**

Text lives in two places at once — in server responses and emails, and in React components. Keeping one catalog for both, without shipping every language to the browser and without a loading flash on first paint, is the part that is annoying to write twice.

`@spfn/i18n` is a small, content-agnostic internationalization runtime for SPFN and React applications. It supplies interpolation, fallback lookup, server helpers and a React context. Your application keeps what is genuinely yours: the translation catalogs, and how a locale is decided.

It is part of the default `spfn create --mode full` setup, so a scaffolded app already has it wired. If your product will only ever speak one language, nothing forces you to use it.

## Installation

```bash
pnpm add @spfn/i18n
```

Install React only when using the client entry point:

```bash
pnpm add react
```

Install Next.js 16.3.3 or later in the 16.x line when using the Next.js entry point:

```bash
pnpm add next@^16.3.3
```

## Catalogs

Catalogs are plain objects organized as `locale -> namespace -> key -> message`:

```ts
import type { LocaleCatalogs } from '@spfn/i18n';

export const catalogs: LocaleCatalogs = {
    en: {
        common: {
            greeting: 'Hello, {name}',
            save: 'Save',
        },
    },
    ko: {
        common: {
            greeting: '안녕하세요, {name}',
        },
    },
};
```

Messages support named string and number placeholders. A missing variable remains visible as its original placeholder, and an unknown message key is returned unchanged.

## How do I translate on the server?

Configure the server registry once during application startup:

```ts
import { configureI18n, getT } from '@spfn/i18n/server';
import { catalogs } from './catalogs';

configureI18n({ catalogs, fallbackLocale: 'en' });

const t = getT('common', user.locale);
console.log(t('greeting', { name: user.name }));
```

Locale selection stays with the application. It can come from an authenticated SPFN profile, a route parameter, a request header, or any other application policy.

## How do I use it in a Next.js app?

Resolve only the namespaces needed by the client subtree and pass them across the server/client boundary:

```tsx
// Server component
import { getClientMessages } from '@spfn/i18n/server';
import { I18nProvider } from '@spfn/i18n/client';

export function LocalizedLayout({
    locale,
    children,
}: {
    locale: string;
    children: React.ReactNode;
})
{
    const messages = getClientMessages(locale, ['common']);

    return (
        <I18nProvider locale={locale} messages={messages}>
            {children}
        </I18nProvider>
    );
}
```

Client components use namespace-scoped translators:

```tsx
'use client';

import { useLocale, useT } from '@spfn/i18n/client';

export function Greeting({ name }: { name: string })
{
    const locale = useLocale();
    const t = useT('common');

    return <p lang={locale}>{t('greeting', { name })}</p>;
}
```

`getClientMessages` merges fallback messages first and locale-specific messages second, so the client receives a complete, serializable dictionary without a loading flash.

## How do I make a mistyped key a compile error?

By default a wrong key is not caught anywhere: `t('checkout.readTems')` type-checks, runs, and renders the key string on the page. Register your catalog shape once and the compiler starts answering, everywhere `getT` and `useT` are used:

```ts
// src/i18n/keys.d.ts
import type { en } from './catalogs';

declare module '@spfn/i18n'
{
    interface I18nTypeRegistry { messages: typeof en }
}
```

Register one locale — the complete one, usually the fallback. `en` is the namespaced half of the catalog, `namespace -> key -> message`:

```ts
export const en = {
    checkout: {
        'checkout.readTerms': 'Read the terms',
        'checkout.submit': 'Pay',
    },
} as const;
```

The namespace argument and the key are then both checked against it:

```ts
const t = useT('checkout');       // 'checkout' | … — an unknown namespace fails
t('checkout.readTerms');          // ok
t('checkout.readTems');           // compile error
t('common.save');                 // compile error — another namespace's key
```

Registering is optional and additive. With no augmentation the registry stays empty, every namespace and key is plain `string`, and existing code compiles exactly as it did.

A key assembled at runtime cannot be checked, so name the key it stands for:

```ts
t(`pricing.skus.${sku}.name` as 'pricing.skus.pro.name');
```

## How do I find the keys I missed?

Types cover the keys you wrote; `onMissingKey` covers the ones nobody wrote. It fires when neither the requested locale nor the fallback locale has an entry — a key the fallback answers is not missing — and the lookup still returns the key itself:

```ts
configureI18n({
    catalogs,
    fallbackLocale: 'en',
    onMissingKey: key => logger.warn({ key }, 'missing translation'),
});
```

`I18nProvider` takes the same prop for the client side. Give it a handler with a stable identity — a module-level function, or one wrapped in `useCallback` — because a new function on every render is a new context value on every render:

```tsx
<I18nProvider locale={locale} messages={messages} onMissingKey={report}>
```

The handler runs inside the lookup and its exceptions are not caught, so throwing from it is a way to make a test run or a CI build fail on a key nobody translated. `createTranslator` accepts the same handler as a third argument.

## How do I route localized Next.js pages?

Define the URL policy separately from your catalogs. This example keeps English at `/` and puts Korean at `/ko` while both render from `app/[locale]`:

```ts
// src/i18n/routing.ts
import { defineI18nRouting } from '@spfn/i18n/routing';

export const routing = defineI18nRouting({
    locales: ['en', 'ko'],
    defaultLocale: 'en',
    localePrefix: 'as-needed',
    siteUrl: 'https://example.com',
});
```

The application declares which paths are localized. `createLocaleProxy` does not guess, so API, auth and machine routes pass through unless you include them:

```ts
// src/proxy.ts
import { createLocaleProxy } from '@spfn/i18n/next';
import { routing } from './i18n/routing';

export default createLocaleProxy(routing, {
    isLocalizedPath: pathname => pathname === '/',
});

// Next.js requires a statically analyzable matcher.
export const config = { matcher: ['/', '/en', '/ko'] };
```

With `localePrefix: 'as-needed'`, `/` is internally rewritten to `/en`, a direct `/en` request permanently redirects to `/`, and `/ko` remains public. Query parameters are preserved.

Use the same policy when creating Next.js metadata:

```ts
const alternates = routing.localizedMetadata({ locale: 'ko' });
// {
//   canonical: 'https://example.com/ko',
//   languages: { en: 'https://example.com/', ko: 'https://example.com/ko', 'x-default': 'https://example.com/' }
// }
```

`isLocalizedPath` is always asked about a normalized pathname, so declare `/pricing` and never `/pricing/` — a request for either reaches the same declaration, and the response keeps whichever trailing-slash convention the request arrived with. A `siteUrl` may carry a path of its own: `https://example.com/docs/` puts every canonical and alternate under `/docs`. When `availableLocales` omits the page's own locale, `localizedMetadata` adds it back, because search engines discard a set of hreflang links that does not name the page it describes.

Your app still owns locale validation in `[locale]/layout.tsx`, `<html lang>`, catalogs, `generateStaticParams`, and the proxy matcher. The package only keeps their path and metadata decisions consistent.

## Can I use it without React or SPFN?

Yes. The package root is a standalone translator:

```ts
import { createTranslator } from '@spfn/i18n';

const t = createTranslator(
    { greeting: 'Bonjour, {name}' },
    { farewell: 'Goodbye' },
);

t('greeting', { name: 'Ada' }); // "Bonjour, Ada"
t('farewell'); // "Goodbye"
t('missing'); // "missing"
```

## FAQ

**Where does the locale come from?**
From your application, always. This package never guesses. Common sources are the authenticated SPFN profile (`@spfn/auth` stores a per-user locale and exposes `updateLocale`), a route segment such as `/ko/...`, or an `Accept-Language` header. Pass whichever you use into `getT` and `getClientMessages`.

**Does the browser download every language?**
No, and that is what `getClientMessages(locale, ['common'])` is for: it resolves the one locale and only the namespaces that subtree needs, merges the fallback underneath, and hands the result to `I18nProvider` as a complete dictionary. Nothing loads after paint, so there is no flash of untranslated text.

**What happens to a key I forgot to translate?**
The fallback locale answers first. If it has no entry either, the key itself is returned unchanged, so a missed string shows up as `checkout.submit` rather than as an empty page, and `onMissingKey` reports the lookup. A missing interpolation variable stays visible as `{name}` for the same reason.

**Can it format dates, currency or plurals?**
No — use the platform's `Intl` APIs. See Scope below for what else the package deliberately leaves to you.

## Scope

This runtime intentionally does not load catalog files, detect locales, format dates or numbers, or implement plural rules. Use platform `Intl` APIs for locale-aware formatting and keep catalog loading and locale policy in the consuming application.

Interpolation returns strings; it does not sanitize HTML. React escapes text values by default, but applications must sanitize messages before inserting them as raw HTML.

## License

MIT
