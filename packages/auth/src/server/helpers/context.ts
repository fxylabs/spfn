/**
 * Auth Context Helpers
 *
 * Helper functions to access authenticated user data from route context
 */

import type { Context } from 'hono';
import type { AuthContext } from '../middleware';

/**
 * Get auth context from route context
 *
 * Accepts both raw Hono Context and RouteContext with raw property
 *
 * @example
 * ```typescript
 * // With RouteContext (RPC routes)
 * app.bind(logoutContract, [authenticate], async (c) => {
 *     const { user, userId, keyId } = getAuth(c);
 *     // Use authenticated data...
 * });
 *
 * // With raw Context (middleware)
 * const auth = getAuth(c);
 * ```
 */
export function getAuth(c: Context | { raw: Context }): AuthContext
{
    // Check if it's RouteContext with raw property
    if ('raw' in c && c.raw)
    {
        return c.raw.get('auth');
    }

    // Otherwise, it's raw Hono Context
    return (c as Context).get('auth');
}

/**
 * Get optional auth context from route context
 *
 * Returns AuthContext if authenticated, undefined otherwise.
 * Use with `optionalAuth` middleware for routes that serve both
 * authenticated and unauthenticated users.
 *
 * @example
 * ```typescript
 * export const getProducts = route.get('/products')
 *   .use([optionalAuth])
 *   .handler(async (c) => {
 *     const auth = getOptionalAuth(c);
 *
 *     if (auth)
 *     {
 *       return getPersonalizedProducts(auth.userId);
 *     }
 *
 *     return getPublicProducts();
 *   });
 * ```
 */
export function getOptionalAuth(c: Context | { raw: Context }): AuthContext | undefined
{
    if ('raw' in c && c.raw)
    {
        return c.raw.get('auth');
    }

    return (c as Context).get('auth');
}

/**
 * Get authenticated user from route context
 *
 * @example
 * ```typescript
 * app.bind(profileContract, [authenticate], async (c) => {
 *     const user = getUser(c);
 *     return c.success({ email: user.email });
 * });
 * ```
 */
export function getUser(c: Context | { raw: Context })
{
    return getAuth(c).user;
}

/**
 * Get authenticated user ID from route context
 *
 * @example
 * ```typescript
 * app.bind(postsContract, [authenticate], async (c) => {
 *     const userId = getUserId(c);
 *     const posts = await findPosts({ authorId: userId });
 * });
 * ```
 */
export function getUserId(c: Context | { raw: Context }): string
{
    return getAuth(c).userId;
}

/**
 * Get authenticated user's role from route context
 *
 * @returns Role name or null if user has no role
 *
 * @example
 * ```typescript
 * app.bind(adminContract, [authenticate], async (c) => {
 *     const role = getRole(c);
 *     // 'admin' | 'superadmin' | null
 * });
 * ```
 */
export function getRole(c: Context | { raw: Context }): string | null
{
    return getAuth(c).role;
}

/**
 * Get authenticated user's locale from route context
 *
 * @returns Locale string (e.g., 'en', 'ko')
 *
 * @example
 * ```typescript
 * app.bind(contract, [authenticate], async (c) => {
 *     const locale = getLocale(c);
 *     // 'en' | 'ko' | ...
 * });
 * ```
 */
export function getLocale(c: Context | { raw: Context }): string
{
    return getAuth(c).locale;
}

/**
 * Get the authenticated user's own language choice from route context
 *
 * @returns The chosen locale, or `null` when the person never chose one —
 *          the cue to follow the request's language (`Accept-Language`,
 *          a cookie) rather than defaulting to `'en'`.
 *
 * @example
 * ```typescript
 * app.bind(contract, [authenticate], async (c) => {
 *     const chosen = getChosenLocale(c);
 *     // 'ko' | null
 * });
 * ```
 */
export function getChosenLocale(c: Context | { raw: Context }): string | null
{
    return getAuth(c).chosenLocale ?? null;
}

/**
 * Get current key ID from route context
 *
 * @example
 * ```typescript
 * app.bind(rotateKeyContract, [authenticate], async (c) => {
 *     const oldKeyId = getKeyId(c);
 *     // Revoke old key...
 * });
 * ```
 */
export function getKeyId(c: Context | { raw: Context }): string
{
    return getAuth(c).keyId;
}
