# spfn — the SPFN CLI (backend layer for Next.js)

`spfn` takes a Next.js idea from prototype to production with a consistent full-stack
architecture. It can scaffold either a core-only backend or a production baseline with
authentication, internationalization, and a terminal operations surface, then runs the
dev/build/start lifecycle, database tooling, RPC codegen, and environment validation.

Consistent is the point rather than a nicety: what it scaffolds is one fixed shape per
feature, so a coding agent has no architecture left to invent and the codebase does not
acquire several. That problem has a name —
[architecture drift](https://superfunction.xyz/architecture-drift).

> Beta: install with the `@beta` tag (`spfn@beta`). The binary is `spfn`.

## Install

No global install needed — run through your package manager's dlx/npx:

```bash
npx spfn@beta <command>
pnpm dlx spfn@beta <command>
```

Or add it as a project dependency (`spfn init`/`spfn create` do this for you), then
call it via `pnpm spfn <command>` / `npm run spfn:<script>`.

Once the app has its own `@spfn/core`, run the app's own `spfn` for the commands that load its
source (`db`, `codegen`, `build`, `contract`): a `spfn` from `npx`/`dlx` or a global install brings
a second `@spfn/core`, and is refused, saying so and naming the command to run instead (`pnpm exec
spfn db generate`).

Requirements: Node.js 22.23.4+ (or 24.22.1+, 26.12.1+) in both modes, Next.js 16.4.5+ (App Router, `src/` dir),
PostgreSQL 14+ (Redis optional). Next.js 15
is not supported — see [the root README](../../README.md#what-do-i-need-installed).

## Usage

```bash
# Prototype-to-Production baseline: core + auth + i18n + ops
npx spfn@beta create my-app --mode full
cd my-app
docker compose up -d            # Postgres + Redis
# .env.local & .env.server are generated — keep both gitignored
pnpm spfn db push               # Apply auth migrations, then create the app's tables
pnpm spfn:dev                   # Next.js :3790 + SPFN API :8790

# Core-only full-stack skeleton
npx spfn@beta create my-api --mode bare

# Add SPFN to an existing Next.js project
npx spfn@beta init --mode full
```

The package manager is the app's own, decided in this order:

1. **The app's own lockfile** (`bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`,
   `package-lock.json`). Nothing above the app is read.
2. **The workspace that lists the app.** Walking up, each directory's lockfile selects its
   manager, and that manager's declaration decides membership: `pnpm-workspace.yaml`
   `packages` for pnpm, `package.json` `workspaces` for yarn, npm and bun (`!` negations
   honoured). A directory with no lockfile is pnpm's if it has a `pnpm-workspace.yaml`,
   npm's otherwise. The nearest directory that declares a workspace answers; one whose
   declaration cannot be parsed (after stripping a BOM) or is not the documented shape is
   someone else's file and declares nothing.
3. **npm.** A directory inside a pnpm or yarn repository that its workspace does not list
   is its own npm project.

yarn classic ignores `!` negations in `workspaces`, so a directory such a negation excludes
is answered npm here while yarn 1 still treats it as a member. Override with `--pm`
(`create`, `init`); `dev`, `build`, `start`, `add`, `setup` and `provision` have none. When
`create` makes a member of a pnpm workspace, it installs from the workspace root.

"Dependencies installed" is printed only once every package in the app's `dependencies` and
`devDependencies` resolves from the app directory (optional and peer dependencies are not
checked); otherwise the command exits 1 naming the missing ones, and says why when it can
(pnpm run in a directory its workspace does not list installs that workspace instead).
Node answers, in a child process started in the app directory without the CLI's
`NODE_PATH` or `NODE_OPTIONS`, through the app's `.pnp.cjs` under Plug'n'Play; a package
resolves when Node finds its `package.json`, since an entry point is optional.

npm installs (`init`, `add`, `create`, `setup icons`, and the generated Dockerfile's
`npm ci` / `npm prune`) pass no peer flag. The CLI does not predict what npm resolves: when
an install fails, it prints the manager's own output, and when npm's error is `ERESOLVE` over
drizzle-typebox's peer on drizzle-orm (npm's `Could not resolve dependency:` or
`Conflicting peer dependency:` stanza names `peer drizzle-orm@"…" from drizzle-typebox@…`) it adds
one line saying why and how to fix it; an `ERESOLVE` npm only warns about, or one over another
package, gets npm's output alone. drizzle-typebox `0.x`'s peer
range on drizzle-orm (`>=0.36.0`) admits no prerelease, so npm refuses it beside the
`1.0.0-rc.4` SPFN pins, as in every npm app an earlier `spfn init` scaffolded. Remove it from the
`package.json` that declares it (the app's, or its npm workspace root's), or move to a drizzle-typebox
version that accepts the prerelease, or import `drizzle-orm/typebox-legacy` instead. A failed
install exits non-zero in `init`, `add` and `setup icons`; in `create` the `@svgr/webpack`
install only warns, as before. When `spfn init` fails at its install step, what it wrote before
it stays, as for any install failure: `src/server` and `src/lib` (full mode: also its app
pages and `src/i18n`), the RPC proxy route, in full mode the `next.config` rewrites (bare mode
leaves `next.config` as it was), the Docker files, `spfn.config.js` and the patched
`package.json`. The `.env` files, `.spfnrc.ts`, `.gitignore`,
`tsconfig.json` changes and `README.md` come after the install and are not written.

---

## Commands

Registered top-level commands: `create`, `init`, `add`, `dev`, `build`, `start`,
`provision`, `codegen`, `contract`, `key`, `setup`, `db`, `env`, `ops`, `secret`,
`cloud`, `kit`.

### `spfn create <name>`

Runs `create-next-app` with SPFN-recommended flags (TypeScript, App Router, `src/`,
Tailwind, import alias `@/*`, no ESLint), sets up SVGR icons, then runs `init`.

`--pm` picks the manager that installs the app's dependencies. The one-off packages `create`
launches — `create-next-app`, and `shadcn` with `--shadcn` — run through `yarn dlx` when `--pm yarn`
and the yarn that answers in that directory has `dlx` (yarn 2+, which is what corepack gives
`yarn dlx`, so the app is a Yarn 4 app as before). yarn 1 has no `dlx`, so there, and for npm, pnpm
and bun, they run through `npx --yes`. create asks yarn with `yarn dlx --help` in that directory:
yarn 1's `yarn run v1.` banner means no `dlx`, exit 0 with the `yarn dlx <command>` usage means
`dlx`, and no `yarn` on PATH stops `--pm yarn` before anything is downloaded or written, with "yarn
was not found; install it or choose another --pm". Any other answer (a corepack refusal, a failed
download) stops create with yarn's output. The question shares your terminal, so corepack's "about
to download" notice, and its prompt under `COREPACK_ENABLE_DOWNLOAD_PROMPT=1`, show as they do for
`yarn dlx` itself. npx comes with npm, which Node's own installers include;
some distribution packages ship it separately, and without it `create` stops with "npx was not
found; install npm". create-next-app is told the manager with `--use-<pm>`, and shadcn reads it
from the lockfile.

Choose `full` for the recommended Prototype-to-Production baseline or `bare` for the
historical core-only skeleton. Without `--mode`, interactive runs show a mode selector
with `full` recommended. For backward compatibility, non-interactive `--yes` runs without
an explicit mode continue to generate `bare`; automation that wants full should always
pass `--mode full`.

| Option | Description |
|--------|-------------|
| `--pm <manager>` | Package manager that installs: `npm` \| `pnpm` \| `yarn` \| `bun` (yarn 1 included) |
| `--shadcn` | Also run `shadcn init` |
| `--mode <mode>` | `bare` (core only) \| `full` (core, auth, i18n, ops) |
| `--skip-install` | Skip dependency install |
| `--skip-git` | Skip `git init` |
| `-y, --yes` | Skip prompts, use defaults |

### `spfn init`

