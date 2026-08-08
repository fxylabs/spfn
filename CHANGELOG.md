# Changelog

All notable changes to SPFN will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: For changelog history prior to v0.1.0-alpha.60, see [CHANGELOG-v0.0.x-alpha.md](./CHANGELOG-v0.0.x-alpha.md)

## [Unreleased]

### Changed

#### @spfn/core · spfn (CLI)

- **BREAKING: `.env.server.local` 폐지** — 서버 전용 환경변수를 `.env.server` 단일 파일로 통합. `.env.server`는 이제 gitignored(시크릿 포함)이며, committed 템플릿은 `.env.server.example`을 사용. 서버 시크릿을 `.env.server.local`에 두던 프로젝트는 `.env.server`로 이전해야 함(둘 다 gitignored).
  - `@spfn/core`: env loader가 server 레이어에서 `.env.server`만 로드(`.env.server.local` 제거). loader 로딩 규칙 단위 테스트 추가.
  - `spfn` (CLI): `create`/`init`이 `.env.server.local.example`을 생성하지 않고 `.gitignore`에 `.env.server`를 추가. `env:init` 및 런타임 로딩에서도 `.env.server.local` 제거.

### Fixed

#### @spfn/core

- **DB 없는 서버의 health가 더 이상 503을 답하지 않음** — `.infrastructure({ database: false })`로 끈 구성 요소를 health 상세 응답이 `disabled`로 보고하고 전체 상태를 낮추지 않는다. 그 전에는 의도적으로 없는 DB가 `not_initialized`로 실패에 세어져, DB를 쓰지 않는 서버의 readiness probe가 영영 통과하지 못했다. `redis`도 같다.
  - 응답 문자열이 바뀐다: 껐을 때 `not_initialized` → `disabled`. health 페이로드를 문자열로 판정하는 곳이 있으면 확인 필요.
