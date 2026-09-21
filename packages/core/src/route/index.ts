/**
 * @spfn/core - Route module exports
 */

// Route input types
export type { RouteInput } from './route-input';

// Context types
export type { RouteBuilderContext, MergedInput, PaginatedResult } from './context';

// Route builder
export { route } from './route-builder';
export type { RouteDef, RouteHandlerFn } from './route-builder';

// Route contract (public promise to separately deployed clients)
export type { RouteContract, RouteAuthProfile } from './contract';

// Router
export { defineRouter, defineUnmappedRouter } from './router';
export type { Router } from './router';

// Route registration
export { registerRoutes } from './register-routes';
export type { RegisteredRoute } from './register-routes';

// Middleware
export { defineMiddleware, defineMiddlewareFactory } from './define-middleware';
export type { ExtractMiddlewareNames, NamedMiddlewareFactory, NamedMiddleware } from './define-middleware';

// Types
export type { HttpMethod } from './types';

// Helpers
export { isHttpMethod, Nullable, OptionalNullable } from './helpers';

// File upload schemas
export {
    FileSchema,
    FileArraySchema,
    OptionalFileSchema,
    // Helpers
    isFileSchema,
    isFileArraySchema,
    getFileOptions,
    formatFileSize,
} from './file-schema';
export type {
    FileSchemaOptions,
    FileArraySchemaOptions,
    FileSchemaType,
    FileArraySchemaType,
} from './file-schema';
