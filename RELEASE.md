# Release SPFN Packages to npm

> ⚠️ **OUTDATED — current process differs.** This guide describes a **tag-triggered**
> release (`git tag @spfn/core@X.Y.Z` / `vX.Y.Z`, then push), and nothing is triggered by
> a tag any more. Packages now go to **two registries**: manually to the private Gitea
> registry via the `publish:*` scripts, and automatically to public npmjs via the
> per-package GitHub Actions workflows, which fire on a `packages/<pkg>/package.json`
> version change landing on `main`. See **[.github/PUBLISHING.md](./.github/PUBLISHING.md)**
> for the real process. The steps below are kept for historical reference only.

Release guide for @spfn/core, @spfn/auth, @spfn/cms, and spfn CLI packages.

## Deployment Strategies

### Individual Package Release
- Deploy single package independently
- Tag format: `@spfn/core@X.X.X`, `@spfn/auth@X.X.X`, `@spfn/cms@X.X.X`, `spfn@X.X.X`
- Use when: Only one package has changes

### Full Release (All Packages)
- Deploy all packages together
- Tag format: `vX.X.X`
- Use when: Multiple packages need coordinated version update

## Release Steps

### 1. Check Current Version

Read package.json of packages to be released:
- `packages/core/package.json` (core)
- `packages/auth/package.json` (auth)
- `packages/cms/package.json` (cms)
- `packages/cli/package.json` (CLI)

Ask user for new version number (e.g., `0.1.0-alpha.15`)

### 2. Update Version

**Individual release:** Update target package only
**Full release:** Update all four packages

### 3. Document Changes

- Update `CHANGELOG.md` with version and changes
- For new features:
  - Add docs in relevant package (e.g., `packages/core/src/MODULE/README.md`)
  - Update main README if needed (e.g., `packages/core/README.md`)
- Review all documentation for accuracy

### 4. Build Packages

**Individual release:** Build target package (and dependencies)
```bash
# Core (no dependencies)
cd packages/core && pnpm build

# Auth (depends on core)
cd packages/core && pnpm build && cd ../auth && pnpm build

# CMS (depends on core)
cd packages/core && pnpm build && cd ../cms && pnpm build

# CLI (no dependencies)
cd packages/cli && pnpm build
```

**Full release:** Build all packages
```bash
cd packages/core && pnpm build
cd ../auth && pnpm build
cd ../cms && pnpm build
cd ../cli && pnpm build
```

### 5. Test in /tmp

Create clean test directory and verify:
```bash
spfn init -y
spfn generate users
spfn build
spfn start --server-only  # Run in background, check output, kill
```

**All tests must pass before proceeding.**

## Individual Package Release

### 6. Commit and Tag

```bash
# Commit changes
git add . && git commit -m "chore(PACKAGE): Release version X.X.X"

# Create package-specific tag
git tag PACKAGE@X.X.X -m "Release PACKAGE@X.X.X

- Feature 1
- Feature 2"
```

Examples:
- `git tag @spfn/core@0.1.0-alpha.15`
- `git tag @spfn/auth@0.1.0-alpha.1`
- `git tag @spfn/cms@0.1.0-alpha.5`
- `git tag spfn@0.1.0-alpha.15`

### 7. Push to GitHub

```bash
git push
git push origin PACKAGE@X.X.X
```

GitHub Actions will automatically:
1. Build the tagged package (and dependencies)
2. Publish to npm with `alpha` tag
3. Add `latest` tag

### 8. Verify Deployment

- Check Actions: https://github.com/spfn/spfn/actions
- Wait 3-5 minutes
- Verify on npmjs.com:
  - https://www.npmjs.com/package/@spfn/core
  - https://www.npmjs.com/package/@spfn/auth
  - https://www.npmjs.com/package/@spfn/cms
  - https://www.npmjs.com/package/spfn
- Both `alpha` and `latest` tags should point to new version

## Full Release (All Packages)

### 6. Commit and Tag

```bash
# Commit all changes
git add . && git commit -m "chore: Release version X.X.X"

# Create version tag
git tag vX.X.X -m "Release vX.X.X

- Feature 1
- Feature 2"
```

### 7. Push to GitHub

```bash
git push
git push origin vX.X.X
```

GitHub Actions will automatically:
1. Build all packages (core, auth, cms, CLI)
2. Publish all to npm with `alpha` tag
3. Add `latest` tag to all

### 8. Verify Deployment

- Check Actions: https://github.com/spfn/spfn/actions
- Wait 5-10 minutes
- Verify all packages on npmjs.com
- Both `alpha` and `latest` tags should point to new version

## Important Notes

### General
- **Never push if tests fail**
- Tag message should match CHANGELOG.md
- GitHub Actions uses:
  - Trusted Publishing (OIDC) for initial publish
  - NPM_TOKEN for dist-tag (expires in 90 days)
- No manual OTP required

### Individual Release
- **Check dependencies**: Ensure compatible versions are published
  - Auth requires compatible core version
  - CMS requires compatible core version
- **Multiple tags**: Can push multiple simultaneously:
  ```bash
  git push origin @spfn/core@X.X.X @spfn/auth@X.X.X
  ```
- **Independent versioning**: Each package can have different versions

### Full Release
- **Coordinated update**: All packages get same version
- **Recommended when**: Unsure about dependencies
- **Testing**: Must test all packages, not just changed ones

## Package Dependencies

```
@spfn/core (standalone)
    ↓
@spfn/auth (depends on core)
@spfn/cms (depends on core)

spfn CLI (standalone)
```

When releasing auth or cms individually, ensure core is already published with compatible version.