# Changelog

> **Not maintained after 0.1.0-alpha.88.** Changes to the `spfn` CLI from 0.3.0 on are
> recorded in the repository's [CHANGELOG.md](../../CHANGELOG.md), under `spfn (CLI)`. This
> file is kept for the alpha history below.

## [0.1.0-alpha.88] - 2025-11-10

### Changed

- **Dependency Version Unification**: Unified dependency versions across all packages
  - `drizzle-kit`: Updated to ^0.31.6 (from ^0.31.5)
  - `tsup`: Updated to ^8.5.0 (from ^8.0.0 - ^8.3.5)
  - `tsx`: Updated to ^4.20.6 (from ^4.19.2)
  - `chalk`: Updated to ^5.6.2 (from ^5.3.0)
  - `typescript`: Standardized to ^5.3.3 (from mixed versions)
  - All packages now use consistent build tool versions for better compatibility

## [0.1.0-alpha.51] - 2025-10-23

### Added

- **Upsert Helper Function**: Added `upsert` helper to database utilities
  - Supports INSERT or UPDATE on conflict (PostgreSQL UPSERT)
  - `target` parameter specifies UNIQUE constraint columns for conflict detection
  - `set` parameter allows custom update values including SQL expressions
  - Automatically handles transaction context and database selection
  - Example: `upsert(table, data, { target: [col1, col2], set: { field: sql\`expr\` } })`

## [0.1.0-alpha.50] - 2025-10-23

### Fixed

- **Database Helper Type Safety**: Updated helper functions to accept `SQL | undefined`
  - `findOne`, `findMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, and `count` now properly handle Drizzle's `and()` return type
  - Removed need for non-null assertions (`!`) when using `and()` with helper functions
  - Improved type safety by gracefully handling undefined SQL conditions
  - Function overloads ensure proper type inference for both object-based and SQL-based where clauses

## [0.1.0-alpha.49] - 2025-10-23

### Added

- **Enhanced Contract Guide**: Updated `spfn guide contract` with Union response patterns
  - Added `Type.Union()` for handling multiple response types (success vs error)
  - Added `Type.Integer()` for auto-converting URL params from string to number
  - Example code showing error response handling with Union types

### Changed

- **Template Improvements**: Updated example contract template
  - All contracts now use `as const satisfies RouteContract` for type safety
  - `getExampleContract` demonstrates Union response pattern with error handling
  - Path parameters use `Type.Integer()` for automatic conversion
  - Added inline comments explaining best practices

### Documentation

- **route/README.md**: Added "Multiple Response Types with Union" section
  - Complete example of Union response pattern
  - Benefits explanation (type-safe errors, self-documenting, auto-generated client)
  - Note about `Type.Integer()` for path/query params

## [0.1.0-alpha.48] - 2025-10-23

### Added

- **Guide Command**: New `spfn guide` command for quick development references
  - `spfn guide entity` - Entity & Repository patterns with Drizzle ORM
  - `spfn guide contract` - Contract writing quick reference with TypeBox
  - `spfn guide route` - Route patterns and file-based routing
  - `spfn guide api` - Auto-generated API client usage guide
  - Beautiful terminal output with syntax highlighting

## [Unreleased]

### Added

- **Multi-Region Deployment Support**
  - Added `region` field to deployment configuration (optional, defaults to 'us')
  - Region-specific domain generation: `{subdomain}.{region}.spfn.app`
  - Available regions:
    - `'us'`: Virginia, USA (default)
    - `'kr'`: Seoul, South Korea
    - `'jp'`: Tokyo, Japan (coming soon)
    - `'sg'`: Singapore (coming soon)
    - `'eu'`: Frankfurt, Germany (coming soon)
  - CI/CD pipeline automatically reads region from `spfn.config.js` and generates region-specific domains
  - TypeScript type definition: `Region` type exported for autocomplete

### Changed

- Domain generation now includes region: `{subdomain}.{region}.spfn.app` instead of `{subdomain}.spfn.app`
- Updated spfn.config.js template to include region field with 'kr' as default
- Updated Woodpecker CI/CD pipeline to handle region-based domain routing

### Example Configuration

```javascript
/**
 * @type {import('spfn').SpfnConfig}
 */
export default {
  packageManager: 'pnpm',
  deployment: {
    subdomain: 'myapp',
    region: 'us',  // Virginia, USA
    env: {
      NEXT_PUBLIC_API_URL: 'https://api-myapp.us.spfn.app'
    }
  }
}
```

## [0.1.0-alpha.16] - 2025-01-14

### Added

- **Configuration Migration: spfn.json → spfn.config.js**
  - Migrated from JSON to JavaScript configuration for better developer experience
  - Added comprehensive JSDoc comments with inline documentation
  - TypeScript type definitions for IDE autocomplete support (`@type {import('spfn').SpfnConfig}`)
  - Supports ESM/CJS based on package.json settings

- **Environment Variables Support**
  - Added `env` section in `spfn.config.js` for injecting environment variables
  - Environment variables are shared between Next.js and SPFN backend
  - Includes security warnings about Git-committed values
  - CI/CD automatically extracts and injects env vars into Kubernetes deployment

- **Dual Domain Architecture**
  - Automatic domain generation: `{subdomain}.spfn.app` for Next.js
  - Automatic API domain: `api-{subdomain}.spfn.app` for SPFN backend
  - Custom domain support for both Next.js and SPFN API
  - Documented in JSDoc comments for easy reference

- **TypeScript Type Definitions**
  - `SpfnConfig` - Main configuration interface
  - `PackageManager` - Package manager options
  - `DeploymentConfig` - Deployment settings
  - `CustomDomains` - Custom domain configuration
  - `EnvironmentVariables` - Environment variable configuration

### Changed

- **spfn init** now generates `spfn.config.js` instead of `spfn.json`
- Removed `resources` section from user configuration (now platform-controlled for revenue model)
- Updated CI/CD pipeline to read JavaScript config files using Node.js ESM imports

### Example Configuration

```javascript
/**
 * @type {import('spfn').SpfnConfig}
 */
export default {
  packageManager: 'pnpm',
  deployment: {
    subdomain: 'myapp',
    customDomains: {
      nextjs: ['www.example.com'],
      spfn: ['api.example.com']
    },
    env: {
      NEXT_PUBLIC_API_URL: 'https://api-myapp.spfn.app',
      NODE_ENV: 'production'
    }
  }
}
```

## [0.1.0-alpha.15] - Previous Release

- Initial alpha release with basic SPFN functionality