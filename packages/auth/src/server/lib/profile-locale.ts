/**
 * @spfn/auth - Profile locale
 *
 * `user_profiles.locale` stores a person's language choice, or NULL when they
 * never made one. Readers get both: `chosenLocale` is the stored value, so an
 * app can follow the system language when nothing was chosen, and `locale`
 * keeps its long-standing `'en'` fallback for code that only needs a string.
 */

export const DEFAULT_LOCALE = 'en';

export interface ProfileLocale
{
    locale: string;
    chosenLocale: string | null;
}

export function profileLocale(chosen: string | null): ProfileLocale
{
    return { locale: chosen ?? DEFAULT_LOCALE, chosenLocale: chosen };
}

/** A submitted choice: trimmed, and `null` or blank clears it. */
export function normalizeChosenLocale(value: string | null): string | null
{
    return value?.trim() || null;
}