- **내장 health 경로와 겹치는 앱 라우트를 부팅 시 경고** — 내장 health 엔드포인트는 앱 라우트보다 먼저 등록되므로 같은 경로의 앱 라우트는 실행되지 않는다. 이제 라우트 이름과 경로를 지목해 경고한다. 조용히 가려지는 탓에 examples 01·02·03이 실행되지 않는 `/health` 라우트를 배포하고 있었다(제거함).
- `ServerConfig.infrastructure`의 `@default true if DATABASE_URL exists` 주석이 실제 동작과 달랐다. 자격증명을 살피지 않고 항상 초기화하므로 DB를 쓰지 않는 서버는 `false`를 선언해야 한다(issue #119).

#### spfn (CLI)

- **스캐폴드가 만들던 `/health` 라우트 제거** — 내장 health 엔드포인트가 앱 라우트보다 먼저 등록되므로 이 라우트는 처음부터 실행된 적이 없었다. 새 앱은 이제 부팅 시 가려짐 경고 없이 뜨고, `GET /health`는 DB·Redis·마이그레이션 상태까지 담은 내장 응답이 답한다. Dockerfile의 HEALTHCHECK와 root 응답의 `/health` 안내는 그대로 유효하다.
- 스캐폴드 example 템플릿 결함 제거: `getExample`의 테스트용 헤더 강제 validation·디버그 로그, root 응답의 미등록 `/teams` 참조.
- `.gitignore`에 `.env.server`가 누락될 수 있던 분기 수정(독립 체크로 분리).
- type-check 미사용 심볼 정리(에러 0).
- **db 파괴 명령 안전 가드**: `drop`/`restore`가 대상 DB(name@host:port)를 표시하고, 원격/프로덕션 DB면 이름 재입력을 요구. `restore --drop`이 `--clean`에 `--if-exists`를 동반하고, plain SQL 경로에서 `--drop` 무시 시 경고. `db clean`이 `.meta.json` 사이드카도 함께 삭제.
- `init` 멱등성: 기존 RPC 프록시 라우트 발견 시 init 전체를 중단(`process.exit(1)`)하지 않고 skip.
- 스캐폴드 `Dockerfile`이 프로젝트의 패키지 매니저(npm/yarn/bun/pnpm)에 맞게 생성되도록 수정(기존 pnpm 하드코딩). base 이미지 node 20→22.
- `spfn start` both 모드가 `concurrently`를 `shell:true`·수동 따옴표 없이 호출하도록 수정(공백 포함 경로 대응).

### Removed

#### spfn (CLI)

- **BREAKING: `spfn generate` / `spfn g fn` 명령 제거** — 폐기된 contract-first 아키텍처(`createApp`/`createContract`/`createFunctionSchema`, 현행 core에서 제거됨)를 스캐폴드해 산출물이 컴파일 불가였음. 실제 `@spfn` 패키지는 route DSL을 사용하고 generate fn 구조(`lib/contracts`)를 쓰지 않음. 향후 필요 시 현행 패턴으로 신규 작성.
- 죽은 `.guide` 참조 제거: `create` 안내 메시지, `sync:guides` 스크립트, RELEASE 체크리스트 항목, stale 빌드 잔재(`copy-templates`에 `emptyDirSync` 추가로 재발 방지).
- generate 죽은 자산 제거: `generateInitMigration`+`init-migration.template`, `validation.ts`, 고아 `templates/config/`, 참조 없는 `Dockerfile.optimized`.

## [0.1.0-alpha.85] - 2025-11-07

### Added

#### @spfn/core

- **Plugin System**: New plugin discovery system for automatic package initialization
  - Auto-discovers `plugin.ts` files from `@spfn/*` packages in node_modules
  - `ServerPlugin` interface with lifecycle hooks (afterInfrastructure, beforeRoutes, afterRoutes, afterStart, beforeShutdown)
  - Plugins can automatically initialize services, mount routes, and hook into server lifecycle
  - Enables packages like `@spfn/auth` to self-configure without manual setup
  - See [API Reference - Server Plugins](/docs/api-reference/server.md#plugins)

## [@spfn/auth@0.1.0-alpha.1] - 2025-11-07

### Added

#### @spfn/auth

- **Invitation System**: New invitation-based user registration system
  - Create invitations with expiry dates and usage limits
  - Accept invitations to create accounts
  - List and manage invitations
  - Support for role assignment via invitations
  - See [Auth Package Documentation](/packages/auth/README.md#invitation-system)

- **Plugin System Support**: Package now exports plugin configuration
  - Auto-discovery of routes via SPFN plugin system
  - Automatic database schema registration
  - Configurable route prefix and base path

### Changed

#### @spfn/auth

- **Environment Variables**: Updated to use `SPFN_AUTH_*` prefix for better namespacing
  - `SPFN_AUTH_JWT_SECRET` (was `JWT_SECRET`)
  - `SPFN_AUTH_JWT_EXPIRES_IN` (was `JWT_EXPIRES_IN`)
  - `SPFN_AUTH_VERIFICATION_TOKEN_SECRET` (was `VERIFICATION_TOKEN_SECRET`)
  - `SPFN_AUTH_BCRYPT_SALT_ROUNDS` (was `BCRYPT_SALT_ROUNDS`)
  - `SPFN_AUTH_SESSION_SECRET` (was `SESSION_SECRET`)
  - `SPFN_AUTH_ADMIN_ACCOUNTS` (was `ADMIN_ACCOUNTS`)
  - Legacy variable names still supported for backward compatibility
  - See [Environment Variables Documentation](/packages/auth/README.md#which-environment-variables-do-i-need)

- **Routes Structure**: Reorganized routes into modular structure
  - `/auth/*` routes for authentication operations
  - `/invitations/*` routes for invitation management
  - Better separation of concerns and maintainability

## [0.1.0-alpha.84] - 2025-11-06

### Added

#### spfn (CLI)

- **Database Sync Command**: New `spfn db sync` command for environment synchronization
  - Sync databases between local and remote environments (dev, staging, production)
  - Automatic backup of target database before sync (mandatory, cannot be skipped)
  - Production protection requiring explicit `--force` flag for safety
  - Table filtering support with `--tables` and `--exclude-tables` options
  - Bidirectional sync with `--pull` flag (reverse direction)
  - Dry-run mode with `--dry-run` for previewing changes
  - Environment configuration via `SPFN_DB_*` environment variables
  - Full replacement strategy for predictable results
  - See [CLI Reference - Database Sync](/docs/api-reference/cli.md#spfn-db-sync)

#### @spfn/core

- **Event System**: New event-driven architecture with type-safe event emitter
  - Memory adapter for lightweight in-process events
  - Type-safe event definitions with TypeScript generics
  - Support for async event handlers with automatic error handling
  - `waitFor()` method for promise-based event waiting
  - `once()` method for one-time event handlers
  - Automatic cleanup and memory management
  - Foundation for future distributed event adapters (Redis, NATS)
  - See [API Reference - Events](/docs/api-reference/events.md)

## [0.1.0-alpha.83] - 2025-11-06

### Added

#### @spfn/core

- **Server Lifecycle Hooks**: New comprehensive lifecycle hook system for server initialization and shutdown
  - `lifecycle.beforeInfrastructure`: Execute before database and Redis initialization
  - `lifecycle.afterInfrastructure`: Execute after infrastructure is ready
  - `lifecycle.beforeRoutes`: Execute before routes are registered (moved from top-level)
  - `lifecycle.afterRoutes`: Execute after routes are registered (moved from top-level)
  - `lifecycle.afterStart`: Execute after server starts listening
  - `lifecycle.beforeShutdown`: Execute before graceful shutdown
  - All hooks properly integrated with server startup sequence
  - See [API Reference - Server Lifecycle](/docs/api-reference/app.md#lifecycle-hooks)

- **Infrastructure Control**: New configuration options for database and Redis initialization
  - `infrastructure.database`: Control automatic database initialization (default: true)
  - `infrastructure.redis`: Control automatic Redis initialization (default: true)
  - Useful for custom infrastructure setup in lifecycle hooks
  - See [API Reference - Infrastructure Control](/docs/api-reference/app.md#infrastructure-control)

- **Logger API Documentation**: Comprehensive documentation for the logger module
  - Complete API reference with all methods and types
  - Configuration guide for environment variables
  - Transport configuration (Console, File)
  - Sensitive data masking documentation
  - Best practices and troubleshooting guide
  - See [API Reference - Logger](/docs/api-reference/logger.md)

### Changed

#### @spfn/core

- **Logger Architecture Refactored**: Simplified from adapter-based to transport-only architecture
  - Removed adapter layer (`adapter-factory.ts`, `adapters/` directory)
  - Simplified to direct logger → transport flow
  - Removed pino and pino-pretty dependencies (344 dependencies reduced)
  - Created new `factory.ts` for transport-based initialization
  - Bundle size reduced by 17% for logger module, 4% for core package
  - All 153 logger tests passing

- **Lifecycle Hooks Consolidated**: `beforeRoutes` and `afterRoutes` moved into `lifecycle` object
  - **Breaking Change**: Top-level `beforeRoutes` and `afterRoutes` are now deprecated
  - Use `lifecycle.beforeRoutes` and `lifecycle.afterRoutes` instead
  - Updated `create-server.ts` to reference new paths
  - More consistent API design with all lifecycle hooks in one place

### Fixed

#### @spfn/core

- **Memory Leak Warnings**: Resolved MaxListenersExceeded warnings in development
  - Added `process.setMaxListeners(15)` in shutdown handler registration
  - Prevents warnings when using hot reload with tsx --watch
  - Handles multiple process event listeners properly

- **Thread-Stream Module Resolution**: Fixed persistent module resolution errors
  - Removed pino-pretty to eliminate worker thread issues with tsx --watch
  - Custom logger now uses built-in ANSI color codes
  - Cleaner development experience without module resolution errors

## [0.1.0-alpha.82] - 2025-11-05

### Added

#### spfn (CLI)

- **Database Backup System Enhancements**: Major improvements to backup/restore functionality
  - **Backup Metadata Tracking**: Automatically collects and saves metadata for each backup
    - Git information (commit hash, branch, tag, dirty status)
    - Migration version (last applied migration, count, hash)
    - Environment labels and custom tags
    - Metadata saved as `.meta.json` files alongside backups
  - **Selective Backup Options**: New flags for granular backup control
    - `--data-only`: Backup data without schema
    - `--schema-only`: Backup schema without data
    - `--tag <tags>`: Add comma-separated tags to backups
    - `--env <environment>`: Label backup environment (production, staging, etc.)
  - **Version Compatibility Warnings**: Restore command now displays metadata and warnings
    - Shows backup database, creation date, environment, and tags
    - Detects Git commit/branch mismatches between backup and current state
    - Warns about migration version differences before restore
    - Helps prevent accidental data loss from incompatible backups
  - **Auto-Backup on Migrate**: New `--with-backup` flag for `spfn db migrate`
    - Automatically creates pre-migration backup before applying migrations
    - Uses compressed custom format for smaller file size
    - Tagged as "pre-migration" for easy identification
  - **Enhanced Security**: Backup commands now auto-update `.gitignore`
    - Adds `backups/` to project root `.gitignore`
    - Adds `*.meta.json` to `backups/.gitignore`
    - Prevents accidental commits of sensitive backup files

#### @spfn/core

- **Types Package**: New `@spfn/core/types` export for pure type definitions
  - Extracted API response types and schemas to dedicated types package
  - Includes `ErrorResponse`, `ApiSuccessResponse`, `ApiErrorResponse`, `ApiResponse`
  - Includes TypeBox schema helpers: `ApiSuccessSchema`, `ApiErrorSchema`, `ApiResponseSchema`
  - Safe to use in both server and client code
  - Better tree-shaking potential

### Changed

#### @spfn/core

- **API Response Types Refactoring**: Reorganized type definitions for better modularity
  - Moved API response types from `route/api-response.ts` to `types/api-response.ts`
  - Updated error-handler to import `ErrorResponse` from `@spfn/core/types`
  - Deprecated `route/api-response.ts` (re-exports from types for backwards compatibility)
  - Added `pino-pretty` as optional dependency for improved logging

### Fixed

#### spfn (CLI)

- **Backup Options Validation**: Added validation to prevent conflicting options
  - Backup and restore commands now reject `--data-only` and `--schema-only` used together
  - Clear error messages guide users to correct usage

## [0.1.0-alpha.81] - 2025-11-05

### Fixed

#### @spfn/core

- **Code Generation**: Removed `.js` extension from generated TypeScript import paths in contract client
  - Changed type export paths from `./${kebabName}.js` to `./${kebabName}`
  - Changed function import paths from `./${kebabName}.js` to `./${kebabName}`
  - Improves compatibility with TypeScript module resolution

## [0.1.0-alpha.80] - 2025-11-04

### Changed

#### @spfn/cms

- **API Route Parameter Naming**: Standardized route parameters to follow RESTful conventions
  - Changed route parameter from `:labelId` to `:id` in all label detail endpoints
  - Updated paths: `/_cms/labels/:id/publish`, `/_cms/labels/:id/admin`, `/_cms/labels/:id/versions`
  - Updated all contracts to use `id` instead of `labelId` in params
  - Reorganized route files from `labels/[labelId]/` to `labels/[id]/` directory structure

- **Labels List API Simplification**: Removed pagination from labels list endpoint
  - Removed `limit` and `offset` query parameters from `getLabelsContract`
  - Removed `limit` and `offset` fields from response
  - Returns all labels without pagination for simpler client implementation

### Fixed

#### @spfn/cms

- **Test Organization**: Split monolithic test file into separate test files by feature
  - Created `labels-admin.test.ts` for admin endpoint tests
  - Created `labels-publish.test.ts` for publish workflow tests
  - Created `labels-versions.test.ts` for version history tests
  - Improved test maintainability and discoverability

## [0.1.0-alpha.79] - 2025-11-04

### Changed

#### @spfn/cms

- **Locale Naming Improvements**: Clarified naming distinction between project locales and system locales
  - Renamed `CmsConfig.supportedLocales` to `CmsConfig.locales` (kept deprecated `supportedLocales` for backward compatibility)
  - Added `getAllLocales()` function to get system-available locales (50+ supported languages)
  - Deprecated `getSupportedLocales()` in favor of `getAllLocales()`
  - Updated `configureCms()` to accept both `locales` and `supportedLocales` parameters with automatic synchronization
  - Updated all internal usages from `config.supportedLocales` to `config.locales`
  - **New naming convention**: `configureCms({ locales: ['en', 'ko'] })` for project-active locales, `getAllLocales()` for system-available locales

### Fixed

#### @spfn/cms

- **Label Type Sync Bug**: Fixed label type field not being preserved during sync operations
  - Fixed `flattenLabels()` in `helpers.ts` to include `type` field in flattened results
  - Fixed `syncSection()` in `sync.ts` to update `type` field in database
  - Fixed change detection to recognize type changes (e.g., text → image)
  - Label types (text, image, video, file, object) now correctly synced from JSON to database

## [0.1.0-alpha.78] - 2025-11-03

### Fixed

#### @spfn/cms

- **Translation Function Object Support**: Fixed `t()` function to handle object-type label values
  - Added automatic `content` field extraction from object values (e.g., `{ type: "text", content: "..." }`)
  - Applied to both `getSection()` and `getSections()` functions
  - Now correctly renders labels that have structured object values instead of plain strings
  - Enables CMS to support rich label metadata while maintaining simple `t()` API

## [0.1.0-alpha.77] - 2025-11-03

### Fixed

#### @spfn/cms

- **Label Version History API**: Fixed to query from `cms_label_values` table directly
  - Changed from `cms_label_versions` (unused table) to `cms_label_values`
  - Queries published versions where `version IS NOT NULL`
  - Returns version history with values grouped by version number
  - Note: `publishedBy` and `notes` fields are null (not stored in label_values table)

## [0.1.0-alpha.76] - 2025-11-03

### Added

#### @spfn/cms

- **Label Version History API**: Added new API endpoint to fetch complete version history for labels
  - New contract: `getLabelVersionsContract` (GET /_cms/labels/:labelId/versions)
  - New route handler: `/labels/[labelId]/versions/index.ts` with DB query optimization
  - Auto-generated API client function: `getLabelVersions()`
  - Returns all published versions with metadata (publishedAt, publishedBy, notes) and values
  - Optimized single API call replaces multiple sequential calls for better performance
  - Version history sorted by version number (descending - newest first)

## [0.1.0-alpha.75] - 2025-11-03

### Added

#### @spfn/cms

- **Label Description Field**: Added `description` field support throughout CMS system
  - Added `description` column to `cms_labels` entity (nullable text field)
  - Updated all API contracts to include `description` field in responses
  - Updated all route handlers to return `description` field
  - Admin UI now displays label descriptions in label list and editor header
  - Descriptions shown below label keys for better context and usability

### Fixed

#### @spfn/cms

- Fixed TypeScript build errors related to missing `description` field in API responses
- Ensured consistent `description` field presence across all label-related endpoints

## [0.1.0-alpha.74] - 2025-11-03

### Added

#### @spfn/cms

- **Draft & Publish System (Phase 1)**: Implemented complete publish workflow for CMS labels
  - New contracts: `publishLabelContract` (POST /_cms/labels/:labelId/publish), `getAdminLabelContract` (GET /_cms/labels/:labelId/admin)
  - New helper functions: `publishLabel()` - converts Draft (version=null) to Published (version=number), `updatePublishedCache()` - regenerates cache for all locales
  - New API endpoints with full error handling and validation
  - Repository extension: `findDraftsByLabelId()` for querying draft values
  - Auto-generated API client functions: `publishLabel()`, `getAdminLabel()`
  - Status calculation: 'default-only', 'unpublished', 'published', 'modified'
  - Published cache regeneration with defaultValue fallback support

#### @spfn/core

- **Contract Scanner Logging**: Added debug logging to contract scanner for troubleshooting
  - New logger: `scannerLogger` with detailed contract extraction logs
  - Logs: contract file discovery, extraction progress, final mapping count
  - Helps diagnose codegen issues and contract detection problems

## [0.1.0-alpha.73] - 2025-11-03

### Fixed

#### @spfn/cms

- **ESM Import Compatibility**: Fixed missing `.js` extension in `next/headers` import in `locale.actions.ts`
  - Changed `import { cookies, headers } from 'next/headers'` to `import { cookies, headers } from 'next/headers.js'`
  - Ensures proper ESM module resolution in production builds

## [0.1.0-alpha.72] - 2025-11-03

### Added

#### @spfn/auth

- **Custom Error Classes**: Added comprehensive error handling system in `server/errors/auth-errors.ts`
  - New errors: `InvalidCredentials`, `AccountDisabled`, `AccountAlreadyExists`, `InvalidVerificationCode`, `InvalidToken`, `TokenExpired`, `KeyExpired`, etc.
  - Migrated from manual JSON responses to throwing typed errors

- **Email/SMS Verification System**: Implemented complete verification code flow
  - Added `verification_codes` entity and helper functions
  - New endpoints: `POST /_auth/codes` (send code), `POST /_auth/codes/verify` (verify code)
  - Verification tokens with 15-minute validity for registration flow
  - Support for registration, password reset, and email/phone change purposes

- **Auth Context Helpers**: Created type-safe context access system
  - New `AuthContext` interface grouping user, userId, keyId
  - Extended Hono's `ContextVariableMap` for type-safe context
  - Helper functions: `getAuth()`, `getUser()`, `getUserId()`, `getKeyId()`
  - Updated all routes to use type-safe helpers

- **Generated API Client**: Auto-generated type-safe client functions in `lib/api/`
  - Functions: `authExists()`, `authLogin()`, `authRegister()`, `authCodesVerify()`, etc.
  - Automatic contract-to-function conversion with proper naming

- **Integration Tests**: Added comprehensive test coverage
  - New integration tests for authenticate middleware (390 lines)
  - New unit tests for verification system (250 lines)

#### @spfn/cms

- **Draft System**: Implemented draft/published version system
  - `version: null` for drafts (mutable)
  - `version: number` for published versions (immutable)
  - Database migration 0002: Made version column nullable
  - Drafts can be overwritten, published versions are immutable

#### @spfn/core

- **Enhanced Error Handling**: Added new HTTP error classes
  - Better error serialization and HTTP status mapping
  - Integration with auth error system

- **API Response Helpers**: Added `c.success()` and `c.error()` helpers to RouteContext
  - Simplified error handling in route handlers
  - Better integration with error throwing pattern

- **Route Binding**: New `bind.ts` module with route binding utilities

### Changed

#### @spfn/auth

- **Registration Flow**: Now requires verification token from code verification
  - New flow: send code → verify code → register with token
  - Enhanced security with verification step

- **Authentication Middleware**: Refactored to use error throwing instead of response objects
  - Better separation of concerns
  - Improved error messages and types
  - Fire-and-forget `lastUsedAt` updates

- **API Response Format**: Simplified response types (removed wrapper objects)
  - Direct data returns instead of nested `data` wrapper for success responses

#### @spfn/cms

- **Entity Schema**: `cms_label_values.version` is now nullable
- **Contract**: `saveValuesContract` accepts `version: null | number`
- **Repository**: `upsert()` handles null version with draft/publish logic
- **Store**: Fixed API call from `cmsPublishedCache.get()` to `getPublishedCache()`

#### @spfn/core

- **API Response Module**: Simplified `route/api-response.ts` (210 lines removed)
- **Code Generator**: Improved contract-to-client generation in `codegen/built-in/contract/emitter.ts`
  - Better function naming (e.g., POST /api/auth/login → `authLogin()`)
  - Improved type generation for API clients

### Breaking Changes

#### @spfn/auth

- Registration endpoint now requires `verificationToken` parameter
- API response format changed (no more nested `data` wrapper for success)
- Auth context access changed from `c.raw.get('user')` to `getUser(c)`

## [0.1.0-alpha.69] - 2025-11-02

### Added

#### @spfn/cms

- **Labels API - Default Values Support**: Added `includeDefaultValues` query parameter to `GET /_cms/labels`
  - Returns `defaultValue` field from label definition JSON files
  - Enables admin UIs to show default values when no content is saved
  - Automatically loads and merges default values from `src/cms/labels/{section}/*.json`

- **Published Cache Upsert Endpoint**: Added `POST /_cms/published-cache` endpoint
  - Create or update published content cache
  - Request body: `{ section, locale, content, version }`
  - Returns updated cache with `publishedAt` timestamp
  - Enables programmatic cache updates after publishing labels

### Changed

#### @spfn/cms

- **Labels Contract**: Updated `getLabelsContract` response schema to include optional `defaultValue` field

## [0.1.0-alpha.68] - 2025-11-02

### Changed

#### @spfn/core

- **Codegen Folder Structure Refactoring**: Reorganized codegen module for better clarity and extensibility
  - Created `core/` directory for system files (orchestrator, generator interface, config loader, types)
  - Created `built-in/` directory for built-in generators
  - Moved contract generator to `built-in/contract/`
  - Renamed files for clarity:
    - `client-generator.ts` → `emitter.ts` (code generation)
    - `contract-scanner.ts` → `scanner.ts`
    - `route-scanner.ts` → `helpers.ts` (resource grouping utilities)
  - Prepared structure for future built-in generators (e.g., auth, migrations)
  - Updated all import paths to reflect new structure

## [0.1.0-alpha.67] - 2025-11-02

### Changed

#### @spfn/cms

- **Contract Path Prefixing**: All CMS contract paths now explicitly include `/_cms` prefix
  - `GET /labels` → `GET /_cms/labels`
  - `GET /labels/:id` → `GET /_cms/labels/:id`
  - `POST /values/:labelId` → `POST /_cms/values/:labelId`
  - `GET /values/:labelId/:version` → `GET /_cms/values/:labelId/:version`
  - `GET /published-cache` → `GET /_cms/published-cache`
  - Ensures contract paths match the actual route mounting point

#### @spfn/core

- **Prefix Validation for External Routes**: Auto-loader now validates contract paths against package prefix
  - When `loadExternalRoutes()` is called with a prefix parameter, contract paths must start with that prefix
  - Errors with clear hints if prefix is missing (e.g., "Contract paths should start with '/auth'. Example: path: '/auth/login'")
  - Prevents mismatch between backend route mounting and client API calls
  - Existing routes without prefix will fail validation until contracts are updated

### Fixed

#### @spfn/core

- **Auto-loader Tests**: Updated external routes tests to reflect new prefix validation behavior
  - Test contract paths now include required prefix
  - Added test case for prefix validation error scenario

## [0.1.0-alpha.66] - 2025-11-02

### Fixed

#### @spfn/cms

- **Server Actions Bundling**: Fixed "use server" directive bundling issue
  - Removed Server Actions exports from `server.ts` to prevent Turbopack build errors
  - Server Actions (`getLocale`, `setLocale`, etc.) now only exported from `actions.ts`
  - `server.ts` now only exports constants and server components
  - Resolves "Server Actions must be async functions" error in Next.js 15 with Turbopack

## [0.1.0-alpha.65] - 2025-11-02

### Added

#### @spfn/core

- **API Response Helpers**: Optional standardized response utilities
  - `success()`, `error()`, `paginated()` helper functions
  - `ApiSuccessResponse<T>`, `ApiErrorResponse`, `ApiResponse<T>` types
  - TypeBox schema helpers: `ApiSuccessSchema()`, `ApiErrorSchema()`, `ApiResponseSchema()`
  - Completely optional - use when desired for consistency

- **Route Module Enhancements**:
  - Prefix support for external package routes (e.g., `/auth`, `/cms`)
  - `loadExternalRoutes()` accepts prefix parameter for mounting
  - Default ErrorHandler now registered in all SPFN apps
  - Automatic mounting with package.json `spfn.prefix` field

- **Schema Module**: 6 new helper functions for common patterns
  - New utilities for schema composition and validation
  - Enhanced type-safe schema operations

- **Codegen Improvements**:
  - Scope-based API naming to avoid conflicts (e.g., `cmsApi`, `authApi`)
  - Package prefix support from package.json
  - `runOn` option to control when generators execute: 'watch' | 'manual' | 'build' | 'start'
  - Improved module generation with better defaults

- **Build Configuration**:
  - Submodule exports for better tree-shaking
  - Coverage configuration for testing

#### @spfn/cms

- Codegen-based API client generation
  - Auto-generated type-safe API clients via `@spfn/core:contract`
  - Generated API structure: CmsLabels, CmsLabelsByKey, CmsPublishedCache, CmsValues
  - All types auto-generated from contracts using InferContract

#### spfn CLI

- **Module Generation Enhancements**:
  - Scope selection when generating new modules (@spfn, @mycompany, etc.)
  - Comprehensive development guide in generated README
  - Example custom generator in new modules
  - Helper scripts (codegen, test, docker) in generated packages
  - 3-layer architecture templates (lib/, server/, client/)

### Changed

#### @spfn/core

- **Error Handling**:
  - Renamed `ValidationError` to `ConstraintViolationError` for clarity
  - Added HTTP `ValidationError` for request validation errors
  - Updated ErrorResponse to include `success: false` field

- **Cache Module**: Migrated from Redis to Valkey/Cache with graceful degradation
  - Support for Valkey (Redis fork)
  - Graceful fallback when cache is unavailable
  - Improved error handling

- **Codegen Architecture**:
  - Reorganized folder structure:
    - Created `scanners/` directory for contract and route scanners
    - Created `generators/contract/` directory
    - Improved imports (removed `.js` extensions)
  - Improved generator architecture with runOn and trigger pattern
  - Better separation of concerns

- **Middleware Module**: Export ErrorResponse type for better type safety

#### Package Structure

- **3-Layer Architecture**: Restructured cms, auth, and cli packages
  - `lib/`: Shared code (contracts, types, constants)
  - `server/`: Server-only code (entities, routes, repositories)
  - `client/`: Client-only code (hooks, store, components)
  - Updated all import paths and build configurations

### Fixed

#### @spfn/core

- TypeScript build errors across multiple modules
- watch-generate imports after folder restructure
- Logger test failures
- Server TypeScript type errors (MockInstance vs SpyInstance)
- Graceful skip for integration tests without PostgreSQL

### Testing

#### @spfn/core

- **Route Module**:
  - Updated auto-loader tests for contract-based routing
  - Added function-routes discovery tests
  - Enhanced bind and create-app test coverage

- **Middleware Module**:
  - Added 20 new maskSensitiveData tests
  - Comprehensive coverage of edge cases and circular references

- **Server Module**:
  - Added comprehensive helper and banner tests
  - Updated documentation with test coverage

- **Database Module**:
  - Added comprehensive tests for utility modules
  - Comprehensive test suite with improved type system
  - Reorganized transaction tests with 100% coverage

- **Codegen Module**:
  - Improved test coverage to 85.68% (47 → 61 tests)
  - Added 14 new tests across all subsystems

### Documentation

#### Core Concepts

- Added comprehensive framework documentation
- Updated db module documentation with schema and testing info
- Added comprehensive README for schema module

#### Modules

- **Route Module**: Added API Response helpers section with examples
- **Errors Module**: Added comprehensive test coverage section
- **Env Module**: Added comprehensive README documentation
- **Codegen Module**:
  - Updated documentation for new architecture
  - Added comprehensive custom generators guide

#### Philosophy & Architecture

- Added comprehensive philosophy documentation
  - Rails-inspired principles (Convention over Config, DRY, Omakase)
  - 7 core principles: Single Source of Truth, Proven Over Novel, Type Safety First
  - Design decisions: Why File-Based Routing, Why Contract-First, Why Single Project
  - What Superfunction Is Not section
- Renamed architecture/ → philosophy/ folder
- Improved deployment options documentation
  - Option 1: All-in-one deployment (recommended)
  - Option 2: Split deployment (Vercel + separate server)

#### Ecosystem

- Added module creation documentation
  - 8-step development workflow with code examples
  - Configuration options and API name generation
  - Custom generator examples and best practices
  - Publishing guide and troubleshooting section

## [0.1.0-alpha.64] - 2025-11-01

### Changed

#### @spfn/core

- **Codegen Architecture Simplification**:
  - **Removed legacy routes/ directory scanning**: Now only scans `lib/contracts/` directory
  - **Removed single file output mode**: Split-by-resource is now the only output mode
  - **Removed legacy generator naming**: Only `package:name` format supported (e.g., `@spfn/core:contract`)
  - **Simplified contract scanner**: Cleaner implementation with reduced complexity
  - **Updated all tests**: All 32 codegen tests updated to match new architecture

- **Breaking Changes**:
  - Contract files must be in `src/lib/contracts/` directory (no longer supports `src/routes/`)
  - Generator configuration must use `@spfn/core:contract` format (legacy `contract` name removed)
  - API client always outputs to directory structure (single file mode removed)

## [0.1.0-alpha.63] - 2025-11-01

### Enhanced

#### @spfn/core

- **API Client Generation Improvements**:
  - **Type Reuse**: API method signatures now reuse generated types instead of repeating `InferContract<typeof ...>` expressions
    - Before: `list: (options: { query?: InferContract<typeof getTeamsContract>['query'] }) => ...`
    - After: `list: (options: { query?: GetTeamsQuery }) => ...`
    - Improves code readability and maintainability

  - **Resource-Based File Splitting** (Default enabled):
    - API client now splits into separate files per resource: `src/lib/api/` directory structure
    - Before: Single `api.ts` file with all endpoints
    - After: Individual files (teams.ts, users.ts, etc.) + unified `index.ts`
    - Benefits:
      - ✅ File size stays manageable as your API grows
      - ✅ Types and APIs are co-located by resource
      - ✅ Better tree-shaking for optimal bundle size
      - ✅ Team members can work on different resources in parallel
    - Configuration: `splitByResource` option (default: `true`)
    - Legacy single-file mode still available with `splitByResource: false`

- **Documentation Updates**:
  - Updated codegen README with detailed split mode documentation
  - Added output mode comparison (split vs single file)
  - Added type reuse examples
  - Updated main README to reflect new API structure
  - Updated official documentation site

## [0.1.0-alpha.62] - 2025-10-30

### Fixed

#### @spfn/core

- **ESM File Extension Support**: Fixed comprehensive .mjs extension support across all file scanners
  - `contract-scanner.ts` now scans `.js` and `.mjs` files in lib/contracts/ directory (line 88-97)
  - `contract-scanner.ts` now removes all extensions (.ts, .js, .mjs) when generating import paths (line 401-412)
  - `config-generator.ts` now filters out `index.mjs` files from schema discovery (line 209-215)
  - Resolves codegen failures in production mode where built contract files (.mjs) were not being scanned
  - Ensures consistent file extension handling across all auto-discovery systems

## [0.1.0-alpha.61] - 2025-10-30

### Fixed

#### @spfn/core

- **ESM Config Loading**: Fixed server.config loading to support .mjs extension
  - `startServer()` now checks for `.spfn/server/server.config.mjs` before falling back to `.js`
  - Resolves "Unknown file extension .ts" error in production mode
  - Build output from tsup generates .mjs files which are now properly loaded

## [0.1.0-alpha.60] - 2025-10-29

### Breaking Changes

This is a major architectural update with several breaking changes. Upgrading from previous versions will require code modifications.

#### @spfn/core

- **Contract-based Architecture**: Complete migration from file-based routing to contract-based routing
  - ❌ **Removed**: `basePath` concept - contracts now define absolute paths directly
  - ❌ **Removed**: File-based path inference - routes no longer determine URLs from file structure
  - ✅ **Required**: All contracts must now be centralized in `src/lib/contracts/` directory
  - ✅ **Required**: Route handlers must import contracts using absolute paths (e.g., `@/lib/contracts/users`)
  - See [Migration Guide](#migration-guide-alpha60) below

- **Function Routes System Redesign**: External package routes now loaded directly without basePath
  - ❌ **Removed**: `loadWithBasePath()` method from auto-loader
  - ✅ **Added**: `loadExternalRoutes()` method for direct mounting
  - Function packages (e.g., `@spfn/cms`) now use absolute paths in contracts
  - Routes from function packages mount directly to main app (e.g., `/cms/labels`)

- **Strict Route File Convention**: Only `index.ts` and `index.js` files are recognized as route handlers
  - Prevents accidental loading of utility files, helpers, types, etc.
  - Route files must be named exactly `index.ts` or `index.js`
  - Example: `routes/users.ts` ❌ → `routes/users/index.ts` ✅

#### spfn (CLI)

- **@/ Alias Support**: Next.js-style import paths now supported in server code
  - Templates now use `@/lib/contracts/` instead of relative paths
  - `src/server/tsconfig.json` configured with baseUrl and paths mapping
  - `src/server/tsup.config.ts` includes esbuild alias configuration
  - Automatic tsup dependency installation added to `spfn init`

- **spfn add Command**: One-command installation for SPFN ecosystem packages
  - Automatically installs package and applies pre-generated migrations
  - No file copying - migrations execute directly from node_modules
  - Displays package-specific setup guide after installation
  - Example: `pnpm spfn add @spfn/cms`

- **Function Package Migrations**: Pre-generated migrations bundled with npm packages
  - Migrations included in package distribution (`files: ["dist", "migrations"]`)
  - `spfn.migrations.dir` field in package.json specifies migration location
  - Automatic schema creation (e.g., `CREATE SCHEMA IF NOT EXISTS spfn_cms`)
  - `spfn db push` and `spfn db migrate` automatically apply function migrations

#### @spfn/cms

- **tsup Build System**: Migrated from custom build to tsup bundler
  - Automatic ES module bundling with proper dependency handling
  - `@/` alias support in source code
  - Smaller bundle size with tree-shaking
  - Removed `.js` extensions from imports (tsup handles automatically)

- **Pre-generated Migrations**: Database migrations now bundled with package
  - Migrations generated during build: `npm run db:generate`
  - Post-generate script adds `CREATE SCHEMA IF NOT EXISTS spfn_cms`
  - Migrations included in npm package distribution
  - No migration file copying required on installation

### Added

#### @spfn/core

- **@/ Alias Resolution**: Added built-in support for Next.js-style import paths
  - Configure via `baseUrl` and `paths` in tsconfig.json
  - Works with both development (tsx) and production (built files)
  - Example: `import { userContract } from '@/lib/contracts/users'`

#### spfn (CLI)

- **Template Updates**: All templates now use modern import patterns
  - Routes use `@/lib/contracts/` imports
  - No `.js` extensions in source code
  - Clean, Next.js-familiar developer experience
  - `tsconfig.json` and `tsup.config.ts` included in templates

#### @spfn/cms

- **Optimized Bundle**: Smaller package size with better performance
  - Production-ready ES modules
  - Proper tree-shaking support
  - No runtime bundling required

### Fixed

#### spfn (CLI)

- **Template Configuration**: Added missing tsup dependency to package.json
  - Prevents "tsup not found" errors in fresh projects
  - Automatic installation via `spfn init`

### Migration Guide (alpha.60)

<details>
<summary>Click to expand migration guide</summary>

#### 1. Move Contracts to Centralized Location

**Before (alpha.56):**
```
src/server/routes/
  users/
    contract.ts          # ❌ Co-located contract
    index.ts            # Route handler
```

**After (alpha.60):**
```
src/lib/contracts/
  users.ts              # ✅ Centralized contract

src/server/routes/
  users/
    index.ts            # Route handler (imports from @/lib/contracts/users)
```

#### 2. Update Contract Paths

**Before:**
```typescript
// Contract defined absolute path
export const getUsersContract = {
  method: 'GET',
  path: '/users',  // ✅ Already absolute
} as const satisfies RouteContract;
```

**After:** (Same - contracts already used absolute paths!)
```typescript
// No changes needed for contract paths
export const getUsersContract = {
  method: 'GET',
  path: '/users',  // ✅ Still absolute
} as const satisfies RouteContract;
```

#### 3. Update Route Imports to Use @/ Alias

**Before:**
```typescript
import { getUsersContract } from './contract.js';
// or
import { getUsersContract } from '../../../lib/contracts/users.js';
```

**After:**
```typescript
import { getUsersContract } from '@/lib/contracts/users';
```

#### 4. Rename Non-Index Route Files

**Before:**
```
routes/
  users.ts              # ❌ Not recognized
  teams.ts              # ❌ Not recognized
```

**After:**
```
routes/
  users/
    index.ts            # ✅ Recognized
  teams/
    index.ts            # ✅ Recognized
```

#### 5. Update tsconfig.json and Add tsup.config.ts

**Add to src/server/tsconfig.json:**
```json
{
  "compilerOptions": {
    "baseUrl": "../..",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

**Add src/server/tsup.config.ts:**
```typescript
import { defineConfig } from 'tsup';
import path from 'path';

export default defineConfig({
    entry: {
        'routes/index': './routes/index.ts',
        'entities/index': './entities/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: false,
    target: 'es2022',
    outDir: '../../.spfn/server',
    splitting: false,
    esbuildOptions(options) {
        options.alias = {
            '@': path.resolve(__dirname, '../../src'),
        };
    },
});
```

#### 6. Install tsup Dependency

```bash
pnpm add -D tsup
```

#### 7. Update Function Package Imports (if using @spfn/cms)

**Before:**
```bash
pnpm add @spfn/cms
pnpm spfn db push
```

**After:** (Simpler!)
```bash
pnpm spfn add @spfn/cms  # One command does everything!
```

</details>

---

## Version History

- [0.1.0-alpha.60] - 2025-10-29 - Contract-based architecture, @/ alias support, spfn add command
- For older versions, see [CHANGELOG-v0.0.x-alpha.md](./CHANGELOG-v0.0.x-alpha.md)