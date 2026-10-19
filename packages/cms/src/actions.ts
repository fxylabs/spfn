'use server';

import { cookies } from 'next/headers.js';

const LOCALE_COOKIE_NAME = 'cms-locale';
const LOCALE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year

/**
 * Set user's preferred locale in cookie
 *
 * @param locale - Language code (e.g., 'ko', 'en', 'ja')
 */
export async function setLocale(locale: string): Promise<void>
{
    const cookieStore = await cookies();

    cookieStore.set(LOCALE_COOKIE_NAME, locale, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: LOCALE_MAX_AGE,
        path: '/',
    });
}

/**
 * Get user's preferred locale from cookie
 *
 * @param defaultLocale - Default locale from labelConfig.defaultLocale
 * @returns Language code (from cookie, or defaultLocale, or 'en')
 */
export async function getLocale(defaultLocale?: string): Promise<string>
{
    const cookieStore = await cookies();
    const localeCookie = cookieStore.get(LOCALE_COOKIE_NAME);

    return localeCookie?.value ?? defaultLocale ?? 'en';
}
