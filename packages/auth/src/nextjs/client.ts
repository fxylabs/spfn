/**
 * @spfn/auth - Next.js Client Components
 *
 * Client-side components for authentication.
 * These are 'use client' components that can be used in Next.js pages.
 *
 * @example
 * ```tsx
 * // app/auth/callback/page.tsx
 * export { OAuthCallback as default } from '@spfn/auth/nextjs/client';
 * ```
 */

export {
    OAuthCallback,
    useMfaConfirm,
    type OAuthCallbackProps,
    type MfaConfirm,
    type MfaConfirmState,
    type UseMfaConfirmOptions,
} from './components';

// The rule OAuthCallback applies before it navigates. Exported here too so a
// page that builds its own `returnUrl` validates it with the same function.
export { isSafeReturnPath } from '../lib/return-path';
