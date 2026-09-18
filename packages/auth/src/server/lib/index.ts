/**
 * @spfn/auth/lib
 *
 * Universal Node.js library for authentication
 * 범용 Node.js 라이브러리 (모든 Node.js 환경에서 사용 가능)
 *
 * - Key generation (ES256/RS256)
 * - JWT signing and verification
 * - Session encryption (Jose JWE)
 * - Session TTL configuration
 *
 * Use Cases:
 * - Next.js API Routes
 * - Express servers
 * - Fastify servers
 * - Any Node.js environment
 */

export * from './crypto';
export * from './session';
export * from './config';
// Named rather than `export *`: `timingSafeEqualString` is an implementation
// detail of the check, and putting a comparison helper of that name on the public
// surface invites it to be mistaken for node's Buffer-based `timingSafeEqual`,
// which this package uses elsewhere.
export { CSRF_HEADER, deriveCsrfToken, matchesCsrfToken } from './csrf';
export * from './oauth';
export * from './oauth2';
export * from './one-time-token';
export * from './deletion-config';
export * from './device-auth-config';
export * from './device-code';
