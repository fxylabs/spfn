/**
 * @spfn/core - Middleware module exports
 */

export { ErrorHandler } from './error-handler';
export type { ErrorHandlerOptions, OnErrorContext } from './error-handler';
export { RequestLogger, maskSensitiveData } from './request-logger';
export type { RequestLoggerOptions, RequestLoggerConfig } from './request-logger';
export { createProxyGuard, createCacheNonceStore, createInMemoryNonceStore } from './proxy-guard';
export type { ProxyGuardConfig, ProxyGuardMode, ClientType, NonceStore } from './proxy-guard';
export {
    rateLimit, rateLimitPolicy, setRateLimitPolicies, getRateLimitPolicy,
    setRateLimitFailClosedDefault, resetMemoryRateLimitStore,
} from './rate-limit';
export type { RateLimitOptions, RateLimitDimension } from './rate-limit';
export { getClientIp, setTrustedProxyHops, parseTrustedProxyHops } from './client-ip';
export { CacheRateLimitStore, MemoryRateLimitStore } from './rate-limit-store';
export type { RateLimitStore, RateLimitHit } from './rate-limit-store';