Adds SPFN to an existing Next.js project: copies the selected server templates, wires the RPC
proxy route, Docker files, deploy + codegen config, updates `package.json` scripts/deps,
and installs. Full mode also adds the `/_auth/:path*` → SPFN API rewrite to
`next.config` (OAuth callbacks return to the app origin; merged manually if a `rewrites()`
already exists). See [Scaffold structure](#scaffold-structure) for what lands on disk.

| Option | Description |
|--------|-------------|
| `--mode <mode>` | `bare` (core only) \| `full` (core, auth, i18n, ops) |
| `--pm <manager>` | Package manager: `npm` \| `pnpm` \| `yarn` \| `bun` (default: detected from the app) |
| `-y, --yes` | Skip prompts, use defaults |

Generated projects pin `drizzle-orm` and `drizzle-kit` to `1.0.0-rc.4`, matching
`@spfn/core` and the rest of the published SPFN database packages.

### `spfn add <package>`

Installs an SPFN ecosystem package and applies its pre-built migrations. The package
name must be scoped (contain `/`).

```bash
pnpm spfn add @spfn/cms
pnpm spfn add @mycompany/spfn-analytics
```

How it works: if not already present it installs the package, then reads the package's
`spfn` field in its `package.json` (`migrations`, `setupMessage`) and applies any
function migrations as the table owner (`DATABASE_OWNER_URL`, else `DATABASE_URL`), then
grants the app role what the manifests declare (the step `spfn db grant` runs). If neither URL
is set, migration is skipped with a hint to run `spfn db migrate` later. Works with published and
workspace packages.

### `spfn add vercel`

`vercel` is not a package — it is a built-in target, and the one argument to `add` that is
not a scoped package name. It scaffolds the three files a Next.js + SPFN app needs to run
its backend as Vercel Functions:

| File | What it is |
|------|------------|
| `src/app/api/backend/[[...route]]/route.ts` | `hono/vercel` adapter, mounts the SPFN app under `/api/backend` |
| `vercel.json` | build config (`pnpm spfn:build`) |
| `.npmrc` | which registry the `@spfn` scope resolves to — a mapping, not a credential |

The registry token does **not** go in that `.npmrc`. pnpm 10 and later refuse to expand an
environment variable in a registry credential that came from a project `.npmrc` — the file is
committed, and a hostile edit could redirect the secret to a registry nobody chose. pnpm drops
the line with a warning and the install fails as unauthorized. So the credential goes in Vercel's
`NPM_RC` environment variable, which Vercel writes to the build container's user-level `~/.npmrc`,
where pnpm still expands it. `spfn add vercel` prints the exact block to paste.

Existing files are never overwritten; they are reported and skipped. The runtime behind
the adapter is `createServerlessApp()` from `@spfn/core/server`. Afterwards, point
`SPFN_API_URL` at `https://<your-domain>/api/backend`, and make sure `hono` is a direct
dependency of the app so `hono/vercel` resolves.

### `spfn dev`

Starts the SPFN server + Next.js (and a codegen watcher, which generates under
`NODE_ENV=production` — see [`spfn codegen`](#spfn-codegen)). The server must report ready
(via a `.spfn/server-ready` signal file) before Next.js launches. Runs through `tsx`,
no pre-build needed.

The server and the codegen watcher each run in a Node process of their own, started by `spfn dev`
directly as `node --import <tsx> --import <spfn's module hook> <entry>`, with the `tsx` found in a
`node_modules` directory on the way up from the app (the app's own, which wins), else on the way
up from where `spfn` itself is installed — the one `spfn`'s bin runs under. `NODE_PATH` is not
consulted. With neither, `spfn dev` starts nothing and exits 1 with `tsx is not installed in this
project, and it is what loads TypeScript. Add it: pnpm add -D tsx` (your package manager's
command). Neither child runs through `pnpm exec`/`npx`, which exit before what they run, nor
through the `tsx` CLI, which relays a signal its child already got. Next.js runs through your
`spfn:next` script (`pnpm run spfn:next --port <port>`). No child gets a stdin.

The watcher loads the codegen config itself and loads it again when `.spfnrc.ts` (or
`.spfnrc.json`, or the `spfn.codegen` key of `package.json`), a custom generator file, or a
project file one of them imports changes: no restart is needed after editing the config. A
config that fails to load — at start or after an edit — does not stop the watcher: it logs
`✗ Codegen config failed to load: … Regeneration is paused; save a fix to retry.`, generates
nothing until the config loads again, and regenerates everything once it does. A changed
generator *package* (under `node_modules`, or a rebuilt workspace package) still needs a restart
([@spfn/core codegen](../core/src/codegen/README.md#watch-mode)).

| Option | Description | Default |
|--------|-------------|---------|
| `--server-only` | Run only the SPFN/Hono server (also auto-selected if Next.js isn't a dependency) | off |
| `--watch` | Restart the server on `src/server` changes (chokidar) | off |
| `-p, --port <port>` | SPFN server port (sets `SPFN_PORT`) | `spfn.config.js` `ports.server`, then `8790` |
| `-H, --host <host>` | SPFN server host (sets `SPFN_HOST`) | `spfn.config.js` `host`, then `localhost` |
| `--allow-pending-migrations` | Start even when migrations are pending (they are listed as a warning) | off |
| `--no-agent-files` | Do not write the SPFN instruction block into `AGENTS.md` (same as `SPFN_AGENT_FILES=0`) | writes on |

Note: hot reload is **off by default** — pass `--watch` to restart on file changes.

On startup `spfn dev` refreshes a marked block of SPFN conventions in the project's
`AGENTS.md` (creating the file, and a `CLAUDE.md` that references it, when absent) so
coding agents read the right idioms. Only the marked region is rewritten, and only when
its content actually changed.

Pending migrations stop the boot — see [Database](#spfn-db) for what the refusal looks
like and how to override it.

#### Stopping `spfn dev`: signals

`spfn dev` owns its process tree. Each child — the server, Next.js (with the package manager and
`sh -c` its script runs under), the codegen watcher — is the leader of a process group of its
own, and `spfn dev` stops it with one SIGTERM to that group, whatever the child runs under. It exits
only once every group is empty, with no deadline of its own.

| You send | to | Each child gets | `spfn dev` exits |
|----------|----|-----------------|------------------|
| Ctrl-C (or Ctrl-\\) in the terminal | the terminal's foreground group: `spfn dev` alone | one SIGTERM, from `spfn dev` | after the last child, 0 |
| `kill <pid>` / SIGTERM, SIGINT, SIGHUP or SIGQUIT from a process manager | the pid you started (`bin/spfn.js`'s) | one SIGTERM, from `spfn dev` | after the last child, 0 |
| the same signal again, or SIGTERM / SIGHUP / SIGQUIT after a Ctrl-C | | nothing more | unchanged |
| a second Ctrl-C (SIGINT once the stop has begun) | `spfn dev` | SIGKILL, to every group left | at once, 130 |
| — (stopping, the launcher exited **and** the shell has the terminal: one Ctrl-C to `pnpm exec spfn dev`, `pnpm spfn dev`, `yarn spfn dev` or yarn 1's `yarn dev`, also as `cat \| pnpm exec spfn dev`, `pnpm exec spfn dev \| tee log` or after `&` and `fg`; or `kill %1` / `kill -INT %1` to such a job in the background, after Ctrl-Z and `bg` too) | | SIGKILL, to every group left | at once, 130 |
| Ctrl-C to `pnpm exec spfn dev \| tee -i log` (or any reader that outlives the Ctrl-C): pnpm exits, the job keeps the terminal | `spfn dev`, pnpm, `tee` | one SIGTERM, from `spfn dev`; a second Ctrl-C still reaches it, and `tee` exiting (killed) before the stop ends escalates it | after the last child, 0 |
| Ctrl-C to `spfn dev \| tee log` (`tee` dies with it) | `spfn dev` and `tee` | one SIGTERM, from `spfn dev` | after the last child, 0 |
| `spfn dev \| head -1`: what reads the output exits, outside a stop | `spfn dev`, when its next line fails (EPIPE) | one SIGTERM, from `spfn dev` | after the last child, 141 (as SIGPIPE's) |
| the terminal hangs up (window closed, SSH dropped), whatever launched `spfn dev` | `spfn dev` (SIGHUP) | one SIGTERM, from `spfn dev` | after the last child, 0 |
| Ctrl-Z, `bg`, then `kill %1` to `spfn dev` typed directly; one Ctrl-C to `true \| spfn dev`, or to a job whose launcher left on its own while the job kept the terminal | `spfn dev` | one SIGTERM, from `spfn dev` | after the last child, 0 |
| Ctrl-Z in the terminal | the terminal's foreground group: `spfn dev` alone | nothing: they run on | not: it is stopped until `fg` |
| SIGKILL | `spfn dev` | nothing | at once |

- **The pid you start is `spfn dev`'s.** `bin/spfn.js` re-runs itself under tsx in its own
  process (`process.execve`) rather than in a child, so a signal to the pid a terminal, a process
  manager or `kill` sees reaches `spfn dev` once, and its exit status is `spfn dev`'s. (On Windows,
  which has neither `execve` nor process groups, the CLI runs as the bin's child, and each child of
  `spfn dev` is signalled alone.) `process.execve` is "Stability: 1 – Experimental" on every Node.js
  line spfn supports (22, 24, 26); a relaunch that fails stops the command with the error rather
  than run it without the module hook.
- **A terminal's Ctrl-C reaches each child once.** The children are not in the terminal's
  foreground group, so the terminal's SIGINT reaches `spfn dev` only, and `spfn dev`'s SIGTERM
  is the one signal each child gets.
- **Each child is a session of its own** (Node's `detached` is `setsid`), with no controlling
  terminal: nothing the terminal sends — Ctrl-C, Ctrl-\\, Ctrl-Z, a hangup — reaches it but through
  `spfn dev`. So Ctrl-Z stops `spfn dev` alone; the children run on while it is stopped. No child gets a
  stdin: reading the terminal it inherited, it would take what you type from the shell.
- **A second Ctrl-C escalates, and so does a launcher that exits.** SIGTERM and SIGHUP always mean
  "stop", however often they come: `pnpm exec spfn dev` relays a Ctrl-C as a SIGINT and then a
  SIGTERM, and a closing terminal sends SIGHUP. A SIGINT once the stop has begun — a person pressing
  Ctrl-C again, or `kill -INT` twice — means "stop waiting": it SIGKILLs every group left, and `spfn
  dev` exits 130. It is the way out of a server shutdown that takes too long (core's deadline is
  `SHUTDOWN_TIMEOUT`, 280 s by default) or a generation that never settles. Next.js's own processes
  and the server's are SIGKILLed with the rest. When that second Ctrl-C can no longer arrive, it is
  taken as given: when **both** the launcher has exited **and** another process group has the
  terminal. Typed directly, `spfn dev` is the process its shell started, and its parent, the
  shell, is outside the job's process group: it has no launcher. Under a launcher, the launcher is
  `spfn dev`'s ancestors inside its own group, from its parent up — it need not lead the group: in
  `cat | pnpm exec spfn dev` the leader is `cat` and the launcher is pnpm; in `true | spfn dev`
  there is none. `pnpm dev`, `npm run dev` and `npx spfn dev` wait for `spfn dev`, holding the job
  open, so a second Ctrl-C reaches it. `pnpm exec spfn dev`, `pnpm spfn dev`, `yarn spfn dev` and
  yarn 1's `yarn dev` exit on the first Ctrl-C (yarn 1 leaves its `sh -c` behind as `spfn dev`'s
  parent; yarn above it exits); the shell sees its job end, takes the terminal back, and a further
  Ctrl-C — or `fg`, or `kill %1` — goes to the shell. Each fact alone is wrong: the terminal taken
  with no launcher exited is job control (`spfn dev`, Ctrl-Z, `bg`, `kill %1`: `fg` and Ctrl-C
  still reach it, the graceful stop), and the launcher exited with the job still holding the
  terminal is a pipeline whose reader outlives the Ctrl-C (`pnpm exec spfn dev | tee -i log`, the
  graceful stop; a second Ctrl-C still reaches `spfn dev`) or a launcher that left on its own. So
  `spfn dev` finds its launcher when it starts and, when the stop begins and every 100 ms while it
  runs, asks whether its outermost process — the one the shell started — has exited (`kill(pid,
  0)`; EPERM, another user's process, is there) and, once it has, where the terminal sends a
  Ctrl-C. Only the outermost counts: the shell's job ends, and the shell takes the terminal back,
  when that process is gone, not an inner one. In `bash -c 'pnpm exec spfn dev; sleep 20'`, pnpm
  exits on a Ctrl-C while `bash -c` waits on: the job is still the shell's, and `fg` and a Ctrl-C
  still reach `spfn dev`. Under yarn 1, yarn is the outermost. When the terminal sends a Ctrl-C to
  another group, the stop
  escalates as a second Ctrl-C does — SIGKILL to every group left, exit 130 — at once, saying `the
  launcher that started spfn dev has exited and the shell has the terminal, so no second Ctrl-C can
  reach it: killing what is left of …`; no process is left holding the port behind the shell's
  prompt. If both held before `spfn dev` handled the Ctrl-C, the server gets no SIGTERM first.
  Without a controlling terminal — a process manager, CI, a terminal that hung up — nothing has the
  terminal, so nothing escalates (the graceful stop, as for SIGTERM). Off Linux both are `ps`'s to
  say: the launcher by one `ps` at start, not waited for (until it answers, or when it fails or
  does not answer within a second, no launcher is known); the terminal by a `ps` started only
  during the stop and once the launcher has exited, one at a time and at most one a second, so no
  answer from before the stop decides it, and one that fails or does not answer escalates nothing.
- **What reads `spfn dev`'s output exiting is a reason to stop, once.** A line `spfn dev` writes
  then fails: EPIPE on a pipe whose reader exited, EIO on a terminal that hung up. Outside a stop —
  `spfn dev | head -1` — that begins the graceful stop, as a signal does (a closed pipe is what
  SIGPIPE stands for), and `spfn dev` exits 141 after its children: what a shell reports for a
  process SIGPIPE ended (128 + 13). It did not finish its work; its reader went away, and `set -o
  pipefail` or `$PIPESTATUS` says so as for any producer whose reader left. Note that `spfn dev` sees it only
  on a line of its own: what the children write meets the closed pipe in the children. During a
  stop — `spfn dev | tee log`, whose Ctrl-C kills `tee` too, or a hang-up — the stopping lines of
  `spfn dev` and the codegen watcher fail, and those failures change nothing. Any other error on
  stdout or stderr still ends `spfn dev` as an uncaught exception (below). The server's own output is
  the server's: core's shutdown lines meet the same closed pipe.
- **The watcher finishes what it is running first.** On its SIGTERM it finishes the generation,
  or the codegen config load, it is running (`Codegen watcher stopping once the running generation
  or codegen config load finishes`), so the route map and contract never
  come from two generations. Neither can be cancelled — a config load is a module evaluation — so
  one that never settles (a top-level `await` that never resolves in `.spfnrc.ts` or a custom
  generator) holds the watcher until a second Ctrl-C, which kills it mid-generation or mid-load:
  whatever that generation would have reported — a `✓`/`✗` line, a failure held back from a run
  whose inputs changed while it ran — is dropped.
- **Once a stop has begun, `spfn dev` starts no child:** not Next.js when the server becomes ready
  during it, not a server restart (it logs `Next.js not started: spfn dev is stopping`).
- **`--watch` restarts the server the same way:** one SIGTERM to the server's group, then the new
  server starts once nothing is left in it — its port is free then.
- **Next.js exiting with an error** stops the server and the watcher, then `spfn dev`, exit 1.
- **`spfn dev` dying stops its children**: an uncaught exception SIGTERMs every child's group not signalled yet as `spfn dev` exits. Only a SIGKILL of `spfn dev`
  reaches no child: their groups run on. A process manager that kills by process group must kill
  each child's group, or the cgroup (systemd's default `KillMode=control-group` does).

#### Your server source runs as ESM, as it does in production

`spfn build` bundles `src/server` as ESM with esbuild whatever your `package.json` says, and
esbuild decides each `.js` file by its own syntax. Every other `spfn` command gives your source the
same formats: the `spfn` bin runs every command in a process with `tsx` and a Node module hook
(`module.registerHooks`) registered for the directory it was started in — re-running itself to get
them unless the process already has that hook, whatever else started it (`node --import tsx`,
`npx tsx`, `NODE_OPTIONS`) — and so does every `tsx` process a command starts: the `spfn dev`
server and codegen watcher, the `spfn provision` runner. So the files of yours a command loads
itself — entities under `spfn db generate`, `db push` and `db tenant`, `drizzle.config.ts` under
`db push` and `db tenant`, `server.config` under `spfn provision`, `env.schemas` files under `spfn
env`, your router under codegen — load as they do under `spfn dev`. (`drizzle-kit`, which `db
generate`, `check`, `drop` and `studio` hand a `drizzle.config.ts` to, reads that file and the
schema it names in a process of its own, by its own rule.) Without `tsx` in the app, the bin runs
the command without the hook — only when no `tsx` package is found (`tsx/package.json` does not
resolve); a `tsx` package that is there but whose entry cannot be resolved (a `package.json` that
does not parse or cannot be read, an entry file missing) stops the command with `Error: spfn could not resolve tsx, which it re-runs itself under: …`, exit 1 — and a command that loads your TypeScript — `spfn env`, `spfn db`
(`push`, `tenant`, and `generate` with the entity registry), `spfn provision` — stops before its
first import with `tsx is not installed in this project, and it is what loads TypeScript. Add it:
<your package manager's add command>` and exit code 1. The cost: every `spfn` command in a project
re-runs itself once (in its own process) to get the hook, and the hook's resolve takes its own
time — ~73 ms of self-time over 2,815 resolves on `spfn --version` in example 01 (measured on the dev VM, Node 22,
hook time minus Node's own resolve). The hook states the format of every file of yours that `tsx`
would otherwise guess from `package.json`:

- `.ts` and `.tsx` run as ESM, with or without `"type": "module"`, also when imported with a query
  of your own (`./route.ts?v=2`), which reaches the module as you wrote it — one evaluation per
  distinct query, as Node does.
- `.js` and `.jsx` in a package with no `"type"` are decided by the file's own syntax, as Node's
  detection decides it: static `import`/`export`, `import.meta` or top-level `await` make it ESM,
  anything else CommonJS. The parser is esbuild's, the one `spfn build` bundles the file with.
- A stated `"type"`, and a stated extension — `.mjs`, `.cjs`, `.mts`, `.cts` — is yours and is left
  alone.

A file is yours unless it is a dependency: a `node_modules` directory appears in its real path
below the longest common ancestor of that path and the directory the command was started in. So a
workspace package beside the app, consumed as source, is yours; what is installed under it is
not; and a `node_modules` directory above the app (a project checked out under one) does not
count. A workspace package that pnpm materialises under `node_modules/.pnpm` (`injected: true`)
is a dependency, and its TypeScript is not transformed here — production cannot strip its types
either.

Before this, a project without `"type": "module"` — every `spfn create` scaffold — ran its
source as CommonJS under `tsx`, and `tsx` loaded a second, CommonJS copy of every `@spfn/*`
package the app imported beside the server's ESM one. The app configured one copy and the
server ran the other: rate-limit `policies` and `.trustedProxyHops()` were ignored by
`@spfn/auth`'s routes, and with `secondFactor.required` an account without a factor got 403
`SECOND_FACTOR_ENROLMENT_REQUIRED` on the enrolment routes too. In dev only (issue #329).
`@spfn/core` now refuses a second copy of itself, naming the file that loaded it
([why](../core/README.md#why-does-the-server-refuse-a-second-copy-of-spfncore)).

> **BREAKING (dev only).** CommonJS shapes in server source no longer run under `spfn dev`.
> What was observed, in a scaffolded app without `"type": "module"`, against `spfn build` +
> `spfn start` of the same file:
>
> | In `src/server` | `spfn dev` now | `spfn build` + `spfn start` |
> |---|---|---|
> | `require('node:path')` in a `.ts` file | `ReferenceError: require is not defined` | `Error: Dynamic require of "path" is not supported` |
> | `__dirname`, `__filename` | `ReferenceError: … is not defined` | `ReferenceError: … is not defined` |
> | a `.cts`, `.cjs` or CommonJS `.js` file that `require`s `@spfn/*` | boot refused: a second copy of `@spfn/core`, naming the file | `Error: Dynamic require of "@spfn/core/logger" is not supported` |
> | a file written with `module.exports = { value }`, default import | works | works |
> | the same file as `.js`, `import { value } from …` | boot refused: `does not provide an export named 'value'` | **works** |
> | the same file as `.cjs`, `import { value } from …` | boot refused: `does not provide an export named 'value'` | **works** |
> | top-level `await` in a server file | works | **build fails**: `Top-level await is not available in the configured target environment ("es2020")` (in a file the router reaches, codegen fails first: `await is only valid in async functions…`) |
>
> So the named import of a `module.exports` file — by its contents or by its `.cjs` extension —
> is what worked in production and now fails in dev: write that file as ESM
> (`export const value = …`). A CommonJS file that requires `@spfn/*` already failed in
> production; under `tsx` it cannot share `@spfn/*` with the server (`tsx`'s CommonJS handler
> transforms the ESM-only packages into a copy of their own), so it is refused rather than run
> split — import `@spfn/*` from an ES module. Top-level `await` is the reverse: it runs in dev and
> the production build rejects it. Use `import.meta.url` / `import.meta.dirname` and `import` for
> the rest.
>
> **BREAKING (`spfn db`, `spfn provision`).** In an app without `"type": "module"`, these
> commands loaded your files — and what they import — as CommonJS, beside a second copy of
> `@spfn/core` (issue #349). They now load them as `spfn dev` does, so the CommonJS-only shapes in
> the table above fail where the CLI loads the file itself, and these commands refuse a second copy
> of `@spfn/core` as a server does: a `.cjs` file that requires `@spfn/*` from those files stops
> the command, naming the file. File by file:
>
> - **Entity files** — loaded by `db push` and `db tenant`, and by `db generate` when the app has
>   the entity registry `src/server/entities/config.ts` (every scaffold) or a function package
>   installed and no `drizzle.config.ts` of its own. A CommonJS-only shape fails there; top-level
>   `await` now loads. `drizzle-kit` then reads the entities again under `db generate`, by its own
>   rule.
> - **`server.config`** — loaded by the `spfn provision` runner. A CommonJS-only shape fails there.
> - **`drizzle.config.ts`** — read by the CLI itself only under `db push` and `db tenant`, for its
>   `schema` and `schemaFilter`. A config that cannot be loaded stops `db push` — with `--schema`
>   too, since its `schemaFilter` is what push may touch — and `db tenant`, with exit code 1.
>   `__dirname`, `__filename` or `require` there now does: `Could not load <path>: __dirname is not
>   defined in ES module scope. spfn reads <path> as ESM, as the app's other source (drizzle-kit
>   reads it by its own rule): use import.meta.dirname, import.meta.filename and import instead of
>   __dirname`. The load error in that message is the config's own text, with the credentials of
>   any URL in it (`scheme://user:pass@host`) blanked to `<redacted>` — as in `spfn env`'s and the
>   `provision` runner's load errors; a secret the config prints in another form (a bare password,
>   its own `console.log`) is the config's own output. `module.exports = { … }` still loads.
>   `db generate`, `check`, `drop` and `studio` hand the file to `drizzle-kit`, which reads it as
>   before — a CommonJS config works there.
>
> Not a break — dev now matches production: a named import from a CommonJS npm package whose
> exports Node cannot analyse (`import { red } from 'chalk'` v4, `{ sign } from 'jsonwebtoken'`,
> `{ enable } from 'debug'`) fails under `spfn dev` (`does not provide an export named …`) as it
> already failed under `spfn build` + `spfn start` (`Named export … not found. The requested
> module … is a CommonJS module`). Use the default import (`import jwt from 'jsonwebtoken'`).
>
> **Upgrade `spfn` and `@spfn/core` together.** An older `spfn` CLI runs the app the old way,
> and the new `@spfn/core` refuses that boot, naming the TypeScript file loaded as CommonJS and
> saying to upgrade the CLI together with `@spfn/core` and start the app with `spfn dev`.

The hook is registered with `module.registerHooks`, which every Node line the packages support has.
`tsx` before 4.22 registers its own hooks with the deprecated `module.register()` and prints
`DEP0205` on Node 26; a scaffold depends on `tsx` `^4.22.4`.

Codegen — `spfn codegen run`, `spfn build`'s generation step, `spfn contract`, and the codegen
watcher `spfn dev` starts — imports your router the same way, in its own process's module graph:
`@spfn/core` registers a hook of its own (`module.registerHooks`) that runs your TypeScript as ESM
by the same rule, resolves tsconfig `paths` as tsc does, and re-runs only your project's files on
each reload; every package is evaluated once. A second copy of `@spfn/core` found after a router
load — a `.cts` route requiring `@spfn/*` — is refused in these processes (each marks itself with
`markAppSourceProcess()` from `@spfn/core/codegen`, as `spfn db` and `spfn provision` do; nothing
it spawns inherits the mark). The watcher regenerates for any project file the router
reached, not only `src/server/routes/**`: an edit to `src/server/lib/segment.ts` imported through
`@/` regenerates too. Each reload keeps about 100 KB per small app in memory, by design
([@spfn/core codegen](../core/src/codegen/README.md#how-the-router-is-loaded)).

### `spfn build`

Runs codegen, builds Next.js (via the project's `build` script), and compiles
`src/server/**/*.ts` → `.spfn/server` with tsup. Also writes `.spfn/prod-server.mjs`
(the production entry consumed by `spfn start`).
For quieter output, set the logger's level for the run: `SPFN_LOG_LEVEL=warn spfn build`.

| Option | Description |
|--------|-------------|
| `--server-only` | Build only the SPFN server (skip Next.js) |
| `--next-only` | Build only Next.js (skip the SPFN server) |
| `--turbo` | Use Turbopack for the Next.js build |

> **BREAKING.** `spfn build` runs under `NODE_ENV=production` from its codegen step on,
> whatever the shell set. Codegen pins it in the building process, so `NODE_ENV=development spfn
> build` (or `test`) now runs the later steps — the project's `build` script (`next build`) and
> the tsup server build — under `production` as well; before, they inherited the shell's
> value. A build that needs another value for those steps has to run them itself.

### `spfn start`

Starts the production servers from build output. Requires `spfn build` first — it errors
if `.spfn/server`, `.spfn/prod-server.mjs`, or `.next` are missing.

| Option | Description | Default |
|--------|-------------|---------|
| `--server-only` | Run only the SPFN server | off |
| `--next-only` | Run only Next.js | off |
| `-p, --port <port>` | SPFN server port (sets `SPFN_PORT`) | `spfn.config.js` `ports.server`, then `8790` |
| `-h, --host <host>` | SPFN server host (sets `SPFN_HOST`) | `spfn.config.js` `host`, then `localhost` |
| `--allow-pending-migrations` | Start even when migrations are pending (they are listed as a warning) | off |

Both run together via `concurrently --kill-others`.

Neither flag has a default value, deliberately. A default is indistinguishable
from a value the operator typed, and it was forwarded as `SPFN_PORT` either way —
which overrode the app's own configuration. Pass nothing and `spfn.config.js`
decides; pass a flag and it wins.

Next.js is started on the port `spfn.config.js` gives as `ports.next` (`3790` by
default), overridable with `NEXT_PORT`.

Pending migrations stop the boot unless `--allow-pending-migrations` or
`SPFN_ALLOW_PENDING_MIGRATIONS=true` is set — see [Database](#spfn-db). `--next-only`
skips the check: no SPFN server starts, so nothing can drift.

### `spfn codegen`

Manages code generators driven by `.spfnrc.ts`. The default generator is
`@spfn/core:route-map`, which emits `src/generated/route-map.ts` from `src/server/router.ts`
so the RPC proxy can resolve routes without importing server code. Generators also run
automatically during `spfn dev` and `spfn build`.

| Subcommand | Description |
|------------|-------------|
| `codegen init` | Create `.spfnrc.ts` (`--with-example` shows custom-generator usage) |
| `codegen list` (`ls`) | List configured generators and their watch patterns |
| `codegen run` | Run all generators once (no watch) |

`package.json` exposes this as the `codegen` script (`spfn codegen run`).

Code generation runs under `NODE_ENV=production`, whatever the shell or the parent process set,
and logs once when it replaces a different value. It is set before any of your code is
evaluated — the `spfn dev` watcher process starts with it, the other commands set it before
reading `.spfnrc.ts` — so `.spfnrc.ts`, custom generators and the built-in ones all see it, on
every run. `spfn codegen run`, `spfn build` and the watcher `spfn dev` starts therefore write
the same bytes; the generated header no longer names an environment. Only the generating
process is pinned: the `spfn dev` server keeps `development`. For `spfn build` the generating
process is the building one, so its later steps run under `production` too (see
[`spfn build`](#spfn-build)).

The route map generator refuses a router whose generated file would differ under
`NODE_ENV=development` or `test`, or with another key it read set or unset — a route, a route's
`csrf`, the entry order, a `.packages()` mount line — naming the key, the `NODE_ENV` value and
the difference. A key other than `NODE_ENV` compared against one particular value (`=== 'on'`)
is not covered. A route a package registers only outside production is served by `spfn dev`
but is not in the map. See [@spfn/core codegen](../core/src/codegen/README.md#when-it-refuses).

> **BREAKING.** An app whose generated content differs by environment beyond its route set is
> now refused at generation — by `spfn codegen run`, `spfn build` and the `spfn dev` watcher
> alike. The watcher loads the app under `production`; the dev server keeps `development`.

To add a custom generator, implement the `Generator` interface from `@spfn/core/codegen`
and reference it in `.spfnrc.ts`:

```ts
// .spfnrc.ts
import { defineConfig, defineGenerator } from '@spfn/core/codegen';

export default defineConfig({
    generators: [
        defineGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: './src/generated/route-map.ts',
        }),
    ],
});
```

### `spfn contract`

Manages the route contract — what a **separately deployed** client (a mobile app, an external
API consumer) is promised. A web client needs none of this: it derives its types from
`AppRouter` in the same build, so a broken response already fails the compile.

Requires the `@spfn/core:contract` generator in `.spfnrc.ts`. Every command regenerates the
contract from the router first, so a stale `contracts/current.json` is never what gets checked
or released.

```bash
# Regenerate and compare against the newest released snapshot
spfn contract check

# Cut a release — writes contracts/released/1.3.0.json. Commit it.
spfn contract release 1.3.0

# List released snapshots
spfn contract list
```

| Subcommand | Description | Exit code |
|------------|-------------|-----------|
| `contract check` | Compares the current contract against the newest released snapshot | 1 when a promise is broken |
| `contract release <version>` | Writes the snapshot every later build is compared against | 1 when the contract is broken, the version already exists, or it is not newer than the newest one |
| `contract list` (`ls`) | Lists released snapshots | 0 |

`--dir <path>` overrides the contracts directory; by default it comes from the generator's
`outputDir` in `.spfnrc.ts`.

**`spfn build` runs the same gate.** A broken contract fails the build with a non-zero exit
code — that is the point of hanging the check off codegen rather than leaving it to a
separate step.

See [`@spfn/core` contract docs](../core/src/contract/README.md) for the case table and the
removal rules.

### `spfn db`

Wraps Drizzle Kit with auto-generated config. The commands read their connection from the
loaded `.env` chain and the shell; which variable each uses is in
[Which connection each command uses](#which-connection-each-command-uses) below.

| Subcommand | Description |
|------------|-------------|
| `db generate` (`g`) | Generate migrations from schema changes (timestamp-prefixed), then write `privileges.json` beside them, in the `out` of the config handed to drizzle-kit (`src/server/drizzle`, the folder `db migrate` reads, unless your own `drizzle.config.ts` names another) — the app privileges each table of that config's schema files declares with `appPrivileges()` (or `"default"`), each file loaded on its own as drizzle-kit loads it — every top-level export, `default` included, as drizzle-kit collects a migration's tables — less a function package's tables (the package declares its own). drizzle-kit is handed the schema files the manifest is made from — with your own `drizzle.config.ts`, a config of the run that spreads it and names those files — so a `**` glob cannot give the two different files. With your own `drizzle.config.ts` neither needs `DATABASE_URL`. A schema module that does not load, or two tables of one name declaring different lists, end the command before drizzle-kit writes a migration; a `privileges.json` that cannot be written ends it after (exit 1), saying the migrations were written and to rerun `spfn db generate`. Rewritten on every run, a declaration change that changes no DDL included; an unchanged schema writes the same bytes. A generated file: commit it with the migrations, never edit it. `db migrate`, `db grant` and `spfn add` grant from it, so a stale file grants the old set (the `@spfn/core` db README, [App privileges](../core/src/db/README.md#app-privileges-appprivileges)) |
| `db push` | Diff with Drizzle Kit's current PostgreSQL engine and apply the selected DDL atomically. Destructive changes need confirmation; `--force` applies them. Answering No skips them and applies the rest; an aborted confirmation (Ctrl-C, EOF) exits 1 with nothing applied, and so does a run whose stdin is not a terminal while a destructive change is pending and `--force` is not given. Function package migrations apply first (one transaction per package), then the project statements (one transaction), so a project table may reference a package table on an empty database; the plan lists them in that order. A failed statement prints one line: core's text for the error (the server's message where `@spfn/core` keeps it, else its fixed text for the SQLSTATE class, such as `Invalid input value`), then its code, constraint, table and column — never a row's value — and under it the statement's SQL (`   Failed statement: …`), for a package migration after the migration's name (`   In: @spfn/cms migration 20260101000000_init`). `--dry-run` shows each function package's pending migrations by name and the classified statements, then stops. Each plan query runs in its own `BEGIN READ ONLY` transaction, rolled back when the query ends, so it writes nothing and holds no lock between statements. Before the plan runs, `transaction_read_only` is read once, in one such transaction; when PostgreSQL does not report it `on` it exits 1. A database push cannot reach ends it the same way, before anything is planned: exit 1 and `❌ Could not connect to the database — nothing was planned or applied: could not reach the database (ECONNREFUSED)`, never the URL. Push, its dry run and the package migrations connect as the table owner (`DATABASE_OWNER_URL`, else `DATABASE_URL`). When PostgreSQL refuses a privilege (SQLSTATE 42501) and `DATABASE_OWNER_URL` is set apart from `DATABASE_URL`, push asks the catalog which of the schemas, tables and enum types it manages (a `pgEnum` created through a superuser's URL is the superuser's) belong to a role other than the one it connects as — leaving out an extension's members (PostGIS's `spatial_ref_sys`), which belong to the extension, a sequence a column owns, which follows its table, and initdb's objects; when some do, it prints `REASSIGN OWNED BY <their owner> TO <connected role>` with the names under the failed line — and for what the bootstrap superuser owns, for which PostgreSQL refuses `REASSIGN OWNED`, one `ALTER … OWNER TO <connected role>;` per object, to run as a superuser — the relation the failed statement acts on first (the table after `ALTER TABLE [IF EXISTS] [ONLY]`, `DROP TABLE [IF EXISTS]`, `CREATE INDEX … ON`, …, the type after `ALTER TYPE`/`DROP TYPE`, never a column or a referenced table). Any other 42501 adds nothing. Last, in a transaction of its own, the app role is granted exactly what the entities declare (`appPrivileges`) and each function package's manifest — see `db grant`; when that fails the schema stays applied, no privilege is changed — the new tables' included, which have only what the database gives a new table by default — and push exits 1 with `Schema applied; no privilege was changed, so new tables have only what the database gives by default`, the reason and its way out, then `spfn db grant`. `--dry-run` prints the roles and the privilege statements too, and `privileges for N new tables` for those push has not created yet |
| `db migrate` (`m`) | Run pending migrations. `--with-backup` snapshots first. Ends with the privileges step (`db grant`), reading the manifests only — the project's `src/server/drizzle/privileges.json` and each function package's; an unreadable manifest ends it before any migration, a failed grant after them (exit 1, `Schema applied; no privilege was changed, so new tables have only what the database gives by default`, the reason and its way out, then `spfn db grant`) |
| `db grant` | Grant the app role exactly what is declared, as the owner, in one transaction — the project's `src/server/drizzle/privileges.json`, or, for a project without one (one that only pushes), its entities loaded as `db push` loads them, and each function package's manifest; with neither manifest nor loadable entities it exits 1, saying the project's tables cannot be seen: on each managed table (the project's schemas, each function package's, `drizzle`) the declared set — `SELECT`, `INSERT`, `UPDATE`, `DELETE` unless `appPrivileges` says less — `USAGE` on the schemas and sequences, `SELECT` only on `drizzle`; everything else the owner granted the app role there, column grants, grant options and grants to PUBLIC included, is revoked (what reaches it through a group role is reported, not revoked); every `REVOKE` is plain, never `CASCADE`: when PostgreSQL refuses one because a grant the app role made with a grant option depends on it (2BP01), nothing is changed, exit 1, and the refused statement is printed with the grants on its table of what it revokes that roles other than the owner made (the dependent ones are among them) and the two ways out — their grantors revoke them, or the owner runs the statement with `CASCADE`, which the step never does; one refusal per run, the next run tries again; a grant to PUBLIC from another grantor, which the owner's `REVOKE` would leave in place, is listed with the `REVOKE` its grantor can run, nothing is changed, exit 1. The app role is the `current_user` of `DATABASE_WRITE_URL`, else `DATABASE_URL` (and a read role of `DATABASE_READ_URL`, brought to exactly `USAGE` and `SELECT` — anything else the owner granted it there is revoked); `DATABASE_APP_ROLE` names it when no app URL is set, and is refused (exit 1, before any statement) when it names another role or no role in the database. Without `DATABASE_OWNER_URL`, or with an app role that is the owner or inherits it, one note and nothing to grant; with no way to name the app role, one warning and exit 0; a table in a managed schema another role owns is listed, nothing is granted, exit 1. A second run issues nothing. `--dry-run` prints the roles, how each was found and the statements, and runs them in one transaction it always rolls back, so a statement PostgreSQL refuses is reported and nothing is changed — it needs a writable owner connection, takes the run's locks until the rollback (the core db README, "Database roles") and fires an event trigger on `GRANT`/`REVOKE` as a run does; `db push --dry-run` only plans them. `db push`, `db migrate` and `spfn add` end with the same step |
| `db status` | Show which migrations are applied and which are pending, for the project and for each installed function package. The project's pending list is drizzle-orm's own (`getMigrationsToRun`, by folder name), so it is what `db migrate` runs; when migrate would refuse the project's bookkeeping, status exits 1 with `bookkeeping does not match local migrations` and the remedy. `--json` prints one machine-readable report instead (one line after the `#spfn-db-status#` marker); when it could not read a status it has `reachable: false` and `reason`: `"not-configured"` (no `DATABASE_URL`), `"unreachable"` (the database did not answer), `"bookkeeping-mismatch"` (it answered, and `db migrate` would refuse the project's bookkeeping; `detail` carries the text) or `"permission-denied"` (it answered and refused the role in `DATABASE_URL` the read, SQLSTATE 42501 — typically no grant on schema `drizzle`; `detail` carries PostgreSQL's message). An unread status always has an empty `pending` list, which never means "nothing pending": check `reachable` first. The human form exits 1 on all of them and, on a permission error, names `spfn db grant`. Once the status is read it reports, as the app role, what `spfn db grant` would change for it against the declarations (the project's manifest, else its entities as `db push` loads them, and each function package's manifest; with neither, `checked: false`) — read from the catalog the step reads and compared by the step's own plan, so "holds what is declared" means `db grant` has no statement that changes what the app role or PUBLIC can do — none on a relation for the app role, PUBLIC or a role the app is a member of (the read role, planned as `db grant` plans it: the `current_user` of `DATABASE_READ_URL`), none granting the app role USAGE on a schema (USAGE for the read role is not reported) — and no grant to PUBLIC blocks it: per relation and grantee (the app role, PUBLIC, or a role it is a member of), a declared privilege missing, one held beyond the declaration, a declared one held `WITH GRANT OPTION`, a column grant; each managed schema it cannot use; each grant to PUBLIC from another grantor than the owner, which the app holds and which blocks `db grant`, with the `REVOKE` its grantor can run; apart, what it holds beyond its declarations as a member of a role `db grant` does not plan for or from another grantor, which `db grant` does not change; the number of managed tables it owns (declared, not enforced, and outside `db grant`: no statement on them for any role or PUBLIC, and nothing compared); and PUBLIC `CREATE` on schema `public` (PostgreSQL before 15). As the app role it cannot see the owner's side, so it does not say whether `db grant` would be blocked or PostgreSQL would refuse a statement — `db grant --dry-run` does; the human form and `--json` name the declaration read (`source`: `manifest src/server/drizzle/privileges.json` or `entities` — a manifest left behind decides over the entities, and `spfn db grant` prints the same line); `--json` carries it as `privileges` (`checked`, `source`, `checkedTables`, `ownedTables`, `drift: [{ schema, table, kind, grantee, through, missing, excess, grantOption, columns }]` (one entry per relation and grantee, so one table can appear more than once — key it by `schema`, `table` and `grantee`; `grantee` null for PUBLIC, `through` `member of <role>` for a role the app is a member of, `columns` as `update (amount)`), `schemasWithoutUsage`, `publicGrantsByOthers: [{ schema, table, privilege, grantor, statement }]`, `heldElsewhere: [{ schema, table, privilege, through }]`, `publicMayCreateInPublic`, `readRole` — `{ checked: false, detail }` when `DATABASE_READ_URL` is set and its role could not be looked up: the rest is then the app role's and PUBLIC's part, without what the app holds as a member of another role, and the human form says so instead of "holds what is declared"; `checked: false` with `detail` when it could not be read). `spfn dev`/`spfn start` refuse to start on a mismatch before spawning the server, whatever `--allow-pending-migrations` says; on any other read failure they print one line (`Could not check migrations: …`) and start |
| `db studio` | Open Drizzle Studio. `-p, --port` (auto-finds a free port) |
| `db check` | Verify the database connection |
| `db drop` | Drop all tables — **destructive**, double-prompts (see [Pitfalls](#pitfalls)) |
| `db backup` | Create a backup (`-f sql|custom`, `-o`, `-s`, `--data-only`, `--schema-only`, `--tag`, `--env`) |
| `db restore [file]` | Restore from a backup (`--drop`, `-s`, `--data-only`, `--schema-only`, `-v`) |
| `db backup:list` | List backups |
| `db backup:clean` | Prune backups (`-k, --keep <n>`, `-o, --older-than <days>`) |
| `db reindex` | Convert sequential migration prefixes to timestamps (`--dry-run`) |
| `db tenant export <tenantId>` | Write one tenant's rows of every tenant table to `backups/tenant-<id>-<time>/`: one `COPY` file per table and a `manifest.json`, read in one snapshot as the app (`DATABASE_READ_URL`, else `DATABASE_URL`) |
| `db tenant import <dir>` | Put an export's rows back in one transaction as the owner (`DATABASE_OWNER_URL`, else `DATABASE_URL`). Refuses when the tenant already has rows; `--replace` deletes them first |

#### Which connection each command uses

A database may have two roles: the **owner** (`DATABASE_OWNER_URL`), which creates and owns
every table, and the **app** (`DATABASE_URL`, and `DATABASE_READ_URL` for reads), which owns
none, so row-level security applies to it. Without `DATABASE_OWNER_URL` both are
`DATABASE_URL`, one role, and nothing below changes. A command that changes the schema or the
migration bookkeeping connects as the owner; one that checks what the app itself can see connects
as the app. The CLI keeps this choice in one table (`src/utils/database-connection.ts`), and every
command that opens a connection or writes a drizzle config reads its URL from it. Outside it: a
project's own `drizzle.config.ts`, which `db generate`, `check`, `drop` and `studio` hand to
drizzle-kit as it is; `spfn provision`, whose runner connects through `@spfn/core` as the server
does; and `db reindex`, which only reads the migrations folder.

| Command | Connects with | Why |
|---------|---------------|-----|
| `db push`, including `--dry-run` and the function package migrations it applies | `DATABASE_OWNER_URL`, else `DATABASE_URL` | runs DDL and writes the migration bookkeeping; the dry run plans as the role that will apply the plan, since drizzle-kit sees only the schemas its role may use |
| `db migrate` (and its `--with-backup`) | `DATABASE_OWNER_URL`, else `DATABASE_URL` | runs DDL and writes the migration bookkeeping |
| `spfn add <package>` | `DATABASE_OWNER_URL`, else `DATABASE_URL` | applies the package's migrations |
| `db grant` (and the privileges step of `db push`, `db migrate`, `spfn add`) | `DATABASE_OWNER_URL`, else `DATABASE_URL`; each app URL once, for its `current_user` | only a table's owner grants and revokes on it |
| `db backup`, `db restore` | `DATABASE_OWNER_URL`, else `DATABASE_URL` | `pg_dump` stops on, and PostgreSQL refuses `COPY FROM` into, a table whose policy applies to the role |
| `db drop` | `DATABASE_OWNER_URL`, else `DATABASE_URL` | only the owner may drop the tables |
| `db tenant import` | `DATABASE_OWNER_URL`, else `DATABASE_URL` | writes past the policy, checking the tenant column itself, and moves sequences |
| `db status`, the `spfn dev`/`spfn start` pre-start check | `DATABASE_URL` | reports the migrations the running app sees, with the app's privileges |
| `db studio` | `DATABASE_URL` | an interactive data tool stays under row-level security |
| `db generate`, `db check` | `DATABASE_URL`, written into the generated config | drizzle-kit connects to nothing here; the app's URL keeps the owner's out of the file |
| `db tenant export` | `DATABASE_READ_URL`, else `DATABASE_URL` | reads one tenant's rows under its policy |
| `spfn provision` | `DATABASE_URL` (or `POSTGRES_URL`), through `@spfn/core` | runs the app's lifecycle seeding as the server would |

No command prints either URL, and no child process is handed the owner's URL as `DATABASE_URL`.

Where `DATABASE_OWNER_URL` comes from, and who holds it:

| Source | owner command (`DATABASE_OWNER_URL` rows above) | any other spfn command (`db status`, `spfn dev`, …) | the server (`spfn dev`/`start`'s, or a custom entry) | `spfn provision` and `provisionInfrastructure` |
|--------|------|------|------|------|
| an `.env*` file | holds it | does not: the file's value is not loaded | does not: the file's value is not loaded | does not: the file's value is not loaded |
| the shell (or a container's environment) | holds it | does not: removed at the command's entry, silently | does not: removed at start, one warning | does not: removed at the CLI's entry, removed at start |

Each command loads the `.env` files through the table above: only the owner commands load
`DATABASE_OWNER_URL` from them (`@spfn/core`'s `loadEnv({ ownerCredentials: true })`). Every other
load — every other command, the server, provisioning, app code — leaves it out, and the first
in a process logs one line naming the file at `debug` (`SPFN_LOG_LEVEL=debug`; core's console
transport writes `debug` to stdout, so at that level `db status --json` prints that line before its
object). Nothing is wrong with the setup it reports: a file the CLI reads is a fine place for it. For local development keep it in `.env.server` (Next.js never
reads that file; it does read `.env` and `.env.local`), or export it in the shell you run
`spfn db` commands from. In production give it only to the migrate job's environment. Every
command that does not connect as the owner — `db status`, `db generate`/`check`, `db studio`,
`db tenant export`, `spfn dev`, `spfn start`, `spfn provision` — removes an inherited
`DATABASE_OWNER_URL` from its own process at its entry, before anything of it runs (the pre-start
check included), so no process it starts inherits it; `spfn dev` and `spfn provision` also keep a
keychain reference to it in `.env.server` out of their children's environment. That removal is
silent: exporting the variable is how you give it to the owner commands, so its presence in a
shell an app command runs from is nothing to fix. The server entries remove it from their own
environment with one warning about the environment they were started with: nothing should start
a server with it.

An owner command that **Kit** runs (`spfn kit install`'s `spfn db migrate`) does not get a
shell-exported `DATABASE_OWNER_URL`: Kit builds the child's environment from a fixed list of
names (`PATH`, `HOME`, the locale, …), and no database URL is on it. That child reads the owner's
URL from the project's `.env*` files only, so a project Kit migrates keeps it in `.env.server`.

A database whose tables the app role created — pushed through `DATABASE_URL` before `db push`
connected as the owner — has them owned by the app role, and `db push` now fails on them
(`Invalid query (42501)`; under it the remedy, with the role names and the tables the catalog
reports). Move them to the owner once: `REASSIGN OWNED BY <app role> TO <owner role>`; tables a
superuser's URL created (the bootstrap superuser, usually `postgres`, for which PostgreSQL refuses
`REASSIGN OWNED`) get one `ALTER … OWNER TO <owner role>;` each in the same remedy (the
`@spfn/core` db README,
[Database roles](../core/src/db/README.md#database-roles)).

> `db push` is for development. For production, use `db generate` + `db migrate` to keep
> migration history.

> **`db push` does not change an existing check.** Drizzle Kit's push creates a check the
> database lacks but never alters one whose expression changed (an `enumCheck` given another
> value). `db push` and `--dry-run` name each existing check whose declared expression
> PostgreSQL reads differently from the stored one — `differs from the one in the database:
> PostgreSQL reads the two expressions differently` — with the remedy (`db generate` + `db
> migrate`, or drop it and push again), and leave it. The comparison is the planner's print of
> both expressions (`EXPLAIN (VERBOSE)`, which runs nothing; one statement per existing
> check), not their meaning: a numeric literal written with another scale (`amount > 1`
> against a stored `amount > 1.0`) is named on every push although it means the same, and a
> rewrite the planner folds (`x > 0 AND true` against a stored `x > 0`) is not named, as it
> means the same. PostgreSQL offers no exact form without a write. For an `enumCheck` whose
> stored check `enumCheck` also wrote, the comparison is exact: it names the check exactly
> when the value set changed. A declared check that names a column the table does not have
> yet (one this push adds) differs, and is named so; one PostgreSQL cannot read against the
> table for another reason is named as `could not be compared`, with the error.

**One tenant out and back in.** `db tenant export` and `db tenant import` move the rows of
one tenant across every tenant table — a `tenancy.table` and a `tenantKey()`-only table
alike — and nothing else: not the tenant list row, not auth data.

```bash
spfn db tenant export 42
# → backups/tenant-42-2026-11-01_100000/  manifest.json, acme_notes.authors.copy, acme_notes.notes.copy
spfn db tenant import backups/tenant-42-2026-11-01_100000            # into a database without tenant 42's rows
spfn db tenant import backups/tenant-42-2026-11-01_100000 --replace  # replacing them
```

The import refuses, writing nothing, when a file does not match its sha256, the target
tables' columns differ from the export's, the tenant is not in its tenant list table
(create it first), a row belongs to another tenant, or a foreign key fails. A failed
statement is printed as `db push` prints one: the error, then the statement (a `COPY` of
the plan's identifiers); a file value a column cannot take also names the file and the
COPY line (`   In: tenant file acme_notes.notes.copy`, `   At: COPY spfn_tenant_import_1,
line 3`), never the value. Sequences move
forward past the imported ids, never back. To put one tenant back to an earlier point in
time: restore a copy of the database to that point (outside spfn), export the tenant from
the copy, then `import --replace` into production; the other tenants' rows stay as they are.

**Which files are the schema.** `db push`, `db generate` and `db studio` resolve the
project schema in the same order:

1. `db push --schema <path>`: a file, a directory or a glob.
2. `./drizzle.config.ts`, when the project has one: its `schema` entry, and for `db push`
   a non-empty `schemaFilter`.
3. Every entity file under `src/server/entities/`, barrel files (`index.*`, `config.*`)
   excluded.
4. The registry — `src/server/entities/config.ts`, or the file `DRIZZLE_SCHEMA_PATH`
   names — loaded alone, in two cases: the scan finds no entity file (the folder holds
   only the registry and the tables live elsewhere), or the registry exports a table,
   enum, view or sequence none of the scanned files define while the folder defines
   nothing the registry lacks (the tables moved out and a re-exported file was left
   behind). The command says which and names the objects. A registry whose objects
   are all among the scanned files (the scaffold) changes nothing. When each side
   defines objects the other lacks, no choice keeps every table, so the command stops
   and names both sets: re-export the folder's entities from the registry, move the
   leftover files out, or name the schema in `drizzle.config.ts`.

An entry named through 1–2 is expanded the way drizzle-kit expands it and nothing is
filtered: a file is loaded as-is, a directory is read one level deep, a glob uses glob
syntax (`**`, `*`, `?`, `{a,b}`, `[…]`) with parentheses taken literally, so
`src/server/(workspace)/entities/*.ts` works, and a directory the glob matches is read
one level deep. Symlinks are followed (a link cycle ends where a directory was already
visited); a walk skips dot-directories like drizzle-kit's glob does. The accepted
extensions are drizzle-kit's (`.ts .mts .cts .tsx .js .mjs .cjs .jsx`). Two deliberate
differences: declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are skipped, and a walk
never enters `node_modules`, so a `**` pattern cannot pull a dependency's file into
the schema. A registry loaded as-is (2 or 4) contributes only what it exports:
re-export with `export *` so a `pgEnum` or `pgSchema` defined next to a table comes
along. `db push` diffs the PostgreSQL schemas the declared `schemaFilter` names (else
`public`) plus every schema the loaded modules name — tables, `pgSchema()` objects,
enums, views, sequences; `--schema` replaces the files but keeps that declared filter,
and a `drizzle.config.ts` that cannot be loaded stops push, `--schema` or not.

**A function package's own schema is never the project's.** An installed package that
ships migrations (`@spfn/auth` → `spfn_auth`) creates and alters its own tables when
`db push` or `db migrate` runs its migrations, so the project never diffs or generates
them. Whichever files are loaded, `db push` drops the objects living in such a schema
from the diff and leaves that schema out of the filter it derives — a registry that
re-exports one package table for a relation no longer proposes `DROP TABLE` for the
package tables it does not re-export. A `schemaFilter` declared in `drizzle.config.ts`
still stands verbatim; naming a package schema there is the user's own choice. Schemas
the project itself owns (`pgSchema('billing')`) are unaffected: they are created and
diffed as before.

`db generate` cannot be filtered the same way — drizzle-kit loads the schema files
itself and its `generate` reads no `schemaFilter` — so it stops instead when the files
it would read reach a package's objects:

```
❌ The schema read from entity registry ./src/server/entities/config.ts reaches
   users (@spfn/mockfn), which the package migrates itself. …
```

Keep package re-exports out of the registry: a relation can `import` the package's
table and reference it without re-exporting it.

Earlier releases gave `db push` the folder scan alone, so a project whose tables lived
outside `src/server/entities/` and were re-exported from the registry pushed nothing
(`No schema files found`), and a project with a `drizzle.config.ts` had `db push` and
`db generate` reading different files. `db push` prints which source it used, exits 1
when a path named through 1–2 has no schema files, and exits 1 when `drizzle.config.ts`
cannot be loaded rather than pushing something `db generate` would not read. One
consequence for code calling `getDrizzleConfig({ schema, expandGlobs: true })`
directly: an explicit glob is no longer barrel-filtered, so a glob that matches both a
barrel and the files it re-exports now makes drizzle-kit report a duplicate table, as
it would for the same glob in a hand-written `drizzle.config.ts`.

**A server refuses to start while migrations are pending.** Bumping `@spfn/auth` and
skipping `db migrate` used to boot fine, pass the health check, and then fail every
request that touched a new column as an opaque 500. `spfn dev` and `spfn start` now
compare the migrations each installed function package ships (and `src/server/drizzle`,
where present) against what the database records as applied, print the ones still
waiting, and stop:

```
❌ Refusing to start: 1 pending migration(s) in @spfn/auth
   @spfn/auth: 1 pending migration(s) (12/13 applied)
       - 20260805143152_client_identity

   Run: pnpm spfn db migrate
```

`--allow-pending-migrations` starts anyway and logs the same list as a warning.
`SPFN_ALLOW_PENDING_MIGRATIONS=true` does the same where no flag can be passed — a
container's env, a CI job. The check is skipped when the app initializes no database
or no package ships migrations, and a database it cannot reach is reported as
"could not verify", never as drift.

`db push` and `db migrate` also replay migrations shipped by installed SPFN function
packages (`@spfn/auth`, `@spfn/cms`, …) into per-package tracking tables
(`drizzle.__spfn_fn_<pkg>_migrations`). The CLI applies these with a built-in runner
that reads both migration layouts — drizzle-kit ≤0.31 (`NNNN_name.sql` +
`meta/_journal.json`) and drizzle-kit 1.0 (`<timestamp>_name/migration.sql`) — so a
package's layout never has to match the CLI's bundled drizzle version. A migration is
pending when it is newer than the package's last record — the newest `created_at` in its
own table or, while that table is missing or empty, the newest of its migrations recorded
in the shared `drizzle.__spfn_fn_migrations` table that earlier CLI versions wrote. That
legacy table is read, never written or dropped, so the records of a package installed or
updated later stay where they were. The rule lives in `@spfn/core/db`
(`pendingFunctionMigrations`); `db status`, the boot gate, health, the `db push` preview
and every apply (`db push`, `db migrate`, `spfn add`) all use it. `db push`
validates every package's migration folder, plans both halves read-only, asks about
destructive project statements (No skips the listed statements, and the other project
statements and the package migrations still apply; Ctrl-C or EOF at the question exits 1
with nothing applied; a non-interactive run — stdin not a terminal — without `--force`
exits 1 before any write when a destructive statement is pending, and applies as usual
when none is), then applies each package's pending migrations (one
transaction per package, as `db migrate`) and then the project statements (one
transaction). A project table may reference a package table on an empty database. A
package failure exits 1 with the project schema untouched; a project failure exits 1,
and the package migrations this run applied stay committed (it says so when there are
any). Before applying anything,
`db push` lists each package's pending migrations by folder or tag name;
`db push --dry-run` lists them too and applies neither them nor the project
statements. What it guarantees, and how: every query of its plan — Drizzle Kit's
diff and the pending lookup — runs on one connection in a `BEGIN READ ONLY`
transaction of its own, rolled back as soon as the query ends. The queries take
turns on the connection, so no two transactions overlap, and a lock a query takes
is released when it ends: a dry run holds no lock between statements, and one
that meets a table a migration has locked waits for it holding nothing else.
Before planning it reads `current_setting('transaction_read_only')` inside such a
transaction; anything but `on` (a pooler or proxy that rewrote the `BEGIN`) ends
the command with exit 1 naming `--dry-run`, before any plan query runs. The mode is a statement, not a
startup parameter, so a pooler that drops startup `options` does not remove it.

Database TLS is controlled by `DATABASE_URL`. Loopback URLs (`localhost`, `127.0.0.1`,
and `::1`) default to `ssl: false`; add an explicit `sslmode` when the local server uses
TLS. For a TLS connection with a self-signed certificate, set
`SPFN_DB_INSECURE_TLS=1` to disable certificate verification. This opt-in never enables
TLS by itself and `sslmode=disable` remains authoritative.

### `spfn env`

Schema-driven environment variable tooling. Routes vars to the right file: `NEXT_PUBLIC_*`
→ `.env`/`.env.local`, server vars → `.env.server`.

Without `-p`, every subcommand reads the **whole-app list**: the app's own schema modules
named in `spfn.config.js` under `env.schemas`, then every installed `@spfn/*` package whose
`./config` exports `envSchema` (found through the app's `package.json`, resolved from the
project root). Output is grouped by the source that declares each variable.

```js
// spfn.config.js
export default {
  env: {
    // Modules exporting `envSchema`, relative to the project root.
    // TypeScript and tsconfig path aliases load the way `spfn dev` loads them (tsx).
    schemas: ['src/server/config/env.config.ts'],
  },
};
```

A variable declared by two sources alike is listed once. Two sources that declare it with a
different type, `required` or `sensitive` are an error naming the key and both sources. A schema path that does not exist, or a
module without an `envSchema` export, is an error naming the path. Top-level `env` is not
`deployment.env`: the latter holds values to inject, the former says where the schemas are.

| Subcommand | Description |
|------------|-------------|
| `env list` | List vars from the schema (`-g` groups by target file) |
| `env stats` | Show variable statistics |
| `env search <query>` | Search vars by key or description |
| `env init` | Generate `.env` template files (`-e <env>` for per-env, `-f` to overwrite) |
| `env check` | Check `.env` files against the schema (`-e <env>` for a full env chain) |
| `env validate` | Validate `process.env` against the schema — for CI/CD (`-e <env>`, `-s` strict) |
| `env audit` | Find direct `process.env` reads and app variables nothing reads; exits 1 on findings |

All but `env audit` accept `-p, --package <pkg>` to read that one package only (`env validate` uses
`-p, --packages <pkgs...>`).

**Audit.** `spfn env audit` prints `file:line  NAME  reason` — names only — and exits 1 when
it finds any of:

- a direct read — `process.env.X`, `process.env['X']`, `process.env[expr]`,
  `const { X } = process.env` — outside the `env.schemas` modules, root-level
  `*.config.{js,cjs,mjs,ts}` files and `env.audit.ignore` (`NODE_ENV` is always allowed);
- a name in the app's own schemas that no scanned file reads as a property (`env.X`), a
  destructured key or a string literal, and that has no `readBy` (see the `@spfn/core/env`
  README); a `readBy` file that does not exist or is not scanned. Skipped, with a notice,
  when `env.schemas` is not set.

A list that cannot be built — a missing schema module, or a name declared differently by an
app schema and a package — is reported and exits 1.

```js
// spfn.config.js
export default {
  env: {
    schemas: ['src/server/config/env.config.ts'],
    audit: {
      include: ['src'],             // default — directories or globs from the project root
      ignore: ['src/**/*.test.ts'],
    },
  },
};
```

`node_modules`, build output, `*.d.ts` and symbolic links are never scanned. Sources —
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` — are parsed with TypeScript,
taken from the app, else from the CLI's optional peer, else from `@spfn/core`.

### `spfn key [preset]`

Generate cryptographically random secrets (base64url, 256-bit default).

```bash
spfn key                       # generic 256-bit secret
spfn key auth-encryption -c    # preset key, copy to clipboard
spfn key --list                # list presets
spfn key gen -b 64             # raw value only, no metadata (alias of `key generate`)
```

Presets: `auth-encryption`, `nextauth-secret`, `jwt-secret`, `session-secret`, `api-key`.
Options: `-l, --list`, `-b, --bytes <n>` (1–128), `-e, --env <name>`, `-c, --copy`.
The command prints the value to stdout for you to paste into an env file — it does **not**
write any file.

### `spfn secret`

Unified secret management: local secrets live in the OS keychain, deployed secrets in
encrypted SOPS files. The runtime never sees a reference — `spfn dev` injects local
values into the server process and GitOps injects them in production, so the app always
reads plain `process.env`.

| Subcommand | Description |
|------------|-------------|
| `secret set [key]` | Store a value (masked prompt, or `--stdin`). `--env local` → keychain; other envs → SOPS |
| `secret list` | List declared secrets and their status per env; names in a deployed file that the list lacks show as "not in list" (never prints values) |
| `secret generate [key]` | Mint values for schema secrets with a `generate` strategy (`-a/--all`) |
| `secret rotate [key]` | Rotate values; external secrets are flagged for manual reissue (`-a/--all`) |
| `secret keygen` | Generate an age key pair for the SOPS no-cloud backend |
| `secret recipients <add\|remove\|list> [age1…]` | Manage `.sops.yaml` recipients + re-encrypt |
| `secret check` | Static lint — flag plaintext secret leaks; with a deployed `--env`, names outside their declared layer or in both files |
| `secret export` | Decrypt and merge one deployment's layers into a 0600 dotenv file (prints names only) |

Options: `-e, --env <env>` (`local` default; also `development`/`staging`/`production`),
`-i, --instance <name>` (one instance of a deployed environment: `secrets/<env>.<instance>.enc.json`;
lowercase letters, digits and dashes), `-p, --package <pkg>` (read that one package's
schema; without it, the whole-app list described under `spfn env`).

**`--stdin`.** `spfn secret set --stdin --env staging SIGNING_KEY < key.pem` stores the
whole of stdin as the value — one trailing newline dropped, inner newlines kept — for
local and deployed targets alike. It never prompts, and refuses a terminal on stdin.
Shaped values such as key pairs come from the app's own command, piped in.

**Layers.** A schema entry's `layer` (`'environment'` or `'instance'`) pins where a
deployment's value must live; unset, the value may come from any layer. Without
`--instance`, `set`/`generate`/`rotate`/`list` on a deployed environment work on
`secrets/<env>.enc.json`; with `--instance blue`, on `secrets/<env>.blue.enc.json`. A named
key declared with the other layer is refused; a key without `layer` is accepted by either.
`--all` (and `list`) takes the names declared with the target's layer, and names without
`layer` on the environment target only — so `--all --instance blue` never fills an
instance file with names every instance shares. To give each instance its own value of
such a name, set it by name with `--instance`.

**Export.**

```bash
spfn secret export --env <env> [--instance <name>] [--with <file>]... --out <file>
```

Decrypts `secrets/<env>.enc.json` and — with `--instance`, when it exists —
`secrets/<env>.<instance>.enc.json`, reads each plaintext `--with` dotenv file (computed
instance values such as port and URLs), and writes the merge to `--out`. Only names in the
whole-app list are written; an unlisted name in an encrypted file is a warning by name.
The export fails, writing nothing, when a required name is in no layer, a name is in two
layers, a name declared `instance` is in the environment file, a name declared
`environment` is in an instance layer, a value fails its validator (the error names the variable and the
reason, never the value), or decryption fails. `--out` is required and its directory must
exist; relative paths resolve from the working directory. The file is created 0600 beside
the destination and renamed over it, so a failure leaves the previous file untouched
(POSIX only — Windows does not enforce the mode).

**SOPS rules for instance files.** The rule `spfn secret recipients add` writes,
`secrets/.*\.enc\.json$`, already covers `secrets/<env>.<instance>.enc.json`. A project
with per-environment rules needs each to accept the instance form too, e.g.
`path_regex: secrets/production(\.[a-z0-9-]+)?\.enc\.json$`. Writes need sops 3.10 or
later (`sops encrypt` from stdin, `sops set --value-stdin`), so a value never appears as a
process argument.

**Local (keychain).** `spfn secret set DB_URL` stores the value in the OS keychain
(macOS `security`, Windows Credential Manager via optional `@napi-rs/keyring`, Linux
libsecret) and writes a `secret:keychain:spfn_DB_URL` reference into `.env.server`. The
reference is not sensitive; the real value never lands in the repo. `spfn dev` resolves
and injects it. Note: injection happens only when the server is started via `spfn dev` —
running the app another way (a bare `node`, tests) would see the raw reference, so use
`spfn dev` locally (a runtime resolver for other runners is planned).

**Deployed (SOPS).** `spfn secret set DB_URL --env production` writes the value into
`secrets/production.enc.json`, encrypted by SOPS. The backend (age / GCP KMS / AWS KMS)
is chosen by `.sops.yaml` creation rules — KMS needs no local key file (IAM + cloud
auth), age is the no-cloud fallback (`secret keygen` + `secret recipients add`). Commit
the encrypted file; your GitOps step decrypts it into env at deploy time. `sops`/`age`
are needed only for the deployed envs, never for local keychain use.

Schema-driven: a secret declared with `envSecret({ generate: 'base64url32' })` can be
minted/rotated automatically (`secret generate`/`rotate`); one without `generate` is an
external value you paste in (`secret set`).

### `spfn cloud`

Free-tier management for apps deployed to your own **Vercel Hobby + Supabase Free**
accounts: see the plan limits, watch live usage against them, keep the Supabase
project from pausing, and sync env vars/API keys. Account tokens and key values live
in the OS keychain and never appear in command output.

| Subcommand | Description |
|------------|-------------|
| `cloud link` | Connect accounts: Vercel access token + Supabase personal access token (masked prompt or `VERCEL_TOKEN`/`SUPABASE_ACCESS_TOKEN` env), pick the project on each side. Identifiers land in gitignored `.spfn/cloud.json`; tokens go to the keychain |
| `cloud limits` | The free-plan limits (constants verified against the official docs, date shown) — works before `link` |
| `cloud usage` | Current usage: Vercel billing feed (rolling 30 days), Supabase DB size + last-24h API requests |
| `cloud status` | Usage measured against the limits on one screen; items at ≥80% get a migration warning |
| `cloud keepalive` | Daily cron hitting `/api/backend/_core/health?detailed=true` (the detailed check runs a DB query, which is what prevents the ~7-idle-day pause). Vercel cron by default; `--github-actions --url <deployed-url>` for a workflow instead |
| `cloud env pull` | Supabase keys → local: project URL + anon key into `.env.local`, service-role key into the keychain (`.env.server` gets a reference). `--db-url` also composes `DATABASE_URL` (prompts for the DB password) |
| `cloud env push KEY…` | Push local env values to the Vercel project env by name. Values resolve from `.env`/`.env.local`/`.env.server`+keychain; everything is sent encrypted except `NEXT_PUBLIC_*` |

Free-tier behavior worth knowing (also printed by `cloud limits`): Vercel Hobby
allows one cron at most once per day and pauses a capability when its rolling
30-day limit is hit (it never bills); Supabase Free quota is summed per
organization (except DB size), and org totals like egress/MAU have no public API —
`cloud status` shows per-item numbers and points at the dashboard for the rest.
Hobby is limited to personal, non-commercial use — a monetized app needs Vercel Pro
or a migration off the free tier.

### `spfn setup icons`

Install and configure SVGR for SVG-as-component imports (Next.js only).

### `spfn ops`

Invoke a running app's ops surface — the routes it exposes with
[`createOpsRouter`](../core/README.md#how-do-i-operate-the-app-from-the-terminal).
Commands are discovered from the app's `GET /_ops/_manifest`, so nothing is generated or
configured locally.

```bash
spfn ops list --app https://api.example.com           # what can this app do?
spfn ops call listSignups --query limit=50            # invoke a command
spfn ops call refundOrder --param id=42 --data '{"reason":"duplicate"}'
spfn ops call listSignups --describe                  # what does it take?
```

`--describe` answers from the manifest's schemas, so the usage is the running app's own,
not a local copy that can drift:

```
listSignups  GET /_ops/signups

  query parameters (--query)
    limit  number  optional  1–100, default 10
    state  string  required  one of: pending, approved

  Invoke: spfn ops call listSignups --query limit=<value>
```

Add `--json` for the raw JSON Schema. The server still validates every call — `--describe`
reports what it will accept, and the app's answer decides.

#### Capability modules

An app can also mount ops commands a package described, with
[`defineOpsModule`](../core/README.md#can-a-package-ship-ops-commands). Those commands are
named `<module>.<command>` and carry a summary, an effect and their scopes, so the CLI can
group them and say what each one does. From **0.3.0-beta.5**:

```bash
spfn ops modules                                      # what is mounted, and from where
spfn ops modules --json                               # same, machine-readable
spfn ops list --module ledger                         # just that module's commands
spfn ops call ledger.compact --yes                    # effect=destructive needs this
```

An app's own command can carry an effect and a summary too, declared on its route with
`.effect()` and `.summary()`; `spfn ops list` and `--describe` show them, and an app command
announcing `read` or `write` needs no `--yes`. A CLI at 0.3.0-beta.15 or older does not
know app commands carry them: it warns that such a command "names no usable module" and
asks for `--yes` on it, so upgrade the CLI together with `@spfn/core`.

`spfn ops call` refuses a command the app declared `effect: destructive` unless `--yes` is
given. It refuses the same way when the app announced module metadata this CLI could not
validate: the effect is then unknown rather than absent, and an unknown effect is not
treated as a safe one. The command still lists — an operator reading a short list would
otherwise take it for the app's whole surface — and the warning names what was dropped.

Everything in the manifest is the app's own text written to your terminal, so control
characters in it are replaced before anything is printed.

The app URL comes from `--app` or `SPFN_OPS_APP`, and it must be **https** — every one of
these commands carries a secret, and `token issue` carries an administrator's password.
`http` is accepted only against `localhost`, `127.0.0.1` and `::1`, where there is no
network to listen on. A URL with a base path (`https://example.com/api`) is kept whole:
both the ops calls and the administrator sign-in go through it.

The ops token resolves `--token` → `SPFN_OPS_TOKEN` → macOS keychain, and its lifecycle is
managed with:

```bash
spfn ops token issue --name laptop --scopes 'waitlist:read' --app <url>
spfn ops token issue --name ci --scopes '*' --no-expiry --to-keychain --app <url>
spfn ops token list --app <url>
spfn ops token revoke <id> --app <url>
spfn ops token store --app <url>      # hidden prompt → keychain
spfn ops token forget --app <url>
```

`issue`, `list` and `revoke` call the app's own admin-only routes, so the CLI prompts for
an administrator's email and password first — no database access. A token works only while
the administrator who issued it is active and may still issue tokens (`ops:token:issue`). Only the token's SHA-256
hash is ever stored, so the secret exists in the clear once, in the issuance answer;
`--to-keychain` delivers it without printing it.

`--expires-days` takes 1 to 36500 days (about a century), or `--no-expiry` for a token that
never expires. The upper bound is there because a day count becomes a date by arithmetic,
and a big enough count produces an invalid date rather than a distant one.

SPFN authenticates a request with a JWT the client signs itself, so the CLI generates a key
pair for the command, signs the one call it needs, and revokes the key before the command
ends — on the failing path as much as the succeeding one. Nothing is written to disk.

These three commands need `@spfn/auth` **0.3.0-beta.2 or later** installed in the app: the
ops token lives in its schema, and the signing comes from its `@spfn/auth/crypto` entry
point, which that release added. The CLI does not depend on the package in any form — it
loads it from the app at run time, and tells a missing package apart from one too old to
carry the entry point, so the message names the thing to do.

Because the package is the app's, it is resolved **from the directory the command runs in**.
Run `spfn ops token` from the app's root; running it elsewhere reports the package as
missing, and the message names the directory it looked in.

#### Can I call a surface from my own code?

Yes — the client `spfn ops` runs on is a library export, `spfn/surface`, and it reaches any
namespace a [`defineSurface`](../core/README.md#can-a-second-surface-sit-beside-_ops)
serves, not only `/_ops`:

```typescript
import { createSurfaceClient } from 'spfn/surface';

const client = createSurfaceClient({
    appUrl: 'https://app.example',
    namespace: '/_app',                               // manifest at /_app/_manifest
    token: async () => issueToken(),                  // string | () => Promise<string>
    onWarning: message => console.error(message),    // dropped commands; default: silent
});

const manifest = await client.manifest();
const usage = client.describe(manifest, 'pageAdd');  // the --describe text
const answer = await client.call('pageAdd', { params: {}, query: {}, body: { title: 'Hello' } });
// answer: { status, body } — the app's answer, relayed
```

Each command carries the `effect` and `summary` the app declared, so your code can tell a
read from a write before it calls; `call()` itself makes no decision on them. It keeps
every check `spfn ops` makes: the manifest's shape, each command's path staying under
`<namespace>/`, module and command metadata, and path parameters that would decode into a dot
segment. `appUrl` must be https (`http` only against a loopback host) — refused when the
client is created, with a thrown `Error`. A manifest request that does not answer 200
throws a `SurfaceManifestError` carrying the `status`. The library prints nothing and does
not load the CLI's terminal stack; `spfn ops` is this client on `/_ops` with its own
printer.

The `spfn` package has an `exports` map: `spfn` (the CLI's index), `spfn/surface`, and
`spfn/package.json`. No other path inside the package is importable.

### `spfn kit`

Install, verify and update a **Superfunction Kit** — a licensed product that ships as a
signed release: an SPFN scaffold, an exact dependency graph, files the Kit manages on the
customer's behalf, and its own tooling. `spfn kit` is the generic installer for all of
them. It hard-codes no product: which Kit, which packages and which files are managed all
come from the signed setup descriptor and release manifest, and every judgement specific to
a product comes from that product's own `/tooling` entry, which the CLI *discovers* among
the packages the manifest installs.

There is one binary and one command group. No Kit gets its own CLI.

| Subcommand | Description |
|------------|-------------|
| `kit install <setup-url> <dir>` | Install the newest entitled stable release into a new or empty directory: verify the setup link, activate the license, create the SPFN base, materialize the managed files, install the exact graph, run migrations, run the gates, write the lock and make the first commit |
| `kit restore` | Reinstall the exact release a clean clone records, using the committed lock and this machine's credential. Rewrites no source file |
| `kit status` | Read-only report: installed release, activation, credential, managed drift, migrations, open operation. Anything the CLI could not determine is reported as `unknown` |
| `kit check` | Read-only contract check with stable diagnostic codes, the path each is about, and the command that would fix it |
| `kit plan [--to <release>]` | What an update would change, with the approval digest. Writes nothing |
| `kit update [--to <release>] [--approve-plan <digest>]` | Update through the signed update edges, then gates, lock and commit |
| `kit resume [operation-id]` | Continue an operation that stopped — after re-reading the project and confirming the recorded checkpoints still hold |
| `kit abandon [operation-id]` | Record that an operation will not be finished, and report what it left behind. Deletes and rolls back nothing |

**Secrets never travel as arguments.** There is no `--license-key <value>` option, by
design: a secret on a command line is in the process table, the shell history and every log
that records an argv. A key arrives either through a masked prompt or through
`--license-key-stdin`. Once activation succeeds the key is discarded and only the local
credential the server issued remains, in the OS keychain under its own service
(`superfunction.spfn.kit`), separate from the env secrets `spfn secret` manages. The
short-lived registry session is handed to the package-manager child process in its
environment and nowhere else, as npm configuration addressed to the registry it opens
(`npm_config_//host/npm/:_authToken`). The committed `.npmrc` maps the release's scopes to
that registry and carries no credential at all — not a value, and not a variable naming
one: pnpm 10 and later ignore a credential that reaches them from a project `.npmrc`, because that
file is committed and a hostile edit could send the secret to another registry.

**`--json` is the agent surface.** Every subcommand takes it, prints newline-delimited
events with a stable `code`, `phase` and safe next command, and never opens a prompt. A
JSON-mode command that needs a secret exits `2` and reports `input: masked-stdin`.

| Exit | Meaning |
|-----:|---------|
| `0` | Completed, or an idempotent no-op |
| `2` | Waiting for a person: a secret on stdin, or an exact plan approval |
| `3` | Recoverable failure — `spfn kit resume` can continue it |
| `4` | Refused before any write: drift, compatibility, entitlement or a busy project |
| `5` | An external service could not be reached |
| `10` | This CLI and the release speak different protocol versions |

**What an install does not do.** It stops at a verified local repository: no cloud account
is linked, nothing is pushed, nothing is deployed. That is a checkpoint for the agent to
continue from, not a finished product install.

**Approval is exact.** A breaking release or an external effect requires the digest of the
very plan being run (`--approve-plan`), which can only be obtained by reading the plan.
There is no blanket `--yes`.

**One operation at a time.** A project holds a filesystem lock while a write operation
runs. A lock left behind by a dead process is not simply deleted — it is reconciled against
the operation journal, and reclaimed only when that journal agrees the work is over or the
caller is resuming exactly the operation it belongs to.

Generated state lives under `.spfn/`: `license.json` and `kit-lock.json` are committed and
hold public identifiers only; `operations/` is per-machine and gitignored.

**Exactness is proved, not assumed.** Before the package manager runs, every package the
signed manifest names is fetched through the licensed registry proxy and checked twice: the
version's integrity against the digest the manifest pinned, then the bytes that actually
arrived against that same digest. The first says the registry agrees with the release; only
the second says the file on this disk is the file the release described. The project's base
arrives the same way — one scaffold archive, verified against the manifest's integrity
before a single file is expanded, and refused outright if it names a path that would leave
the project directory or overwrite a file that is already there.

**An artifact is written as what it is.** A managed bridge is a file, and its
bytes are the file. The scaffold and the Agent Pack are archives, and the CLI expands them —
the pack into `.spfn/agent-pack/`, because a release's guides, schemas and checklists are a
directory and belong to the release rather than among customer source. Both are proven
against the manifest's digest before they are opened, and both refuse an entry that is a
symlink or that would be written outside the project. What the pack expanded to is recorded
in `.spfn/agent-pack.json` so drift can compare the tree file by file.

**A materialize that stopped can be resumed.** Coming back to a half-written tree compares
rather than overwrites: a file already holding exactly the bytes the release would write
counts as done and the resume continues past it, and a file holding anything else is refused
with that file left exactly as it was found. An update is the one operation that replaces —
and only after drift has already been refused, so every managed file is known to hold the
previous release's bytes rather than somebody's edit.

**Release files are paid content, and are fetched as such.** Managed files, agent packs and
the scaffold archive go out with the same bearer the private registry takes, and a refusal
comes back in the same vocabulary — so "this machine's credential has been replaced" never
arrives disguised as "that file is missing". The setup descriptor, the release catalog and
the manifests stay public and carry no bearer: they are locators and promises about a
release, and nothing anyone paid for is inside them.

**Credentials rotate before they expire, not after.** A local credential opens the registry
for a limited window. When that window is close to closing, the CLI asks the control plane
for a replacement and writes it to the keychain *before* using it — a rotation that was not
recorded can never have happened. A credential another machine has already replaced is
reported as stale rather than as missing: the two mean different things, and only one of
them means someone else's machine changed.

**Nothing secret is ever an argument.** That now includes the keychain write itself: the
`security` command goes in on stdin and the value goes in hex-encoded, so a local `ps` sees
`security -i` and nothing else. It also means a keychain item can hold a value a quoted
command line could not have carried at all, such as a multi-line key.

**Machine-local state stays local.** `spfn kit` writes `.spfn/.gitignore` covering
`operations/` the moment it creates that directory — in its own directory, never in the
project's root `.gitignore`, which belongs to the customer. Without it a release whose
scaffold forgot the rule would commit an operation journal and a lock naming the machine's
hostname and process id.

All ten places `spfn kit` touches the outside world are real implementations now. Six reach
the network or a release artifact — signed catalogs and manifests, licence activation,
credential rotation, the registry proxy, release artifacts and the scaffold — and four run
something on this machine: `pnpm install --frozen-lockfile`, the migrations through
`spfn db status --json` and `spfn db migrate`, the release's gates as the project's own
scripts, and Git for `init`, `status` and the first commit. Nothing else: no remote is
added and nothing is pushed.

The migration step waits (`KIT_WAITING_DATABASE`) only while no database is configured or
reachable. When `spfn db status --json` reports `reason: "bookkeeping-mismatch"`, the step is
refused instead — `CLI_MIGRATION_BOOKKEEPING_MISMATCH`, exit 4, with the mismatch's text as
`evidence.detail` — because waiting changes nothing until the bookkeeping is fixed by hand.
When it reports `reason: "permission-denied"` — before migrating or in the read after — the
step is refused with `CLI_MIGRATION_STATUS_UNREADABLE`, exit 4, `evidence.reason:
"permission-denied"` and PostgreSQL's message as `evidence.detail`: the app role cannot read
schema `drizzle`, and until spfn grants it (it does not yet) the remedy is the hand SQL in the
`@spfn/core` db README, "Database roles", run as the owner; then `spfn kit resume`. A status
that cannot be read after migrating for any other reason is `KIT_MIGRATION_FAILED` (resumable),
never success, and the step's re-check on resume and the `db-status` gate fail on an unread
status with the reason instead of reading its empty `pending` list as "nothing pending".

What still stops a real install is the trust root. The list of keys this CLI will accept a
signed release from is **empty in this build**, because the release signing key is not
published yet — so every signed document fails verification with `KIT_MANIFEST_INVALID`,
which is the correct behaviour for a CLI that cannot yet tell a real release from a forged
one. `SPFN_KIT_TRUSTED_KEYS` supplies a list for a staging run or a release rehearsal, as a
JSON array of `{ "keyId", "publicKey" }` with base64 SPKI keys. It *replaces* the built-in
list rather than adding to it.

`SPFN_KIT_SETUP_ALLOWLIST` names the origins a setup link may be fetched from, as a
comma-separated list of bare origins. It follows the same rule as the key list — it
*replaces* the shipped one, so it can only ever narrow what this CLI will fetch a descriptor
from — and it is the one place plain `http` is accepted, for `localhost` and `127.0.0.1`
only, matched literally so a name like `127.0.0.1.example.test` is not one of them. A path,
a query, a fragment, userinfo, or a non-loopback `http` entry makes the whole variable
invalid rather than being quietly trimmed. A setup link may carry an explicit port, which is
what lets a certification environment serve one; the link itself must still be `https`
unless its origin is loopback *and* on the list.

`SPFN_KIT_CONTROL_PLANE_URL` and `SPFN_KIT_REGISTRY_URL` point a project that has *not yet
been activated* at a staging or local control plane. They are ignored once it has: the
addresses a checkout recorded when it was licensed are the addresses it keeps, so a stray
shell variable cannot move an activated project onto another service.

`status` and `check` never depend on any of it: an unreachable remote must not hide local
state, so they read the lock, the license file, the drift and the open operation from disk
and report everything else as `unknown`.

The command surface, journal, lock, keychain, verification and the whole install →
activation → exact frozen install → restore path are exercised in `test/kit/`: the remote
half against a loopback HTTP fixture answering with the licence service's and the registry
proxy's own statuses and error bodies, the scaffold against real archives on real temporary
directories, and one integration case that runs the whole install with pnpm resolving from
a registry on 127.0.0.1, the gate as a real child process and a real Git commit at the end.

---

## Scaffold structure

Both modes produce the core full-stack skeleton:

```
src/
  app/api/rpc/[routeName]/route.ts   # RPC proxy — re-exports { GET, POST } from @spfn/core/nextjs/server
  generated/route-map.ts             # generated by codegen (run `spfn codegen run` if missing)
  lib/
    api-client.ts                    # createApi<AppRouter>() — the type-safe client
  server/
    router.ts                        # defineRouter({ ...routes }) → export type AppRouter
    server.config.ts                 # defineServerConfig().port(8790).host('0.0.0.0').routes(appRouter)
    config/env.config.ts             # environment schema
    entities/                        # Drizzle tables (example.entity.ts, config.ts)
    repositories/                    # BaseRepository subclasses (example.repository.ts)
    routes/                          # route DSL handlers: root.ts, health.ts, examples.ts
    tsconfig.json
.spfnrc.ts                           # codegen config (route-map generator)
spfn.config.js                       # deployment config (subdomain/region/domains) — committed
docker-compose.yml                   # Postgres + Redis (dev)
docker-compose.production.yml
Dockerfile, .dockerignore
next.config.ts                       # patched when auth is enabled: /_auth/:path* rewrite → SPFN API
.env.local.example                   # committed reference — Next.js keys, placeholder values
.env.server.example                  # committed reference — backend keys, placeholder values
.env.local                           # generated, gitignored (values loaded by Next.js)
.env.server                          # generated, gitignored (server secrets: DB, cache)
```

The reference is split by consumer, never combined, and a key's file follows who
reads it rather than whether it is secret:

- `.env.local` / `.env.local.example` — the Next.js process (server routes, proxy,
  SSR) and, through `NEXT_PUBLIC_*`, the browser: `SPFN_API_URL`, `SPFN_APP_URL`,
  `SPFN_AUTH_SESSION_SECRET`, `SPFN_AUTH_SESSION_TTL`, `SPFN_AUTH_CSRF`.
- `.env.server` / `.env.server.example` — the SPFN backend only, never loaded by
  Next.js: `NODE_ENV`, `SPFN_LOG_LEVEL`, `DATABASE_URL`, `CACHE_URL`, `DB_POOL_*`,
  and every OAuth, token, and admin secret.

So the session secret is secret and still lives in `.env.local` — the Next.js proxy
verifies cookies with it — while `DATABASE_URL` never appears there at all.

Full mode overlays the Prototype-to-Production baseline:

```
src/
  app/login/page.tsx                 # provider login starter UI
  app/auth/callback/page.tsx         # OAuth session handoff
  i18n/catalogs.ts                   # application-owned en/ko starter messages
  i18n/server.ts                     # configured server-side i18n registry
  server/routes/ops.ts               # ops routes under /_ops + the manifest `spfn ops` reads
  server/router.ts                   # authRouter + opsRouter + global authenticate
  server/server.config.ts            # createAuthLifecycle + i18n startup
next.config.ts                       # /_auth/* callback rewrite
.env.local                           # generated auth session secret (gitignored)
.env.server                          # auth keyring (gitignored)
```

The full RPC proxy imports the auth interceptor; it merges no route map, because the
generated one already carries the routes of the packages `.packages()` mounts. Internal auth
keys are generated with cryptographic randomness in ignored local env files;
`.env.local.example` and `.env.server.example` contain placeholders only. Add only the provider keys you use, then run
`pnpm spfn db push`: it applies the auth migrations, then creates the starter `examples`
table, which ships with no project migration.

Operating the app is [`spfn ops`](#spfn-ops), not a dashboard: the starter
`src/server/routes/ops.ts` exposes two read commands, and `spfn ops` discovers them from
the running server's manifest. Issuing the first token signs in as an administrator, so
uncomment `SPFN_AUTH_ADMIN_ACCOUNTS` in `.env.server` and restart before
`spfn ops token issue`. The ops surface adds no dependency — the router comes from
`@spfn/core/ops` and the tokens from `@spfn/auth`.

`init` also patches `package.json` (scripts: `spfn:dev`, `spfn:server`, `spfn:next`,
`spfn:build`, `spfn:start`, `codegen`; deps: `@spfn/core`, `spfn`, `drizzle-orm`,
`@sinclair/typebox`, `concurrently`, etc.; devDeps: `@types/node`, `tsx`, `drizzle-kit`, no
`tsup`, since `spfn build` bundles with the CLI's own; full also adds `@spfn/auth`, `@spfn/i18n` and
auth's `@spfn/notification` peer; both modes set the Node engine to
`^22.23.4 || ^24.22.1 || >=26.12.1` unless the existing range admits only releases that carry
the CVE-2026-111497 fix), excludes `src/server` from the root
`tsconfig.json` (Vercel compat), and adds `.spfn/`, `.env.local`, `.env.server` to
`.gitignore`.

### Route DSL (the current architecture)

Routes are defined with the `route` builder and collected by `defineRouter`. There is no
separate "contract" layer — the router's type *is* the contract; the client infers from it.

```ts
// src/server/routes/examples.ts
import { route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

export const getExample = route.get('/examples/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (c) =>
    {
        const { params } = await c.data();
        return { id: params.id };
    });
```

```ts
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { getExample } from './routes/examples';

export const appRouter = defineRouter({ getExample });
export type AppRouter = typeof appRouter;
```

```ts
// src/lib/api-client.ts
import { createApi } from '@spfn/core/nextjs';
import type { AppRouter } from '@/server/router';

export const api = createApi<AppRouter>();
const example = await api.getExample.call({ params: { id: '123' } });
```

Client calls go through the Next.js RPC proxy (`/api/rpc/[routeName]`), which forwards to
the SPFN API with cookie forwarding and interceptors, resolving routes via the generated
`route-map.ts`.

---

## Deployment

Two targets, both shipping from the same repository.

**Vercel — serverless, one origin, no container.** Run `spfn add vercel` (above) and
deploy. Frontend and backend share a single Vercel origin. One caveat: the in-process job
worker does not run there, so enqueuing works but nothing drains the queue — schedule a
route that processes a batch (Vercel Cron), or run jobs on an always-on target.

**Always-on — a long-lived process.** `spfn build` then `spfn start`, or the generated
Docker files. Background jobs, WebSocket events and the periodic database health check all
need this path.

```bash
# Build + run locally
pnpm spfn:build
pnpm spfn:start                 # Next.js :3790 + SPFN API :8790

# Docker (single image runs both)
docker compose -f docker-compose.production.yml up --build -d
```

The Dockerfile (`node:22-alpine`) installs with `pnpm --frozen-lockfile`, runs
`pnpm run spfn:build`, prunes dev deps, exposes `3790`/`8790`, health-checks
`http://localhost:8790/_core/health`, and starts via `pnpm run spfn:start`.

Run migrations against the target DB before/with deploy:

```bash
docker exec <container> npx spfn db migrate
```

Forget, and the container will not come up: the server refuses to serve while migrations
are pending and prints which ones. That is the intended failure — a deploy that stops at
the gate is one that never served the 500s. If a rollout has to proceed anyway, set
`SPFN_ALLOW_PENDING_MIGRATIONS=true` in the container's environment; the pending list is
logged as a warning instead.

A readiness probe can catch the same drift on a cluster the local gate never sees. When
detailed health is on, `GET /_core/health` carries a `migrations` object with per-package
applied/pending counts — the same pending rule `spfn db status` and `spfn db migrate`
use, legacy `__spfn_fn_migrations` records included — assert `migrations.pending === 0`
in the probe to hold a drifted pod out of rotation. Reporting drift does not, by itself, change the overall
health `status`.

`spfn.config.js` (committed) configures the managed `*.spfn.app` deployment: `subdomain`,
`region` (`us` default, `kr`, …), `customDomains`, and non-secret `env`. Its `SpfnConfig`
type ships from `spfn` (`@type {import('spfn').SpfnConfig}`).

---

## FAQ

**`create` or `init` — which one?**
`create` starts a new project: it runs `create-next-app` with SPFN's flags and then runs
`init` inside it. `init` adds SPFN to a Next.js app that already exists. If you built
something with an AI coding agent and now want a real backend under it, `init` is the one.

**`bare` or `full`?**
`full` is the recommended baseline: core, auth, i18n and the ops surface wired together, so
you get a working authenticated app on day one, operable from the terminal. `bare` is core only — the architecture with nothing
else decided. Automation should always pass `--mode` explicitly, because a `--yes` run
without one still produces `bare` for backward compatibility.

**Why doesn't my server restart when I edit a file?**
Because hot reload is off by default. `spfn dev --watch` restarts the server on `src/server`
changes. Next.js reloads on its own either way.

**Do I have to use Docker?**
No. Vercel is a first-class target and needs no container. Docker is the always-on path,
and `docker compose up -d` is also the convenient way to get PostgreSQL and Redis locally —
pointing at your own PostgreSQL works too. PostgreSQL itself is not optional.

**Which Node version do I need?**
`^22.23.4 || ^24.22.1 || >=26.12.1`, in both modes — the releases that fix CVE-2026-111497,
remote code execution in Node's bundled Brotli decoder; the `package.json` that `spfn init`
writes declares the same range. `@spfn/core` runs on `@hono/node-server` `^2.1.6`, which
itself accepts Node 20, so the floor is the security one, not the server's.

**When do I have to run codegen by hand?**
Whenever routes change outside `spfn dev`, which runs a codegen watcher for you. A stale or
missing `src/generated/route-map.ts` makes the RPC proxy answer 404 — run `spfn codegen run`
and commit the result.

**Where do secrets go?**
`.env.server` (gitignored, server-only) for backend values, `.env.local` for the session
cookie secret that the Next.js runtime itself needs. Never `spfn.config.js` — that file is
committed.

## Pitfalls

- **`.env.server` is gitignored and server-only.** Put backend-only DB/secret values there,
  not in `.env` (committed). Full mode's session-cookie secret is the intentional exception:
  it lives in gitignored `.env.local` because Next.js must encrypt the cookie. There is no
  `.env.server.local`. `spfn init` generates `.env.server`; put DB/secret values there.
  Load order is the standard dotenv chain ending with `.env.server`.
- **Never commit secrets in `spfn.config.js`.** It's checked into Git; its `env` block is
  for non-sensitive values only. Use CI/CD secret management for credentials.
- **`spfn dev` does not hot-reload by default.** Add `--watch` to restart on `src/server`
  changes.
- **`spfn start` needs a prior `spfn build`.** It hard-fails without `.spfn/server`,
  `.spfn/prod-server.mjs`, and `.next`.
- **Destructive DB commands are guarded.** `db drop` double-confirms (and verifies the
  target); `db push` applies the selected statements in one transaction and withholds
  destructive ones unless `--force`/confirmed. Prefer `db generate` + `db migrate` for
  production; `db push` is dev-only.
- **`spfn add` requires a scoped package name** (must contain `/`) and only applies
  migrations when `DATABASE_OWNER_URL` or `DATABASE_URL` is set — otherwise it skips with a hint. The single
  exception is `spfn add vercel`, a built-in target rather than a package.
- **The package manager is the app's own.** Its lockfile decides, then the lockfile and
  declaration of a workspace that lists the app, then npm (see [Usage](#usage)). An app that
  relied on the repository's manager while its workspace does not list it now gets npm.
  To keep the repository's manager, add the app to the workspace's globs, or commit the
  app's own lockfile; `create` and `init` also take `--pm`, while `dev`, `build`, `start`,
  `add`, `setup` and `provision` follow the lockfile only. `create` installs a
  pnpm-workspace member from the workspace root, any other app in its own directory.
- **Make scaffold mode explicit in automation.** Interactive runs recommend `full`, while
  historical `--yes` calls without `--mode` remain `bare`. Pass `--mode full` or
  `--mode bare` so scripts state their intended architecture.
- **Regenerate the route map after route changes outside dev.** If
  `src/generated/route-map.ts` is missing or stale, run `spfn codegen run` — the RPC proxy
  depends on it.

---

## Related

- [`@spfn/core`](../core/README.md) — server, route DSL, codegen, db, client runtime.
- [`@spfn/auth`](../auth/README.md) — what `--mode full` wires in for accounts and roles.
- [`@spfn/mcp`](../mcp/README.md) — an agent-facing MCP endpoint, added on demand with
  `spfn add @spfn/mcp`.
- Project root README — framework overview and getting started.
