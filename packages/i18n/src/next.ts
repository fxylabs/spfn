import { NextResponse, type NextRequest } from 'next/server';
import { matchLocale, parseAcceptLanguage } from './internal/accept-language';
import { normalizePathname } from './internal/path';
import type { LocalePrefix } from './routing';

export interface LocaleRoutingAdapter<Locale extends string>
{
    defaultLocale: Locale;
    localePrefix: LocalePrefix;
    hasLocale(value: string): value is Locale;
    publicPath(locale: Locale, pathname?: string): string;
    internalPath(locale: Locale, pathname?: string): string;
}

export interface LocaleProxyOptions
{
    /** The app-owned set of public pathnames that have localized route trees. */
    isLocalizedPath(pathname: string): boolean;
}

/**
 * Splits a request pathname into its first segment and the rest, both
 * normalized. The proxy matches on the same shape the routing policy builds,
 * so a request for `/pricing/` reaches the same declaration as `/pricing`.
 */
function pathWithoutLocale(pathname: string): { locale: string; pathname: string }
{
    const [, locale = '', ...rest] = normalizePathname(pathname).split('/');

    return {
        locale,
        pathname: rest.length === 0 ? '/' : normalizePathname(`/${rest.join('/')}`),
    };
}

/**
 * Routes app-declared localized paths through one internal `[locale]` tree.
 * The consuming app still owns `proxy.ts`, its static matcher, and the route
 * list; undeclared API and machine paths pass through unchanged.
 */
export function createLocaleProxy<Locale extends string>(
    routing: LocaleRoutingAdapter<Locale>,
    options: LocaleProxyOptions,
): (request: NextRequest) => NextResponse
{
    return function localeProxy(request: NextRequest): NextResponse
    {
        const url = request.nextUrl.clone();
        const pathname = normalizePathname(url.pathname);
        const localized = pathWithoutLocale(url.pathname);

        if (routing.hasLocale(localized.locale) && options.isLocalizedPath(localized.pathname))
        {
            if (routing.localePrefix === 'as-needed' && localized.locale === routing.defaultLocale)
            {
                url.pathname = routing.publicPath(localized.locale, localized.pathname);

                return NextResponse.redirect(url, 308);
            }

            return NextResponse.next();
        }

        if (options.isLocalizedPath(pathname))
        {
            if (routing.localePrefix === 'always')
            {
                url.pathname = routing.publicPath(routing.defaultLocale, pathname);

                return NextResponse.redirect(url, 308);
            }

            url.pathname = routing.internalPath(routing.defaultLocale, pathname);

            return NextResponse.rewrite(url);
        }

        return NextResponse.next();
    };
}

export const LOCALE_COOKIE_NAME = 'spfn-locale';

const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Read side of a cookie store: `cookies()` and `NextRequest.cookies` both fit. */
export interface CookieReader
{
    get(name: string): { value: string } | undefined;
}

/** Write side of a cookie store: `NextResponse.cookies` and `cookies()` inside a server action both fit. */
export interface CookieWriter
{
    set(name: string, value: string, options: LocaleCookieOptions): unknown;
}

export interface LocaleCookieOptions
{
    path: string;
    sameSite: 'lax';
    httpOnly: boolean;
    secure: boolean;
    maxAge: number;
}

export interface NegotiateLocaleOptions<Locale extends string>
{
    locales: readonly Locale[];
    fallback: Locale;
    /** A signed-in person's saved choice, e.g. `chosenLocale` from `@spfn/auth`. */
    chosen?: string | null;
    cookies?: CookieReader;
    headers?: { get(name: string): string | null };
}

/**
 * Resolves the locale for an application request: the person's saved choice,
 * else the language picked on this browser, else the best supported match
 * from `Accept-Language`, else the fallback. A value that is not one of
 * `locales` is skipped, never returned.
 */
export function negotiateLocale<Locale extends string>(options: NegotiateLocaleOptions<Locale>): Locale
{
    const { locales, fallback } = options;

    if (!locales.includes(fallback))
    {
        throw new Error(`negotiateLocale: fallback "${fallback}" is not one of the supported locales`);
    }

    const requested = [
        options.chosen,
        options.cookies?.get(LOCALE_COOKIE_NAME)?.value,
        ...parseAcceptLanguage(options.headers?.get('accept-language') ?? ''),
    ];

    for (const tag of requested)
    {
        const match = tag ? matchLocale(tag, locales) : null;

        if (match !== null)
        {
            return match;
        }
    }

    return fallback;
}

function localeCookieOptions(maxAge: number): LocaleCookieOptions
{
    return {
        path: '/',
        sameSite: 'lax',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge,
    };
}

/**
 * Keeps a person's explicit language choice on this browser. Write it only
 * when the person picks a language — never from a negotiated value, so a
 * person who changes their system language is still followed.
 */
export const localeCookie = {
    name: LOCALE_COOKIE_NAME,
    set(store: CookieWriter, locale: string): void
    {
        store.set(LOCALE_COOKIE_NAME, locale, localeCookieOptions(LOCALE_COOKIE_MAX_AGE));
    },
    clear(store: CookieWriter): void
    {
        store.set(LOCALE_COOKIE_NAME, '', localeCookieOptions(0));
    },
};
