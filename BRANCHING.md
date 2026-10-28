# Branching Strategy

`main` is the only long-lived branch. Every change reaches it through a pull request,
and a pull request is squash-merged, so each change lands on `main` as one commit whose
message is the pull request's title.

## Branches

Name a branch after the kind of change:

| Prefix | For | Example |
|--------|-----|---------|
| `feat/` | A new capability | `feat/auth-apple-web-142` |
| `fix/` | A bug fix | `fix/auth-admission-primary-read` |
| `docs/` | Documentation and the site under `site/` | `docs/storage-minio-retired` |
| `chore/` | Build, dependencies, configuration | `chore/auth-beta-42` |
| `release/` | A version bump that publishes | `release/auth-beta44-cli-beta18` |
| `ci/` | The pipelines | `ci/scope-pr-pipeline` |

Branch from the current `main` and keep the branch to one concern. There are no
long-lived feature or package branches.

## Pull requests

- The title follows Conventional Commits (`type(scope): subject`, `!` for a breaking
  change), because it becomes the commit on `main`.
- The pull request pipeline (`.woodpecker/pr.yml`) builds, lints, type-checks, runs
  `pnpm check:versions` and `pnpm check:exports`, and runs the tests of the packages the
  change touches and of everything that depends on them. A change outside the workspace
  packages runs everything.
- Every commit carries a DCO sign-off (`git commit -s`). See
  [CONTRIBUTING.md](./CONTRIBUTING.md#dco).

The GitHub repository [fxylabs/spfn](https://github.com/fxylabs/spfn) is a mirror of the
primary repository, and its `main` follows the primary's.

## Releases

A release is a version bump of `packages/<pkg>/package.json` merged to `main`. That push
publishes the new version to the private registry and to public npm; nothing is
published off a git tag. Versions stay prereleases (`0.x.y-beta.N`, `0.x.y-alpha.N`).
[.github/PUBLISHING.md](./.github/PUBLISHING.md) has the exact process.
