# Changelog

All notable changes to SPFN will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: For changelog history prior to v0.1.0-alpha.60, see [CHANGELOG-v0.0.x-alpha.md](./CHANGELOG-v0.0.x-alpha.md)

## [Unreleased]

### Added

- **@spfn/core, spfn: `appPrivileges` declares column lists, and the grant step keeps them (#460).**
  The grant step brings the app role to exactly what is declared, and a declaration was table-level
  only, so the step revoked every column grant: a table where the app inserts rows and may update
  only some columns could not be declared, and the step and a hand-run SQL file undid each other.
  `appPrivileges(table, { select: true, insert: true, update: ['status', 'messageId'] })` now
  declares it: a privilege is `true` (the whole table) or, for `select`, `insert`, `update` and
  `references`, a list of the table's property names, type-checked against the table and mapped to
  column names where the declaration is written; a list on `delete`, `truncate` or `trigger`, an
  empty list or a property the table does not have is a type error and an `AppPrivilegesError` at
  load, so `spfn db generate` stops before drizzle-kit. The step grants `UPDATE ("message_id",
  "status")`, revokes a column grant not declared, and revokes a table-level grant of a privilege
  declared on columns before granting the columns, in its one transaction; the read role gets the
  `select` column list. `privileges.json` carries the lists as version 2 (`"columns"` per table),
  written only when a table declares one: a project without one writes version 1, byte for byte as
  before, and an older CLI refuses a version 2 file instead of granting table-wide. `spfn db status`
  reports the new drift — human form and `--json`, additive: `drift[].missingColumns`,
  `drift[].columnGrantOption`; `columns` now means "column grants beyond the declaration". New
  exports from `@spfn/core/db`: `APP_COLUMN_PRIVILEGES`, the types `AppColumnPrivilege`,
  `AppColumnPrivileges`, `AppPrivilegeDeclaration`, `ColumnGrant`; `AppTablePrivileges.columns?`,
  `GranteeChange.missingColumns`/`columnGrantOption`, `AppPrivilegeDrift.missingColumns`/
  `columnGrantOption`; `APP_PRIVILEGES_MANIFEST_VERSION` is now 2 (the newest format; 1 is still
  read and written). A column added later is not covered by a list; a column renamed under the same
  property follows it. A listed column the table does not have (its migration not run, or renamed
  under a stale manifest) stops the step before any statement, naming the table and the column,
  on any table, one the app role owns or inherits the owner of too; `db status` reports it in
  `absentColumns` (`--json`, additive), never as a missing column grant (new export: the type
  `AbsentColumns`; `CatalogRelation.columns`, `AppPrivilegesPlan.absentColumns`,
  `AppPrivilegesCheck.absentColumns`). Lists are validated against what drizzle — every repository's access path —
  sends, since PostgreSQL checks the privilege of each column a statement names: an `insert` list
  that leaves out a column drizzle's `insert()` names (every one but a GENERATED ALWAYS one) and an
  `update` list that leaves out a `$onUpdate` column (`timestamps()`' `updatedAt`) are an
  `AppPrivilegesError` at load, not a 42501 on the app's first write; a `select` list works with
  explicit column selections only (the core db README, "Column lists").
- **@spfn/auth: one password rule, applied on every path that writes a password —
  `createAuthLifecycle({ password: { validate } })` (#458).** A new password was held to
  `PasswordSchema` (length) alone, stated per route, and since #417 a session with
  `passwordChangeRequired` reaches no app route, so an app had nowhere to apply its own policy —
  `PUT /_auth/password` answered 204 to `aaaaaaaa` after a temporary password. `validate(password,
  { channel, userId, email, phone })`, sync or async, is now asked before the hash is computed on
  `register`, `signup-link`, `invitation`, `change`, `reset`, admin seeding (`seed`) and the new
  `hashNewPassword` (`operator`); `subject` carries identifiers only, `userId: null` where no account
  exists yet. Messages answer **400 `ValidationError`** with one `fields` entry per message on
  `/password` (`/newPassword` on a change), the TypeBox failure's shape and message (`Invalid request
  body`) without `value`; a throw answers **500 `PasswordRuleFailedError`** (`channel`,
  `hookErrorClass`, `hookErrorCode?`) and accepts nothing. The rule is never asked inside a
  transaction or with anything locked: on a change after the step-up and before the current password
  is checked; on a reset before the account is read; on register, the signup link and an invitation
  before the transaction that claims and creates the account — `POST /_auth/register`,
  `/_auth/signup/password` and `/_auth/password/reset/complete` no longer run under a route-wide
  `Transactional()`; their services open the transaction once the rule has answered, and a setup
  session that expires meanwhile is refused by its claim. Omitted, nothing changes;
  `validatePasswordStrength` stays opt-in, called inside the rule. **BREAKING (types):**
  `usersRepository.create`/`updateById`/`updatePassword`/`replaceVerifiedPasswordHash` and
  `updateUserService` take `passwordHash` as an `AdmittedPasswordHash`, which only the rule's path
  makes: app code writing `await hashPassword(…)` there moves to `await hashNewPassword(…)`. New
  exports from `@spfn/auth/server`: `hashNewPassword` and the types `PasswordRuleOptions`,
  `PasswordRuleSubject`, `PasswordRuleChannel`, `PasswordRuleAnswer`, `AdmittedPasswordHash`,
  `NewUserRow`; from `@spfn/auth/errors`: `PasswordRuleFailedError`. No schema change, no migration;
  the mobile contract does not move.
- **@spfn/core: `invalidInputMessage(part)` and `REQUEST_BODY` from `@spfn/core/route`** — the
  message of the `ValidationError` a part of the request fails its schema with
  (`invalidInputMessage(REQUEST_BODY)` is `Invalid request body`), for a check a handler makes on
  the same body after the schema's, so the two failures cannot read differently. `validateField`
  builds its message with it; nothing it answers changes. `@spfn/auth`'s password rule (#458)
  refuses with it.
- **@spfn/auth: `listPasskeys` answers each passkey's `aaguid` (#470).** The `passkeys` table kept
  the AAGUID an authenticator reports at registration, but `PasskeySummary` left it out, so an app
  could not say where a passkey is kept ("iCloud Keychain", "Google Password Manager", a security
  key's model) without reading the package's table. `PasskeySummary` gains `aaguid: string | null`:
  lowercase and hyphenated, `null` when the authenticator reported none — the all-zero AAGUID that
  registration stores for it answers `null` too, so an app need not know the convention. Attestation
  stays `none`, so it is what the authenticator claims; the package maps it to no name. Only the
  passkey's owner is answered it, on `POST /_auth/passkeys/list`. No migration: the column exists.
  An app that compares a summary with an exact key list gains one key.

- **@spfn/auth: a seat for the app inside a password change — `createAuthLifecycle({ passwordChange:
  { admit, changed } })` and `auth.password.changed` (#434).** Since the required password change is
  enforced, a flagged session reaches no app route, so an app could no longer wrap the change in its
  own transaction (refuse an expired temporary password, mark the account set up, write an audit
  line). Both callbacks now run in the transaction that writes the new password, under the account
  lock, on `PUT /_auth/password` (`channel: 'change'`) and on a completed reset link (`'reset'`) —
  the two paths that clear `passwordChangeRequired` — handed `{ user, required, channel }`, where
  `required` says the account carried the flag. `admit` runs before anything is written;
  `{ refuse: { code } }` answers **403 `PasswordChangeRefusedError`** (`details.code`, the sign-in
  refusal's shape) and writes nothing. `changed` runs once the change is written and the sessions it
  ends are ended; a throw from either rolls the change back and answers **500
  `PasswordChangeHookFailedError`** (`hook`, `userId`, `hookErrorClass`, `hookErrorCode?` — the
  `onPurge` rule: nothing of what the hook threw). An app repository extending `BaseRepository`
  joins the transaction. `authPasswordChangedEvent` (`auth.password.changed`: `userId`, `required`;
  payload type `AuthPasswordChangedPayload`) fires after a change commits; a reset still fires only
  `auth.password.reset`. Registration, invitation acceptance, seeding, a sign-in's legacy-hash
  re-encoding and a purge are not asked. New exports from `@spfn/auth/server`: the event, its payload
  type, and the types `PasswordChangeAttempt`, `PasswordChangeAdmission`, `PasswordChangeChannel`,
  `PasswordChangeGuardOptions`; from `@spfn/auth/errors`: the two errors. Omitted, nothing changes;
  sessions are ended as before. No schema change, no migration; the mobile contract does not move.
- **@spfn/notification: `sendEmail` sends attachments — `attachments: { filename, contentType,
  content: Uint8Array }[]` on `SendEmailParams`, `sendEmailBulk` items included (#443).** The
  attachments travel on the provider contract (`InternalSendEmailParams.attachments`) to the
  provider, the SES provider puts them on `Simple` content (`Attachments`, no raw MIME). A provider
  takes them only when it declares `supportsAttachments: true`; a send with attachments to one that
  does not is refused before the call (`errorCode: 'attachments_unsupported'`), so a custom
  provider written before this cannot drop them silently. An attachment with an empty filename, a
  control character or line break (CR, LF, NEL, U+2028, U+2029) in `filename`, a `contentType`
  that is not a MIME type, or no bytes is refused before anything else (`attachment_invalid`), as
  is a malformed value from a plain-JS caller (`attachments` not an array — `null`, like `undefined`,
  means none — an entry not an object,
  a non-string `filename` or `contentType`, `content` not a `Uint8Array`) — a refusal naming the
  attachment's position, not a `TypeError`. A provider may declare `maxMessageBytes`: SES declares `SES_MAX_MESSAGE_BYTES` (40 MiB, encoded — SES v2's message quota), and a message
  whose encoded size is certainly over it is refused without a provider call; SES's own size
  rejection maps to the same `errorCode: 'message_too_large'`. `scheduleEmail` and a distributed
  `sendEmailBulk` refuse attachments (`attachments_not_deferrable`): their payload is a JSON job row.
  The package itself never writes a filename to the history row or a log line; the new nullable column
  `history.attachments` (migration `20261122153946_low_klaw`) records the media type (lower-cased
  `type/subtype`, parameters dropped: a `name=` parameter carries a filename) and size of each, only where `content` would be stored (not on a `sensitive` send, not with
  `storeContent: false`). A provider error that quotes one of the send's filenames — as written
  or percent-encoded (`encodeURIComponent`, or `+` for a space); any other encoding a provider
  might invent is not recognised — has it replaced by `[attachment N]` before it is logged or
  stored, where its addresses are scrubbed —
  as a whole token (a percent escape just before it counts as a separator), in the same single pass, a recipient address always masked where a filename
  overlaps it and the rest of that filename left in the text, text shaped like the scrub's own output
  (`[attachment N]`, a masked address or phone number) left as it is and a filename that partly
  overlaps it left whole, every candidate found before any is chosen so a dropped filename hides no shorter
  one, the longest filename taken first (`scrubProviderError` and `scrubSendResult` take the send's attachments as an optional second
  argument; `null` means none). `SendResult` and `ScheduleResult` gain `errorCode` (`SendErrorCode`).
- **spfn: the owner installs, migrates and grants the jobs queue schema (#171, PR 2 of 3).** pg-boss
  started with its defaults creates and migrates its schema as the app role — the one place the app
  role owned and changed structure — and nothing on the owner's side knew the queue existed. An app
  that declares its jobs in `package.json` (`"spfn": { "jobs": true }`, or `{ "schema": "<name>" }`)
  now has `spfn db push`, `db migrate` and `db grant` run a queue step as the owner (`spfn add`
  does nothing to the queue; `db push` runs it in a project without schema files too, where it
  pushes nothing else), before the privileges step: pg-boss's own install plan when the schema is missing, its migration
  plan when it is older, nothing when it is current, one warning when it is newer; then the
  privileges step grants the app role on the queue (`target.queue`) in the same run. pg-boss's lost
  race against an app starting at the same moment is rolled back and the version read again. A
  version pg-boss cannot migrate from fails with `QueueSchemaVersionError`'s text, nothing run; a
  schema holding objects that are not pg-boss's, or one the step manages, fails naming the
  declaration — each of these before the command applies anything. A queue owned, in whole or in part, by a role the owner cannot act for — one the
  app role installed, or a schema it owns holding the owner's objects — is left alone with the
  `REASSIGN OWNED` (or bootstrap-superuser `ALTER … OWNER TO`) remedy, which leaves the owner
  holding the schema and every object in it, and
  exit 0, the rest of the privileges step applied. `--dry-run` (`db push`, `db grant`) prints
  `Would install …`/`Would migrate …`, runs neither, and says the queue's privilege statements
  follow the plan and are not listed. Without the declaration nothing changes:
  nothing of the queue is read, run or printed, and the app installs the queue at its start as
  before; a single-role project installs as its one role. `@spfn/core/job` adds
  `isQueueSchemaRace(error, 'install' | 'migration')`; `readJobsDeclaration` reads a directory
  without a `package.json` as declaring nothing (it threw). Breaking: no, for single-role projects
  and for projects that declare no jobs.
- **@spfn/core: the queue schema's facts — nothing calls them yet (#171, PR 1 of 3).** pg-boss is
  pinned exactly (`11.1.2`, the version already resolved). `@spfn/core/job` exports
  `QUEUE_SCHEMA_VERSION` (from pg-boss's `version.json`), `queueInstallSql(schema)` and
  `queueMigrationSql(schema, from)` — pg-boss's own construction and migration plans; a `from`
  pg-boss cannot migrate throws `QueueSchemaVersionError` naming both versions, where pg-boss
  itself returns a plan for a version older than its first migration — and
  `readQueueSchemaState(db, schema)`: whether the schema exists, whether the connected role owns
  it, may use it and may create on the database, and its installed version where the role may
  read it — a state one statement saw, `QueueSchemaChangedError` where the schema is dropped,
  replaced or its privilege revoked while it is read, never a raw privilege error — and `notPgBoss` for a schema of that name that is not
  pg-boss's (objects but no `version` table, a `version` table without an integer `version` column,
  or not one integer in it); an existing schema holding no object reads as nothing installed. `@spfn/core/db` exports `readJobsDeclaration(cwd?)`, the
  reader of `"spfn": { "jobs": true | { "schema": "<name>" } }` in the app's `package.json`
  (`JobsDeclarationError` naming the file and the key for a malformed value, an unknown key in
  `spfn.jobs`, `public` or `drizzle` as the schema, or a name pg-boss's unquoted SQL breaks on or
  folds: upper case, a PostgreSQL keyword other than an unreserved one, `pg_…`), and the app
  privileges target takes the queue as a part of its own (`target.queue`): every table there,
  partitions included, gets the default set, `version` `SELECT` and `UPDATE`, every function
  `EXECUTE` with PUBLIC's revoked, the schema `USAGE` and nothing else (`CREATE` revoked as on any
  managed schema); the read role nothing. A queue owned by a role
  the owner cannot act for is reported apart (`plan.queue`) and does not block the plan; a queue
  schema that is also one of `target.schemas` blocks it (`plan.queue.managedSchema`), with nothing
  planned for that schema. `foreignOwnedObjects(db, schemas, queueSchema?)` lists the queue
  schema's functions, and no other schema's: `spfn db push`'s ownership remedy is unchanged.
  Plans without a queue target are unchanged.

- **spfn: the app role is granted exactly what is declared — `spfn db grant [--dry-run]`, and a
  privileges step at the end of `db push`, `db migrate` and `spfn add` (#405).** As the owner
  (`DATABASE_OWNER_URL`), in a transaction of its own after the schema changes, the step brings the
  app role to the declarations on the managed schemas — the project's (from the entities on push,
  from `src/server/drizzle/privileges.json` on migrate and add; `db grant` and `db status` read
  the manifest when the project has one, else the entities as push loads them, and with neither
  `db grant` exits 1 and `db status` reports the privileges unknown), each function package's (from its
  manifest; none means the default set) and `drizzle`: on every table the declared set (default
  `SELECT`, `INSERT`, `UPDATE`, `DELETE`), `USAGE` on the schemas and sequences, `SELECT` only on the
  `drizzle` bookkeeping. A table of a managed schema no manifest lists gets the default set, and so
  does a view every write through which is checked against the app's own rights — created `WITH
  (security_invoker)` (PostgreSQL 15+), with no rule but its SELECT rule and no INSTEAD OF
  trigger; any other view, whose writes run with its owner's rights, gets `SELECT` only; a foreign table is a table, a materialized view gets `SELECT`; a
  partition gets nothing directly, and what the app holds on one is revoked — access goes through
  the root table, whose declaration applies; a listed table that does not exist is reported by the dry run and otherwise ignored. It reads every access
  list from the catalog and issues only the statements needed — no `ALTER DEFAULT PRIVILEGES`; a
  second run issues none. The app role is the `current_user` of `DATABASE_WRITE_URL`, else
  `DATABASE_URL`; a `DATABASE_READ_URL` connecting as another role gets `USAGE` and `SELECT` only.
  The new optional setting `DATABASE_APP_ROLE` names the app role when no app URL is set (a migrate
  job holding only the owner URL); beside an app URL naming another role it is refused, naming both
  roles, and one naming no role in the database ends the step with exit 1, naming the setting and the
  role, before any statement. Without `DATABASE_OWNER_URL`, or with an app role that is the owner or inherits it: one
  note, no statement. With no way to name the app role: one warning, the step skipped, exit 0. A
  table of a managed schema another role owns is listed and nothing is granted (exit 1), never
  PostgreSQL's warning swallowed. A grant option the app role holds is revoked, the privilege kept
  when declared. Every `REVOKE` is plain, never `CASCADE`, and whether one is refused is
  PostgreSQL's decision, not predicted: when it refuses one because a grant the app role made with
  such an option depends on it (2BP01), the transaction rolls back, nothing is changed (exit 1), and
  the refused statement is printed with the grants on its table of what it revokes that roles other
  than the owner made — the dependent ones among them — and the two ways out: their grantors revoke
  them, or the owner runs the statement with `CASCADE`, which the step never does. One refusal per
  run; the next run tries again. A grant to PUBLIC from another grantor than the owner, which the
  owner's `REVOKE` leaves in place, is listed with the `REVOKE` its grantor can run, and nothing is
  changed (exit 1). When the step fails the command exits 1 with `Schema applied; no
  privilege was changed, so new tables have only what the database gives by default`, the error as push prints its failures and its way out, then `spfn db grant`; an
  unreadable manifest ends `db migrate`, `spfn add` and `db push` before anything is applied.
  `spfn db grant --dry-run` and `spfn db push --dry-run` print the roles, how each was found, the
  statements (push: `privileges for N new tables`) and what is held through a group role;
  `db grant --dry-run` runs the statements in one transaction it always rolls back, on a writable
  owner connection — taking a run's locks until then: none on a table, each table's catalog row —
  so it reports a statement PostgreSQL refuses and changes nothing, while push's dry run only plans,
  in read-only transactions. PUBLIC `CREATE` on schema `public` (PostgreSQL before 15) is reported,
  never revoked. `spfn_queue` is not managed: the app role creates it, and needs `CREATE` on the
  database once. A table the app role owns, or whose owner it inherits, is outside the step — no
  statement on it for any role or PUBLIC, whoever the owner URL connects as (a superuser
  included), and nothing compared on it by `db status`: it is named, its declaration not enforced;
  `ALTER TABLE … OWNER TO` the owner role brings it under the step. `spfn db status` reports, as the app, what `db grant`
  would change for it — the step's own plan, for the same roles, run on the catalog the step
  reads, so a grant option, a column grant, a statement for PUBLIC or for the read role the app is
  a member of, and a grant to PUBLIC by another grantor that blocks the step are not clean — and
  `--json` gains `privileges` (`checked`, `source`, `checkedTables`, `ownedTables`, `drift: [{
  schema, table, kind, grantee, through, missing, excess, grantOption, columns }]` — one entry per
  relation and grantee, so a table can appear more than once — `schemasWithoutUsage`,
  `publicGrantsByOthers`, `heldElsewhere`, `publicMayCreateInPublic`); it does not predict a refusal, which only the owner's
  `db grant --dry-run` sees; it and `db grant` name the project's declaration they read
  (`source`: `manifest src/server/drizzle/privileges.json`, or `entities`). `@spfn/core/db` exports the step: `readPrivilegeCatalog`,
  `planAppPrivileges` (the pure difference), `applyAppPrivileges`, `checkAppPrivileges`,
  `appRelationPrivileges`, and `foreignOwnedObjects`, the catalog read `db push`'s ownership remedy
  uses too. The core db README's "Database roles" replaces its hand `GRANT` and `ALTER DEFAULT
  PRIVILEGES` SQL with the step and a table of what it grants; the multi-tenancy guide drops the
  database-wide `ALTER DEFAULT PRIVILEGES`, which also gave the app role write access to `drizzle`.
- **@spfn/core: `appPrivileges(table, [...])` declares what the app role may do on a table, and
  `spfn db generate` records it in `privileges.json` (#405).** The step that applies it, `spfn db
  grant`, is the next entry. The helper takes `select`, `insert`, `update`, `delete`, and `truncate`,
  `references`, `trigger` as opt-ins, table-level, and returns the table, so it wraps `pgTable`,
  `schema.table` and `tenancy.table` alike; an unknown privilege, an empty list or a second, different
  declaration on one table throws `AppPrivilegesError` naming the table when the schema module
  loads. A table without one has `DEFAULT_APP_PRIVILEGES` (`select`, `insert`, `update`, `delete`).
  `spfn db generate` writes `privileges.json` beside the migrations of the run — in the `out` of
  the config it hands drizzle-kit, `src/server/drizzle` (the folder `db migrate` reads) unless the
  project's own `drizzle.config.ts` names another — on every run, a change of declaration alone
  included: format version 1, the default set once, every table of the schema files that config
  names, each file loaded on its own as drizzle-kit loads it, every top-level export — `default`
  included, nothing nested in an exported object or array — as drizzle-kit collects a migration's
  tables, as `{ schema, table, privileges }` —
  two fields, since a quoted identifier may hold a dot — with its list or `"default"`, sorted by
  schema, then table, so an unchanged schema regenerates the same bytes. drizzle-kit is handed
  those very files — with a project's own `drizzle.config.ts`, a config of the run that spreads it
  and replaces its `schema` with them — so a `**` glob reaching a nested `node_modules`, which
  drizzle-kit's glob does not skip, cannot put a table in the migration and not in the manifest. With its own
  `drizzle.config.ts` a project needs no `DATABASE_URL` for it, and a schema module that fails to
  load or two tables of one name declaring different lists stop the command before drizzle-kit
  writes anything; a `privileges.json` that cannot be written stops it after (exit 1), naming the
  file, that the migrations were written, and to rerun `spfn db generate`. `@spfn/auth`, `@spfn/notification`, `@spfn/monitor`, `@spfn/cms` and
  `@spfn/workflow` ship their own in `migrations/privileges.json` (`pnpm db:generate` writes it;
  every table has the default set), and each package's tests fail while the committed file differs
  from its entities. A migrations folder without the file — a package published before this
  release — declares nothing: every table its migrations create has the default set. For a later
  grant step and the CLI, `@spfn/core/db` exports `declaredAppPrivileges(values)` (the markers of
  loaded tables, read by their `Symbol.for` key, so through any copy of core, as sorted
  `AppTablePrivileges` entries), `readMigrationsAppPrivileges(migrationsDir)` (the folder's
  manifest, or `kind: 'none'` with the default set when the folder's listing holds no file; a
  folder that cannot be listed — missing, unreadable, not a folder — or a listed file that cannot be
  read, a dangling symlink included, throws `AppPrivilegesManifestError` naming the file) and
  `readAppPrivilegesManifest(file)` (throws `AppPrivilegesManifestError` naming the file on
  unreadable JSON, an unknown version, a malformed entry or a table listed twice; so does the
  folder reader for a file that is there), with `renderAppPrivilegesManifest`,
  `writeAppPrivilegesManifest`, `APP_PRIVILEGES`, `APP_PRIVILEGES_MARKER`,
  `APP_PRIVILEGES_MANIFEST_FILE` and `APP_PRIVILEGES_MANIFEST_VERSION`; and
  `drizzleKitSchemaFiles(schema, cwd?)`, the files drizzle-kit loads for a config's `schema`,
  resolved without a database URL, and `renderSchemaFilesConfig(projectConfig, files)`, that
  project config naming those files only.
- **@spfn/core: a repository read can ask for the primary — `{ primary: true }`** (and the
  `ReadOptions` type from `@spfn/core/db`). A replica can lag behind the primary; a read that must
  see a write made a moment ago passes it. `TenantRepository`: `_findOne(tenantId, table, where,
  options?)`, a `primary` field in `_findMany` / `_findManyKeyset` options, `_count(…, { primary })`,
  and a third argument to `_select` / `_selectOfUser` (`(id, fields?, options?)`). A tenancy-table
  read still runs as a short read-only transaction with the tenant set, now on the write
  connection, and the guard's tenant check still applies. `BaseRepository`: `_findOne(table,
  where, options?)`, `_findMany`, `_findManyKeyset` and `_count` take it too — every read helper of
  both classes. Without the option a read outside a transaction still goes to the replica; inside
  a transaction the option changes nothing. The README's and the multi-tenancy guide's `isMember`
  (the guard's `authorize`) now read the primary (spfn/spfn#169).
- **@spfn/core: `describeError(error)` from `@spfn/core/logger`** (and the `ErrorDescription` /
  `DatabaseErrorDescription` types): the one loggable form of a caught error. A database error is
  described by its SQLSTATE, constraint, schema, table, column, routine, the SQL with its `$n`
  placeholders (truncated to 1000 characters) and `paramCount`; the driver's message only for
  SQLSTATE classes 08, 23, 40, 53 and 57 raised by a known server routine (or by a pooler, which
  names none) — a PL/pgSQL `RAISE`, a PL/Python `plpy.error` or an extension reporting a kept
  class keeps no message. It never copies
  `params`, `parameters`, `detail`, `hint`, `where`, `internal_query`, drizzle's message or a stack
  header (#382).
- **@spfn/core: `alreadySentToClient(body)` from `@spfn/core/logger`** marks a body that was sent,
  as it is, to a client before it goes into a log context: under the mark, a value under `error`,
  `err`, `cause`, `reason` or `errors` is the body's own data — its `error` key the envelope the
  client received — kept as data, not described as a caught value; sensitive names are still
  masked and an `Error` instance is still described. Core's request logger marks its copy of a
  4xx/5xx response body with it (#382).
- **@spfn/core: `stopFetching(fetchWait = 5000)`** waits up to `fetchWait` ms for the job fetches
  in flight; the server's Phase 2 passes its own budget (a `jobFetch` phase, see below) (#359).
- **@spfn/auth: a sign-in guard — `createAuthLifecycle({ signIn: { admit, settled } })` (#361).**
  The app can refuse a sign-in and is told how every attempt ended. Not breaking: an app that leaves
  the option out sees no change in answers, and no extra query, lock or transaction on any sign-in
  (what did change for it, `/login` and `deletion/cancel` without a route transaction, is under
  Changed). An app that sets it newly sees:
  - `admit` asked on every sign-in channel (password, passkey, web and native OAuth, password reset,
    register, signup link, invitation, device code, device link), under the account lock where the
    key is written, and at `mfa/verify`; on password sign-in, `deletion/cancel` and `mfa/verify` also
    before the credential is judged. Never on renewal or `keys/rotate`.
  - **403 `SignInRefusedError`** (`details.code` the app's string) from `/login`, `register`,
    `signup/password`, `invitations/accept`, `password/reset/complete`, `passkeys/login/verify`,
    `oauth/:provider/native`, `device/poll`, `device/link/poll`, `mfa/verify` and `deletion/cancel`;
    the web OAuth error redirect with the new `reason=sign_in_refused` (`OAUTH_ERROR_REASONS` gains it).
    `details.code` is 1 to 64 letters, digits, `_`, `-` or `.`; any other answer from `admit` is a
    500 with no session.
    A refused account is answered the refusal whatever the password was, after a comparison against
    the dummy hash. Mobile contract **0.14.7** lists the code (a patch; the supported range does not
    move).
  - `settled` told `challenged` at a 202, `succeeded` once a session exists, and `failed` with a
    `reason` (`credential`, `secondFactor`, `refused`, `accountDisabled`, `pendingDeletion`,
    `secondFactorLocked`) for every attempt that names an account or a credential, on every channel,
    refusals included. A failure is committed in a transaction of its own under the account lock
    before the answer — a refusal decided inside the session's transaction once that transaction has
    rolled back. A `settled` that throws on a success rolls the session back (500, no `auth.login`);
    on a wrong credential answers 500, the second-factor budget's count and lock committed whatever
    it does; on a refusal is logged, the refusal answered. That report, and one whose account lock
    stays busy past its five-second wait, is lost: the package logs a line naming the attempt
    (channel, stage, reason, user and key ids — no identifier, no address).
  - `loginService` and `cancelAccountDeletionService` throw when called inside a caller's transaction
    — a recorded failure would roll back with the refusal — as `checkSecondFactorProof` does.
  - A second `createAuthLifecycle()` stating other `signIn` functions refuses boot.

  Types `SignInAttempt`, `SignInOutcome`, `SignInGuardOptions`, `SignInAdmission`, `SignInChannel`,
  `SignInStage`, `SignInFailureReason` and `SignInIdentifier` from `@spfn/auth/server`.
- **@spfn/core: `GeneratorOptions.trigger.changedFiles`** (and the `ChangedFile` type): every change
  that triggered a watch run. `changedFile` is now set only when exactly one change did; the
  watcher takes every change that arrived during a generation into the next one (#353).
- **@spfn/core: `LoadingOrchestratorOptions.loadGenerators`** — an orchestrator given how to load its
  generators (instead of `generators`) loads them itself, and in watch mode loads them again when
  the codegen config, a custom generator file or a project file they import changes: the `spfn
  dev` watcher no longer needs a restart after an edit to `.spfnrc.ts` (#353). `close()` waits
  for a config load running as for a generation: neither can be cancelled (a load is a module
  evaluation), so one that never settles keeps `close()` pending, and the watcher's first signal
  says it waits for "the running generation or codegen config load"; a second exits at once.
  `new CodegenOrchestrator()` takes `OrchestratorOptions` (`generators`) or the new
  `LoadingOrchestratorOptions`. Given neither, it now throws a `TypeError` naming them from the
  constructor: `new CodegenOrchestrator({})` used to be constructed and then throw a `TypeError`
  at its first `generateAll()` or `watch()`. Given both, which no option type allowed before, it
  throws the same way.
- **@spfn/core: `CodegenOrchestrator.loadsGenerators`** (static, `true`): the orchestrator takes
  `loadGenerators`. The `spfn dev` watcher checks it, and with a core that cannot load its
  generators — no `./codegen` subpath, no `CodegenOrchestrator` export, or one without this flag —
  stops with `[SPFN] Codegen watcher not started: @spfn/core <installed> is installed; spfn
  <version> requires @spfn/core <its peer range> and a core that reloads generators. Update
  @spfn/core.` (exit 1) instead of dying on Node's own error (`SyntaxError … does not provide an
  export`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, or `TypeError: Cannot read properties of undefined
  (reading 'flatMap')`). A core that fails to load for any other reason shows its own error (#353).
- **@spfn/core: `CodegenOrchestrator.settled()`** resolves once watch mode is idle — no generation
  running, nothing dirty, no input directory event settling (#353).
- **@spfn/auth: `GET /_auth/channels` (`authApi.getAuthChannels`) — a sign-in page can read which
  sign-in channels are on (#373).** It answers `{ signup, passwordReset, deviceCode, deviceLink,
  passkeyLogin }`, one boolean per channel of `createAuthLifecycle({ channels })`, so a page draws no
  button that would answer 404 `CHANNEL_DISABLED` — a passkey button under `passkeyLogin: false`,
  say. Public like `GET /_auth/oauth/providers`: no session, no rate limit, no cache headers; not a
  mobile contract operation. A channel added later appears in the answer with it.
- **@spfn/auth: channels `invitations` and `selfDeletion` (#381).** Two new
  `createAuthLifecycle({ channels })` keys, both `true` by default, so an app that sets neither sees
  no change. `invitations: false` closes all seven invitation routes — create, list, resend, cancel,
  delete, and the public `GET /_auth/invitations/:token` and `POST /_auth/invitations/accept` — with
  404 `CHANNEL_DISABLED` before any rate limit, permission check or transaction; pending invitations
  stay pending and are settled by the `cancelInvitation` / `deleteInvitation` services.
  `selfDeletion: false` closes `POST /_auth/deletion/request` only: `deletion/cancel` and the
  `account_deletion` code stay on, since a pending deletion blocks every sign-in. Beside
  `deletion.allowSelfImmediate: true` it refuses boot. Service functions stay callable. Not breaking,
  but `AuthChannel`, `details.channel` of `ChannelDisabledError` and the answer of
  `GET /_auth/channels` each gain the two values; a client that switches exhaustively on
  `details.channel` meets them. No mobile contract change: no invitation or deletion route is a
  contract operation.
- **@spfn/auth: the README says what `secondFactor.required` takes (#373).** It means a factor on a
  new device, not the password on every sign-in: social sign-in, a password reset and a recovery code
  each get in without the password. A new recipe, "password and passkey on a device not signed in",
  closes all of them — `passkeyLogin: false`, `passwordReset: false`, `recoveryCodes: false`, no
  social provider enabled for sign-in — and asks the password and the passkey whenever a person signs
  in on a device that is not already signed in. It does not cover a still-signed-in browser signing
  in again (the password alone), a bound session's renewal (the passkey alone), or an account that
  has not enrolled yet (the password, then enrolment).
- **@spfn/auth: `PasskeySummary.secondFactor` and `PasskeySummary.userVerified`** (#399).
  `listPasskeys` shows whether each passkey is marked as a second factor, and whether its
  registration verified the person (`registered_user_verified`) — what `mfa/passkey/mark`
  requires, so an app offers "use as second factor" only where it answers 200 rather than 409
  `PASSKEY_USER_VERIFICATION_REQUIRED`. The type from `@spfn/auth/server` gains both. Not in the
  mobile contract: the passkey routes are not contract operations.
- **@spfn/auth: `stepUpAssertion(api)` and `stepUpWithPasskey(api)`** from `@spfn/auth/client`
  (#372, #393). `stepUpAssertion` asks `mfa/step-up/options`, runs the ceremony and answers the
  assertion unspent, for an app route that checks it with
  `checkSecondFactorProof(userId, { response }, { kind: 'stepUp', credential })` and `spend()`s
  it. `stepUpWithPasskey` posts it to `mfa/step-up`. A ceremony that did not happen is a
  `PasskeyResult` failure (`no-credential` for a dismissed sheet), a 503 is `busy` (the challenge
  was not spent), any other server refusal rejects, as `completeMfaWithPasskey` does. The assertion
  is spent once, by whichever consumer runs first, only by the session that asked for it, and is
  not tied to an action.
- **@spfn/core: `enumCheck(column, values)`** — a table-level CHECK that refuses a value outside
  `values`, for a column `enumText` only types (spfn/spfn#167). Named `<table>_<column>_check` from
  the SQL names (no schema; the column's database name); past 63 bytes cut and hash-suffixed as the
  tenancy constraints are. Values are written sorted and once each (reordering them generates
  nothing), as literals with `'` doubled; a value holding a backslash is refused (under
  `standard_conforming_strings = off` it would read as an escape), and so is one holding a NUL
  character (PostgreSQL `text` cannot hold it, so the migration would fail). NULL passes (chain
  `.notNull()`); an empty list throws when the table's extras are evaluated (`db generate`, `db
  push`). A `.default()` outside `values` is accepted by the DDL and fails at insert. Adding a value
  makes `db generate` drop and re-add the constraint, and the `ADD` re-checks every row under an
  ACCESS EXCLUSIVE lock. **`db push` does not change the constraint once it exists**: drizzle-kit's
  push never alters a check, so the database keeps refusing an added value and admitting a removed
  one; `spfn db push` names the check (below). No package column adopts it.
- **spfn: `db push` names each check it leaves as it is** (spfn/spfn#167). drizzle-kit's push never
  alters an existing check whose expression changed. `db push` and `--dry-run` now print, per
  existing check whose declared expression PostgreSQL reads differently from the stored one,
  `Check "<name>" on "<schema>"."<table>" differs from the one in the database: PostgreSQL reads
  the two expressions differently; db push does not change an existing check.`, the remedy (`db
  generate` + `db migrate`, or drop it and push again) and the `ALTER TABLE … DROP CONSTRAINT`
  statement, and change nothing about it. The comparison is the planner's print of both
  expressions (one `EXPLAIN (VERBOSE)` per existing check, which runs nothing), not their meaning:
  a numeric literal written with another scale is named although it means the same, and a rewrite
  the planner folds (`x > 0 AND true`) is not; for an `enumCheck` stored by `enumCheck` it is exact
  over the value set. A declared check naming a column the table does not have yet is named as
  differing (`it names a column the table does not have yet`); one PostgreSQL cannot read against
  the table for another reason is named as `could not be compared`, with the error.
- **@spfn/auth: `PASSKEY_PROOF_REQUIRED` names its procedure (#400).** Every route that asks a
  passkey proof of a bound account (`device/approve`, `device/link/issue`,
  `passkeys/register/verify`, `PUT /_auth/password`, `oauth/:provider/link`, `oauth2/authorize`,
  `ops-tokens`, and turning binding on) refuses with `details: { procedure }`, the value to send to
  `session/passkey-proof/options`. Not breaking: a field added to the refusal.
- **@spfn/core: `databaseErrorMessage(error)`** from `@spfn/core/db` (#378, #382): the text a
  database error may be shown to a person with — the driver's message where `describeError` keeps
  it, else the SQLSTATE class's fixed text that `fromPostgresError` gives its typed error, read from
  the description, so a drizzle query error over a driver error gets its class's text. Class 28
  (authentication) now has a fixed text of its own, `Database authentication failed`, for this and
  for `fromPostgresError` (was `Database query failed`).
- **@spfn/core: `defineServerConfig().logging({ redactPaths })` and `loggedPath(c)` from
  `@spfn/core/middleware` — a path prefix no log line names in full (spfn/spfn#164).** A capability
  route carries its secret in the path (`/api/import/:token`, a share link, a one-time download).
  Declare its prefix once and every core line that names the request path writes
  `<prefix>/[redacted]`, at every level: the request logger, proxy-guard (whose tag-mode debug and
  strict-mode warn carried the token), the error handler and its `onError` context, rate limiting
  and the transaction context. A prefix covers itself and what lies below it on a segment
  boundary (`/api/import` covers `/api/import/abc`, not `/api/importer`), matched in a canonical
  spelling of the path: percent-decoded three times over (`%2F` included), dot segments
  resolved, repeated slashes collapsed, case ignored. A request the router does not serve is
  logged as received, so a 404 for `//api/import/<token>`, `/API/import/<token>` or
  `/api/%2569mport/<token>` is redacted like the route it missed. An entry that does not start
  with `/`, ends with `/`, or contains `?`, `#`, `:` or `*` refuses the boot (builder, plain config
  and `createServer`). `createServer` publishes the declaration before anything else, so a
  hand-written `app.ts` wiring its own `RequestLogger` and `ErrorHandler` gets it too; a bare Hono
  app calls `setRedactPaths()` itself. `loggedPath(c)` is how your own lines name the path. Under a
  declared prefix nothing derived from the path is logged either: the request logger leaves out an
  error response's body (a path-parameter validation failure quotes the segment in
  `fields[].value`) and the request body, the error handler's and request logger's error lines
  describe the error without the message of any link in its cause chain, and the `onError`
  context's `Referer` is redacted when its path falls under a prefix. Paths nothing declares are
  written as before. `ServerConfig.logging`, `setRedactPaths`, `parseRedactPaths`,
  `isRedactedPath` and `loggedError` are new.
- **@spfn/core: `.middleware({ logger: { excludePaths, … } })`** — the auto-applied request logger
  takes `RequestLoggerOptions` as well as a boolean, in place. Excluding a path used to mean
  `logger: false` and a `RequestLogger` of your own in `.use()`, which runs after proxy-guard.
- **@spfn/storage: create-only writes — `upload(key, body, contentType, { ifAbsent: true })` and
  `copy(from, to, { ifAbsent: true })` (#172).** The target is created only when the key is empty,
  with each backend's atomic conditional write: S3 `If-None-Match: *` on `PutObject` /
  `CopyObject`, GCS `ifGenerationMatch: 0` on the upload and on the rewrite destination, local
  a temporary file published with `link`, so a local write that fails midway leaves nothing at
  the key and a reader never sees partial bytes (a filesystem without hard links rejects the
  create-only write). The local temporary files live in `LOCAL_STORAGE_DIR/\partial`, a name no
  key can have, so `list` and every read never see a write in progress. The request is sent once,
  never retried (S3 through a client with `maxAttempts: 1`, GCS through a `Storage` with
  `retryOptions.autoRetry: false`): a resent conditional write would read its own landed first
  attempt as "taken". When the store answers that one request with "already exists", the call
  rejects with the new `StorageObjectExistsError` (`key`, `code = 'EEXIST'`) and nothing was
  written. When the outcome is not known — response
  lost, timeout, 5xx, S3 `409 ConditionalRequestConflict` — it rejects with the new
  `StorageWriteOutcomeUnknownError` (`key`, `cause`); the write may have landed and the caller
  reads the key to settle it. A request the SDK reports as never sent rejects with the SDK's own
  error: on S3 a failure before the request reaches the HTTP handler, or a failed DNS lookup or
  TCP connect. What the SDK does not report — a TLS failure, and on GCS any failure without a
  response, a failed connect included (its HTTP client follows redirects itself and reports only
  the last connection's error) — is reported as unknown. Two writers racing for one key never both succeed (on an
  S3-compatible store, only if it honours the header — below).
  `StorageUploadOptions` is new; `StorageCopyOptions` gains `ifAbsent`.
  An S3-compatible store has to honour the header — AWS S3 documents it, SeaweedFS 4.54 was
  measured; on a store that ignores it the create-only write replaces the object and resolves as
  a success, and the provider does not detect it (that would take a second request per write).
  On a GCS endpoint that answers with a redirect the outcome is not guaranteed to be known: the
  SDK follows the redirect itself, a redirected request that fails without a response rejects with
  `StorageWriteOutcomeUnknownError` (read the key before retrying), and a status from the redirect
  target is read as the first request's (a 412 rejects with `StorageObjectExistsError`; a `copy`
  redirected with a 303 can resolve as a `GET`).
  Presigned uploads and `finalizeObject` have no create-only form.
- **@spfn/storage: `createStorageService(options)` returns an independent service (#172)** — a
  second bucket, root or provider beside the default service, with the same surface and no state
  shared with it. Provider fields left out fall back to the same environment variables as the
  default service.

### Changed

- **BREAKING (clients reading `fields[].value`; security-relevant): @spfn/core: the framework's
  validation errors name the field and the rule, and no longer the value (#467).** Every TypeBox
  failure in path parameters, query, headers, cookies, body or form data answered with the submitted
  value in `fields[].value`, and the request logger copies a 4xx response body into its `Request
  completed` line: a password that failed its length rule (`/_auth/register`, `PUT /_auth/password`,
  `/_auth/password/reset/complete`, `/_auth/invitations/accept`), a reset token over 256 characters,
  a malformed token in a header or cookie were written into the response, the logged response body
  of that line, `onError` hooks and the API client's restored error. A field error is now `{ path,
  message }` only: every write of `ValidationError.fields` — its constructor, a subclass's
  `Object.assign(this, data)`, a later assignment — keeps each field's `path` and `message` and
  nothing else (the array and its entries are frozen — a `push`, a sort in place or an assignment to
  an entry throws a `TypeError`; copy first — typed `readonly ValidationFieldError[]`, and `toJSON()`
  sends that). `fields` is an own, enumerable property of each instance, as on `main`, so
  `{ ...error }`, `Object.keys(error)` and own-property serialisers (pino's `err`, Sentry extras)
  carry the reduced list; it cannot be redefined, so a plain-JS subclass's class field `fields = […]`
  or an `Object.defineProperty(error, 'fields', …)` throws a `TypeError` instead of holding the raw
  objects past the setter (TypeScript already refuses such a field, TS2610). So no `ValidationError`
  — the route validator's, one an app throws, or one the API client restores from a body an older
  server sent — carries a value, TypeBox's `schema` or a union's nested `errors`. A restored body whose `fields` is malformed (not an array, an entry
  that is not a `{ path, message }` of strings) is still restored as a `ValidationError`, the
  malformed entries left out, instead of falling back to an `ApiError` carrying the whole body. The
  public type `ValidationFieldError` (`@spfn/core/errors`) is the field's shape; `fields[].value` is
  gone from the type, not left optional. Messages that quoted input no longer do: a body that is not
  JSON answers `Failed to parse JSON` (V8's parser message quotes the body) with no parser text, and
  the file rules answer `File type is not allowed. Allowed: …`, `File size exceeds maximum …`, `Too
  many files. Maximum: …` without the file's type, size or count. TypeBox's own messages quote the
  schema (a limit, `pattern`, `format`, literal), not the input, and still travel. A message the app
  writes travels as written — an error function set with TypeBox's `SetErrorFunction`, which is
  handed the value, or the message of a `ValidationError` the app throws, such as its own password
  rule's: the framework cannot know what that text contains, and whether it carries the value is the
  app's. A client that read `fields[].value` reads the value it sent. What this changes in the
  `Request completed` line is its logged *response* body; the same line's logged *request* body of a
  failed `POST`/`PUT`/`PATCH` is unchanged and masked by field name only, so a value under a name
  the mask does not list (a verification `code`, an email) is still logged — that is #469.
  @spfn/auth's proxy key check and the dev-only `JWE decryption failed` warning (which logged the
  session cookie's first 20 and last 10 characters) carry no input either.
- **BREAKING (two-role databases with jobs): @spfn/core: `initBoss` lets pg-boss install or migrate
  the queue schema only as a role that owns it — or, with nothing installed, may create it — and
  otherwise refuses to start (#171, PR 3 of 3).** pg-boss's default start (`migrate: true`) created
  and migrated `spfn_queue` as the app role, the one place where the owner did not own the
  structure. Before pg-boss starts, `initBoss` now reads the queue schema as the connected role
  (`readQueueSchemaState`) and applies a boot rule: at pg-boss's version (26 for 11.1.2) pg-boss
  starts with `migrate: false`; newer, it starts unmigrated with a warning (`migrate: true`, under
  which pg-boss sends nothing on a newer schema — its own `migrate: false` check refuses any other
  version and would take old pods down in a rolling deploy); older, with the schema and every object in it
  owned by the app role, or nothing installed where the app role may `CREATE` on the database and no other role owns the
  schema, pg-boss installs or migrates it as before; anything else — not installed or older and
  the app role may not change it, its version unreadable, older than the oldest version pg-boss
  migrates from (for one-role apps too: pg-boss applied its 25→26 statements to a 24 and stamped it
  26 — this is `QueueSchemaVersionError`, now a `JobQueueSchemaError`, with the answer
  `queueMigrationSql` gives), or a schema holding objects that are not pg-boss's — throws `JobQueueSchemaError` (`schema`, `installed`, `required`, `step`: the owner's
  step that resolves it, `owner` or `grant`, or `null` where none does) before the server
  listens, naming the versions and `spfn db migrate`/`push` or `spfn db grant` — with the role
  that owns the queue, which `DATABASE_OWNER_URL` has to connect as, where one role other than the
  app role owns all of it. Where ownership is split — the app role owning part of such a queue (the
  schema, objects in it, or an empty schema it may not install into), or two roles or more other
  than the app role owning parts — the owner step changes nothing (it prints the ownership
  transfer), so the refusal names every role that owns part and that transfer instead, from the
  same function (`queueOwnershipTransfer`), with `step` `null`.
  pg-boss's install, migration or version check runs on an instance of its own that supervises
  and schedules nothing, stopped — its pool closed where its start failed — before the running
  instance starts; where that step fails, the schema is read again and a changed answer acted on
  once. `initBoss` compares
  `spfn.jobs` in `package.json` with the schema `.jobs()` uses; where they differ (no
  declaration, another schema, or one that cannot be read), a refusal says how to declare it, and
  a start on a queue the app role does not own warns — an app that installs or owns its queue,
  every one-role app, logs nothing new.
  The detailed health payload adds `queue` (`schema`, `installed`, `required`, `start`,
  `checkedAt`), the queue schema as boot read it. New exports from `@spfn/core/job`:
  `JobQueueSchemaError`, `queueStart(state, role, declared)` (the rule as a pure function),
  `ownsQueue(state)` and types `QueueStart`, `QueueSchemaStep`; `QueueSchemaState` gains `ownsObjects`,
  `ownedBy`, `owners` and `bootstrapOwned`. From `@spfn/core/db`: `queueOwnershipTransfer(owners,
  target, bootstrapObjects?)` — the transfer the owner step and the boot both print; `owners` every
  role that owns part, the bootstrap superuser's objects moved one by one — its parts
  `reassignOwnedLine`, `alterOwnerLines`, which `spfn db push`'s ownership remedy prints too, and
  type `OwnedObject`.
  - **Who is affected:** an app with `.jobs()` whose server role may not `CREATE` on the database and
    whose queue schema the owner has not installed, or an app whose server role does not own a queue
    schema older than pg-boss's and every object in it. It used to fail at boot on a raw `permission denied` / `must be owner`;
    it now fails with the command to run: declare `"spfn": { "jobs": true }` (or `{ "schema": "<name>" }`)
    in `package.json` and run `spfn db migrate` (or `spfn db push`) with `DATABASE_OWNER_URL` set,
    then `spfn db grant` where the refusal names it. A two-role app that still grants its server role
    `CREATE` on the database and whose queue the owner installed stops sending structure statements;
    revoke that `CREATE` once the owner installed the queue. A schema of the queue's name holding a
    project's table, and a queue schema name pg-boss's SQL cannot carry (upper case, a PostgreSQL
    keyword, `pg_…`: `QueueSchemaNameError`), are refused at boot for every app.
  - **Order for a two-role app:** this ships in one release with the owner step (#456, `spfn db
    migrate`/`push`/`grant` install, migrate and grant the queue), which the refusals name. Upgrade
    the CLI and run `spfn db migrate` (or `spfn db push`) with `DATABASE_OWNER_URL` set first, then
    deploy the app on the new `@spfn/core`: deployed first, it is refused at boot until that step
    has run, and an older CLI's `db migrate` does not touch the queue.
  - **Not affected:** one-role apps (`spfn dev` with one URL) — the app owns or may create the
    queue, so it installs and migrates it as before — and two-role deployments where the app role
    installed the queue earlier: it owns it, so it still migrates it at boot.
  - Partitioned queues are not supported under the role split: attaching a partition to `job`
    needs its owner.
- **spfn, @spfn/core: `spfn db status` reports the queue schema and compares the app role's
  privileges there (#171).** `checkAppPrivileges` read only the managed schemas and took the app
  role's ownership for the owner's, so a queue target compared nothing; it now reads what the grant
  step reads (`readManagedObjects`: the queue schema and its functions too) and takes the owner to
  own every schema, so the queue is compared by the plan's queue rule (`kind: "function"` drift for
  `EXECUTE`). With `spfn.jobs` declared, `db status` adds the queue schema to its comparison and a
  queue section — installed version against the one this build needs, owner, what the app role may
  do there, and how the server would start on it (the boot rule itself). The human form's exit
  code: a queue the server refuses until the owner's step runs — not installed, older than
  pg-boss's, its version unreadable — is reported as pending migrations are, exit 0, since the
  next `spfn db migrate` (or `spfn db grant`) resolves it; exit 1 stays for what `db status` exited
  1 for before (not configured, unreachable, bookkeeping mismatch, permission denied) and for the
  queue states no command resolves: a schema holding objects that are not pg-boss's, a version
  pg-boss cannot migrate from, a queue whose ownership is split. A project that declares jobs and
  has no table of its own is compared as `db grant` grants it, its queue checked. `--json`, additive: `queue` (`checked`, `schema`, `required`,
  `installed`, `owner`, `owners`, `appRole`, `database`, `appOwnsQueue`, `appMayCreateOnDatabase`,
  `notPgBoss`, `start`, `refusal`, `refusalStep` — `owner`, `grant` or `null`; `{ checked: false,
  detail, schema? }` when unreadable); absent without a declaration.
- **BREAKING (source): @spfn/auth: `SignInRefusedError` and `PasswordChangeRefusedError` take the
  shape their body has — `new SignInRefusedError({ details: { code } })`, not `{ code }` (#459).**
  `ErrorRegistry.deserialize` hands a constructor the fields where `toJSON()` put them, and these
  two put `code` in `details`; a constructor that took `{ code }` rebuilt the refusal without it
  (see Fixed). A call with `{ code }` no longer compiles. Apps answer refusals from the `admit`
  hooks with `{ refuse: { code } }`, which is unchanged; only code that constructs these two classes
  itself has to move `code` into `details`.
- **BREAKING (security-relevant): @spfn/core: `DuplicateEntryError`'s `value` no longer reaches the
  client (#459).** Its message and `details` already left the value out — echoing an email back
  confirms it exists — but `value` was a public field, so the body carried it all the same and the
  client restored it. It is now a getter over a private field: `error.value` still reads it on the
  server, `toJSON()` no longer sends it, and an error the client restored has none. Only `field`
  names what collided.
- **BREAKING (deployment, security-relevant): @spfn/core: `TRUSTED_PROXY_HOPS=0` declares that
  nothing stands in front of the Next.js app, and an invalid value is refused (#451).** Every value
  that was not a positive integer was read as `1`, and the forwarded-chain reader clamped to at
  least one hop, so an app with nothing in front could not say so. Next.js writes `X-Forwarded-For`
  only when the request carries none, so the proxy signed, and a server-side `createApi` call
  asserted, the last entry of a header the browser wrote, and the backend's `getClientIp` answered
  the address the visitor chose. Now:
  - `0` trusts no entry: the proxy signs its request with no client address and a server-side call
    asserts none. Proxy-guard verifies such a request as any other, sets no `proxyClientIp`, and
    `getClientIp` answers by the backend's own rule — the TCP peer, or `SERVER_TRUSTED_PROXY_HOPS`
    — that is, the Next.js server's address. Next.js 16 gives a route handler no API for the
    connection's address, so with nothing in front the visitor's address is not attested. Every
    per-address limit (`@spfn/auth`'s sign-in limits included, keyed on `getClientIp`) is then
    shared by all visitors, so one visitor can use it up for everyone; a deployment that needs
    per-visitor limits puts a proxy in front and declares it. **A deployment with nothing in front
    of the Next.js app must set `TRUSTED_PROXY_HOPS=0`**; the default stays `1`.
  - **An app that already set `TRUSTED_PROXY_HOPS=0`** was read as `1` until now; on upgrade it
    stops attesting visitor addresses. If a proxy is in front, set its real count.
  - Anything but a whole number of 0 or more (`-1`, `1.5`, `one`) is refused by the env schema's
    validator, as `SERVER_TRUSTED_PROXY_HOPS` is. The value is not cached: in the Next.js app every
    request that reads it is refused — the proxy answers 500, a server-side call throws — and logs
    `TRUSTED_PROXY_HOPS validation failed`, until the value is corrected. The backend's boot check,
    which reads core's whole schema, refuses to start.
  - `clientIpFromForwardedChain(xff, 0)` names no client (it named the rightmost entry). The
    backend's `getClientIp` never passes it `0`, so its answers do not change.
- **BREAKING (two-role databases): spfn, @spfn/core: the app role holds `USAGE` on each managed
  schema and nothing else — `spfn db grant`, and the privileges step of `db push`, `db migrate` and
  `spfn add`, revoke the rest; `db status` reports it (#435).** On 0.4.0-beta.2 the step compared
  each relation's access list with its declaration, but of a schema it asked only whether the role
  could use it, and granted `USAGE` where it could not: a `GRANT CREATE ON SCHEMA … TO <app role>`
  stayed, the app could create — and so own, and alter, and drop — tables there, and `db status`
  said "holds what is declared". The step now reads each managed schema's access list as it reads a
  relation's and, on the project's schemas, each function package's and `drizzle`, revokes what the
  schema's owner gave the app role or the read role beyond `USAGE` — `CREATE`, and the grant option
  of `USAGE` (`REVOKE CREATE ON SCHEMA …`, `REVOKE GRANT OPTION FOR USAGE ON SCHEMA …`) — and the
  `CREATE` it gave PUBLIC, except on `public`, where PUBLIC is every role of the database and the
  existing warning stays. `USAGE` is never revoked, PUBLIC's included. What reaches the role
  through a group role, from another grantor, or through PUBLIC from another grantor is reported,
  never revoked. Every `REVOKE` is plain: one PostgreSQL refuses because the app passed the
  privilege on (2BP01) changes nothing and is reported as on a table. The app role or the read role
  that owns a schema, or inherits its owner, gets no statement there, and the step names it
  (`db status` names one the app role owns, never one the read role owns); the other role, and
  PUBLIC, are planned there as on any schema — on a schema the read role owns the app role still
  gets `USAGE` (or the step is blocked, the schema named, when the owner role cannot grant there),
  and `db status` reports it when it lacks it. A table the app role already created in such a schema
  stays its own — PostgreSQL's `REVOKE CREATE` takes no table — and, as before, blocks `db grant`
  (exit 1, the table named) unless the owner role may grant on it; `db status` counts it as owned.
  **On upgrade**, a deployment whose app role holds `CREATE` on a managed schema, or `USAGE` there
  with its grant option, loses it at the next push, migrate, add or `db grant`: an app that creates
  tables at run time in a managed schema fails with 42501 — create them in a migration instead. So
  does a migration the server runs itself, as the `afterInfrastructure` example of
  `@spfn/core/server` showed (`migrate(getDatabase(), …)`): the server connects as the app role,
  which changes no structure — run `spfn db migrate` as the owner before it starts. Only a
  single-role project (no `DATABASE_OWNER_URL`, its `DATABASE_URL` role owning the tables) may still
  migrate there; the example and the server README now say so.
  `db status --json`'s `privileges` gains `schemaDrift: [{ schema, grantee, through, excess,
  grantOption }]`, `schemaHeldElsewhere: [{ schema, privilege, through }]` and `ownedSchemas`;
  "holds what is declared" now needs the first two empty. `@spfn/core/db`: `CatalogSchema` gains
  `owner` and `grants`; `AppPrivilegesPlan` gains `schemaChanges`, `ownedSchemas`,
  `schemaHeldElsewhere` and `foreignOwnedSchemas` (a schema with something to revoke that the
  owner cannot revoke on blocks the plan, as a foreign-owned table does); `RevokeGrantsByOthers.name`
  is absent for a REVOKE on a schema; `AppPrivilegesCheck` gains `schemaDrift`,
  `schemaHeldElsewhere` and `ownedSchemas`.
- **@spfn/storage: `getStorageService(options)` rejects options that differ from the first
  call's (#172).** It is the default service and never reconfigures; a later call with other
  options used to return the first service silently. Calls without options, or with equal ones,
  return it as before. Concurrent first calls now share one service instead of each creating one.
- **BREAKING: @spfn/storage: `getStorageService(options)` rejects options that configure a
  different service from the default one (#172).** Exact condition: the default service exists,
  the later call passes `options`, and the effective configuration those options resolve to — the
  selected provider (`options.provider`, else `STORAGE_PROVIDER`, else `s3` in production and
  `local` otherwise; any value other than `local` and `gcs` selects `s3`) and that provider's fields after their `S3_*` / `GCS_*` / `LOCAL_STORAGE_*`
  fallback and defaults (`local.dir` as an absolute path, trailing `/` trimmed from base URLs,
  GCS credentials decoded) — is not deep-equal to the one the default service was created from.
  Such a call used to return the first service silently; it now rejects, which fails a boot that
  configures the default service twice with different settings. How the options are spelled does
  not matter: a missing field and an explicit `undefined`, an environment value left out or written
  out, and options for an unselected provider configure the same service. Nothing the SDK
  derives later is derived for the comparison: a GCS `projectId` left out (the SDK reads it from
  the credentials or the environment) against one written out, or an S3 `endpoint` with and
  without a trailing `/`, compare unequal and reject. Calls without options
  return the default service as before. Concurrent first calls now share one service instead of
  each creating one.

- **@spfn/auth: the "API access" line no longer carries the user's e-mail address (#429).** The
  info line `@spfn/auth:middleware` writes for each request `authenticate` admits, by Bearer or by
  clientProofV1, and each one `optionalAuth` admits by clientProofV1 (its Bearer path writes no
  such line), logged `email` beside `userId`; it now logs `userId`, `keyId`, `method`, `path`, `ip`
  and `userAgent` (and `scheme` on the proven path), and no address. There is no setting: `userId`
  finds the account, and an app could not shape a line the package writes. A log query or alert
  that read `email` from this line reads `userId` instead. Its `path` is now read through
  `loggedPath(c)`, so a prefix declared with `defineServerConfig().logging({ redactPaths })` is
  redacted in it as in core's own lines. Both are held by a test row per authentication path.
- **@spfn/auth: the "Missing or invalid authorization header" line names the request's headers,
  not their values (#429).** The error line `authenticate` writes for a request without a Bearer
  `Authorization` header logged `headers` — every header of the request with its value, a session
  `Cookie` among them — and the raw path. It now logs `headerNames`, the sorted names of the
  headers that arrived, which is what tells a forward that dropped `Authorization` apart, and
  `path` through `loggedPath(c)`. A log query that read a header's value from this line has no
  replacement: the value is the secret. Held by a test row.
- **BREAKING (two-role databases): spfn: the app role's privileges on the managed tables are reset
  to the declared set by `db push`, `db migrate`, `spfn add` and `spfn db grant` (#405).** Every
  privilege the owner granted the app role on a managed table beyond its declaration is revoked —
  a hand-granted `TRUNCATE`, `REFERENCES` or `TRIGGER`, a column grant, any write on the `drizzle`
  bookkeeping (the multi-tenancy guide's database-wide `ALTER DEFAULT PRIVILEGES` gave it one), a
  grant option — and so is every grant to PUBLIC there. A read role (`DATABASE_READ_URL` connecting
  as another role) is brought to exactly `USAGE` on the schemas and `SELECT` on the tables whose set
  has it: anything else the owner granted it there — a write, a grant on a sequence or on
  `drizzle` — is revoked too. One that reaches either role through a group role is reported, not
  revoked. On a view a write through which runs with its owner's rights, the app role keeps
  `SELECT` only: a write granted on such a view is a write on every table under it, whatever those
  tables declare. That is any view not created `WITH (security_invoker)` (PostgreSQL 15+), and also
  a `security_invoker` view with a rule other than its SELECT rule — PostgreSQL applies
  `security_invoker` to the SELECT rule only, and a `DO INSTEAD INSERT` rule writes as the owner —
  or with an INSTEAD OF trigger, whose function may be SECURITY DEFINER. An app that writes
  through a view makes it `security_invoker`, with neither, or writes the table; a view that is
  not `security_invoker`, read as its owner, also reads past the row-level security of the tables
  under it. A privilege revoked by hand that the table does not declare away is granted again:
  declare it first (`appPrivileges(table, ['select', 'insert'])`, then `spfn db generate`), then
  push or migrate. Single-role setups (no `DATABASE_OWNER_URL`) see one note and no change.
- **BREAKING: spfn: `spfn db generate` with a project `drizzle.config.ts` loads the schema modules
  itself, as ESM, the way `db push` and `spfn dev` do (#405).** Before, with its own config, it
  handed the file to drizzle-kit and loaded no entity in its own process. It now writes
  `privileges.json`, and an `appPrivileges` declaration lives on the table object, not in the
  source text, so every schema module is imported here, under the CLI's module hook, before
  drizzle-kit runs; the config's `schema` and `out` are read the same way. An entity that only
  drizzle-kit's loader could run — it reads `__dirname` or `__filename`, or calls `require` — now
  stops `db generate` with the module's error (exit 1, before drizzle-kit writes anything). The
  remedy is the ESM form: `import.meta.dirname`, `import.meta.filename`, `import`.
- **BREAKING (two-role databases): spfn: every command that changes the schema connects as the
  table owner (#405).** `spfn db push` — its `--dry-run` and the function package migrations it
  applies too — and `spfn add` connect with `DATABASE_OWNER_URL`, else `DATABASE_URL`, as `db
  migrate`, `backup`, `restore`, `drop` and `tenant import` already did. Without
  `DATABASE_OWNER_URL` nothing changes. The dry run plans as the role that will apply the plan:
  drizzle-kit sees only the schemas its role may use. A database whose tables were pushed the old
  way, through `DATABASE_URL` as the app role, has them owned by the app role, and `db push` now
  fails with `Invalid query (42501)` — already while it plans, when drizzle-kit's data-loss check
  reads a table it drops a column of, or at the first statement that alters one. A database error
  at any stage of push — planning, a package's migrations, the project statements — now ends the
  same way: exit 1, the stage named, the error as the CLI prints every database error; one raised
  while planning was thrown raw, with the driver's `Failed query: … params:` line. When `DATABASE_OWNER_URL` is set apart from `DATABASE_URL`, push then
  asks the catalog which schemas and tables it manages another role owns, and if any prints the
  remedy under the failed line with the role names and the objects, first the relation the failed
  statement acts on (the table after `ALTER TABLE`, `CREATE INDEX … ON`, never a column or a
  referenced table), then `REASSIGN OWNED BY <their owner> TO <connected role>`, and for each object
  the bootstrap superuser owns — tables created through a superuser's URL, which `REASSIGN OWNED`
  refuses — `ALTER TABLE|SEQUENCE|VIEW|… <object> OWNER TO <connected role>;`, to run as a
  superuser. Extension members, sequences a column owns (they follow their table) and initdb's
  objects are left out. Any other 42501 adds nothing.
  Move them to the owner once, as a superuser or
  a role that is a member of both: `REASSIGN OWNED BY <app role> TO <owner role>` (the `@spfn/core`
  db README, "Database roles"). Which connection each command uses is one table in the CLI
  (`src/utils/database-connection.ts`; the CLI README, "Which connection each command uses"):
  every command that opens a connection or writes a drizzle config reads its URL through it —
  `db status`, `db generate`/`check` and `db studio` included — so `db push` and `db tenant
  import`/`export` also build their schema config with their own URL and work with
  `DATABASE_OWNER_URL` (or `DATABASE_READ_URL`) alone. `db studio` loads the `.env` files before
  it checks for a URL. `executeFunctionMigrations(plans, url)` and
  `createPushConnection(url, options)` take the URL as a required argument.
- **spfn: only the commands that connect as the owner load `DATABASE_OWNER_URL` from an `.env`
  file (#405).** Each command in the connection table loads the files through it, and only the
  `owner` rows pass `loadEnv({ ownerCredentials: true })`: `db status`, the `spfn dev`/`start`
  pre-start check and every other command see it only when the shell exports it. `spfn add` now
  loads the `.env` files before it looks for a URL; it read only the shell's before. Every command
  the table lists as `app` — `db status`, `generate`, `check`, `studio`, `tenant export`, `spfn
  dev`, `spfn start`, `spfn provision` — removes an inherited `DATABASE_OWNER_URL` from its own
  process at its entry, silently, so the `spfn dev`/`start` pre-start check and every process they
  start (the server, Next.js, the codegen watcher, the provisioning runner) run without it; `spfn
  dev` and `spfn provision` also keep a keychain reference to it in `.env.server` out of their
  children's environment. For local development keep it in
  `.env.server`, which Next.js never reads, or export it; in production give it only to the
  migrate job.
- **spfn: the temporary drizzle config is readable by its owner only and never outlives the
  command (#405).** `db generate`, `db check`, `db drop` and `db studio` still write
  `drizzle.config.<pid>.<time>.temp.ts` when the project has no `drizzle.config.ts`, with a
  database URL in it. It is now created exclusively with mode 0600 and removed when drizzle-kit
  exits, when the CLI process exits, and on SIGINT, SIGTERM and SIGHUP (the process still ends by
  the signal). It was world-readable under the usual umask and survived a crash or a signal. A
  SIGKILL still leaves it behind, so `spfn init`/`spfn create` add `drizzle.config.*.temp.ts` to
  the app's `.gitignore` and to the `.dockerignore` it writes, as do the repository's and the
  examples' own `.gitignore`.
- **@spfn/core: the server never holds `DATABASE_OWNER_URL` (#405).** `loadEnv()` no longer loads
  it from an `.env` file unless the caller passes `ownerCredentials: true`, which only the spfn
  schema commands do: the server, `createServer`, the serverless app, `provisionInfrastructure`, a
  later `loadEnv()` and app code leave it out of `process.env`, and the first such load in a
  process writes one line naming the file, never the value, to stderr (`DATABASE_OWNER_URL is in
  .env.server; the server does not load it; spfn db commands that change the schema do.`): a
  loader's diagnostic, logged at `warn` because core's logger writes `info` to stdout, which is a
  command's output — `spfn db status --json` prints one object there and nothing else.
  `@spfn/core/config` exports the variable's name, `DATABASE_OWNER_URL`, for the loader, the
  server entries and the CLI. Inherited from the environment the process was started with, it is
  removed at the start of
  `startServer`, `createServer`, the serverless app and `provisionInfrastructure`, before any app
  code runs, with one warning about that environment.
- **BREAKING: @spfn/core: the Next.js API client's and RPC proxy's failure lines no longer carry the
  URL (spfn/spfn#164).** A GET call's URL holds its whole input in `?input=` — params, query and
  body — and the proxy's target URL the forwarded query, and the lines are written at error level.
  The client's `Request timeout` and `Network error` lines drop `url` (they keep `route`, `method`
  and `timeout`); the proxy's `Request timeout` and `Fetch error` lines drop `targetUrl` (they keep
  `routeName`). The debug lines `→ Request` (client) and `→ RPC request` (proxy) drop them too. A
  log query on those fields needs `route` / `routeName` instead. `ApiError.url` is unchanged. The
  proxy's two debug lines that named the path with its params filled in — `→ RPC request`'s
  `targetPath` and `Found N matching interceptors for <method> <path>` — name the route's pattern
  (`/api/import/:token`) and `routeName` instead: the proxy cannot know which of the server's
  paths `logging.redactPaths` declares, so it writes no param value at any level.
- **BREAKING: @spfn/core: `RequestLogger`'s `excludePaths` matches the decoded path the router
  serves (spfn/spfn#164).** It matched the undecoded URL path, so `/api/%69mport/x` was served by
  `/api/import/:token` and logged despite `excludePaths: ['/api/import']`. Percent-encoded spellings
  of an excluded path are now excluded too, which changes log volume. The request logger's `path`
  field is the decoded path as well — the one every other core line already wrote — so a
  percent-encoded request's line reads `/files/a b` where it read `/files/a%20b`.
- **BREAKING (deployment, security-relevant): @spfn/core: the proxy signature covers the client
  address, and a server-side call asserts the browser's (#363).** A sign-in made by a server
  component, server action or route handler recorded the Next.js server's address — in
  `registeredIp`, in the sign-in guard's `attempt.ip`, and as the key of every per-IP limit —
  because its call reaches the app's own proxy as a new request from the server. And the backend
  believed `x-spfn-proxy-client-ip` on any verified request although the signature did not cover
  it.
  - The proxy signs **version 2** (`x-spfn-proxy-signature-version: 2`): the canonical string
    gains a seventh field, the `x-spfn-proxy-client-ip` value or `''`. Proxy-guard hands the
    address on as `c.get('proxyClientIp')` only under a verified version-2 signature, and
    `getClientIp` reads that, never the header: a `clientType` set by anything but proxy-guard
    (`'mobile'` from client proof) no longer makes the header believed. `callBackend` signs the
    address it sends too.
  - Server-side, `createApi` reads the browser's address off the inbound request with the
    proxy's own rule (`TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For`, one shared
    helper) and sends `x-spfn-forwarded-client: <ip>;<timestamp>;<hmac>`, keyed with
    `SPFN_PROXY_SECRET` over a fixed label, method, path, address and timestamp. The proxy uses
    an assertion it verifies (30 seconds either side of the timestamp); an absent or invalid one
    changes nothing. Within the window an assertion is believed on its method and path as often
    as it is replayed: the proxy keeps no nonce store, so the format has no nonce. One assertion
    is made per inbound request and target and reused by every call of that request, so Next's
    request dedupe still works; a call cached across requests (`next.revalidate`, `next.tags`,
    `cache: 'force-cache'`) asserts nothing and reaches the backend from the Next.js server's
    address, as before. Without `SPFN_PROXY_SECRET` nothing is asserted and the backend sees
    what it saw before.
    The client loads the signer by dynamic import from a new subpath,
    `@spfn/core/nextjs/server-call`, whose `browser` export condition resolves to an empty stub,
    so no signing code reaches a browser bundle.
  - **Version 1 is accepted through 0.4.x only, and its address is ignored**: a request with no
    version header (or `1`) is still verified and tagged `web`, the address dropped, and the
    backend logs one warning per process. The path is `signatureVersion`,
    `computeLegacySignature` and `buildLegacyCanonicalString` in
    `packages/core/src/security/proxy-signature.ts` and `believeSignedAddress` in
    `packages/core/src/middleware/proxy-guard.ts`; 0.5.0 removes it and refuses version 1. Any
    other version is refused (`unknown-version`).
  - **Upgrade order:** the backend first, then the Next.js app **immediately after**. A new
    backend verifies an old proxy's version-1 signature but ignores its address, so until the app
    is upgraded `getClientIp` falls back to `X-Forwarded-For` by `SERVER_TRUSTED_PROXY_HOPS` or
    to the socket address — in a usual deployment the Next.js server's address, **the same one
    for every user**: every `ip:` rate-limit bucket and the sign-in guard's `attempt.ip` key on
    that one shared address for the whole window, so one user's failures count against all. An
    old backend refuses every request a new proxy signs (403 in `strict`, `untrusted` in `tag`),
    so the app cannot go first.
  - `buildCanonicalString` and `SignatureParts` gain `clientIp`; `signProxyRequest` takes
    `clientIp` and returns the version header; `verifyProxyRequest` takes `version` and
    `clientIp` and answers `version`.

- **BREAKING: @spfn/core: a failed job's `output` is the error's description (#382).** Core's
  fetch loop fails a batch with `describeError(error)` instead of the error, so pg-boss no longer
  serialises drizzle's `params` or the driver's `detail` into the job row. The `output` of a failed
  job is `{ kind, name, message, code, statusCode, stack, cause }` (`stack` frames only; `code` a
  string or number, `statusCode` a number, each only when the error has one; no other field of the
  error, so an app error's `details` are gone), or for a database error
  `{ kind: 'database', name, code, constraint, table, …, sql, paramCount, stack }`.
- **BREAKING: @spfn/core: outside production, a database error's 500 body is
  `{ __type: 'Error', message: 'Database error', database }` (#382).** `database` is the error's
  description; the body no longer carries its message, `cause` or `stack`, which hold the bound
  values. This applies wherever `includeStack` is true (`NODE_ENV !== 'production'`, staging
  included). The production body is unchanged; so is the request logger's copy of it.
- **BREAKING: @spfn/core: `fromPostgresError` (and so `Transactional()`) gives a typed error the
  driver's message only where the description keeps it, and the driver error as its `cause`
  (#382).** A class-22 message quotes the rejected input (`invalid input syntax for type uuid:
  "…"`) and reached the production error-level "Error occurred" line. Now the message is the
  driver's for SQLSTATE classes 08, 23, 40, 53 and 57 raised by a known server routine, and
  otherwise: `ConnectionError` — `Database connection failed` (08), `Insufficient database
  resources` (53), `Database operation interrupted` (57); `ConstraintViolationError` —
  `Integrity constraint violated`; `TransactionError` / `DeadlockError` — `Transaction failed`;
  `QueryError` 400 — `Invalid query` (42); `QueryError` 500 — `Invalid input value` (22),
  `Database connection lost` (a postgres.js connection code), `Database query failed` (anything
  else, including a wrapped drizzle error whose cause keeps no message). `DuplicateEntryError`'s
  message is unchanged. Which typed error each code maps to is unchanged. The `DatabaseError`
  family's constructors take an optional `cause`.
- **BREAKING: @spfn/core: `RepositoryError.message` is `<Repository>.<method> failed` (#382).** The
  caught error is its `cause` (still also `originalError`), and its stack is its own: it no longer
  copies the caught error's message or stack, which for a drizzle error carry every bound value.
- **BREAKING: @spfn/core: "Transaction rolled back" is logged at debug, not error (#382).** The
  runner rethrows the error untouched and its owner logs it at the level it deserves (the error
  handler at warn for a 4xx and error for a 5xx, a job at error). "Slow transaction rolled back"
  stays at warn. Alerting keyed on an error-level "Transaction rolled back" stops firing.
- **BREAKING: @spfn/core: `LogMetadata.error` is an `ErrorDescription | DatabaseErrorDescription`,
  not an `Error` (#382).** The logger describes every error it is handed — as the error argument or
  anywhere in the context — before a transport sees it; the console and JSON formatters print
  descriptions. A custom `Transport` reading `metadata.error.stack` gets frames only. The rollback
  lines' `errorType` field is gone (the description's `name`). Out of core's reach: drizzle's
  OpenTelemetry tracing still sets `drizzle.query.params` on its spans.
- **BREAKING: @spfn/core: which logger argument is the caught value is decided by position, not by
  its shape (#382).** `logger.error(message, caught, context)`: the second argument is the caught
  value whatever it is (`undefined`, a string, a plain object), and the context is always kept —
  it used to be dropped when the value was not an Error. `logger.error(message, value)`: an Error
  (or a primitive) is the caught value, any other object the context. An object with a string
  `stack` is no longer read as an error, as the argument or inside the context. An object under
  `error`, `err`, `cause` or `reason`, at any depth of the context, is described whatever its
  shape, and so is each object in an array or a Set under `errors` — except under a body marked
  `alreadySentToClient` (see its entry above). A primitive there is data and logged as it is
  (`reason: 'timeout'` stays the string, `error: null` stays `null`).
- **BREAKING: @spfn/core: log line shapes (#382).** Each change, against the last release:
  - JSON `error`: `{ kind: 'error' | 'database', name, … }` with `stack` frames only, not
    `{ name, message, stack }`.
  - An Error's string `cause`: an object `{ kind: 'error', name: 'NonError', message }`
    (`Caused by: NonError: …`), not the bare string.
  - An Error inside the context: its description, not `{}`.
  - A `Map` in the context: its `[key, value]` pairs, not `{}`; a `Set`: its values, not `{}`.
  - A thrown string or number logged as the error: `{ kind: 'error', name: 'NonError', message }`
    with no stack, not an Error wrapped at the log site with that site's stack.
  - A thrown non-Error object: its class name (`NonError` for a plain one), string `message` and
    `code` only, not the whole object JSON-stringified into the message.
  - The error handler's production line: the error is `context.error`, its description without
    stack frames, not `message` and a `cause` text in the context.
  - 11 core lines that put `error: err.message` / `String(err)` (or `errorName` / `errorMessage`)
    into the context and 20 that passed a caught Error as the second argument (cache close,
    WebSocket handlers, pg-boss error and stop, server hooks and shutdown, uncaught exception,
    cleanup, the error handler's failed `onError` callback) carry the description under `context.error`; 7 more already kept it under
    `context.error` as a description instead of a string (cache factory, cache transport, rate
    limit, state event, client debug logs). The console prints a described context value on its
    own lines after the message.
  - 14 more core lines that logged a copy of the caught value (`const err = error as Error`,
    `new Error(String(error))`) or of its text carry the description under `context.error`:
    server initialization and both graceful-shutdown lines; the database write connect, replica
    fallback, connection close, health check and its reconnect attempts, forced reconnect and the
    error reporter's own failure; the RPC proxy's fetch and proxy errors (no separate `stack`
    field); the client's network error (no `errorName`) and inbound-request read (no `message` /
    `name`). Two lines move the error's text from the message to `context.error`: the tenancy
    check's "Could not check the database role…" and a lazily validated environment variable's
    "… validation failed" (a sensitive key's line still carries no error). The codegen watchers'
    two "Cannot watch …" lines keep the errno code in the message, print `no code` instead of the
    error's text when it has none, and carry the error under `context.error`. Database connection creation and provider close keep the error
    as their second argument — the caught value itself, not an Error made from its text.
  - A failed job's `output`: see its entry above.
- **BREAKING: @spfn/auth: the OAuth error redirect carries a typed error's text, and a fixed
  sentence for any other error (#382).** A sign-in callback that failed on anything but a
  `SerializableError` meant for the client (not marked `internal`) put the error's message into the
  redirect's `error` parameter — for a failed statement its SQL and every bound value, in the
  browser's address bar and the app's access logs. The parameter is now `OAuth callback failed`
  (`OAuth link failed` when the link state could not be read); `reason` is unchanged (`failed`), and
  typed errors keep their text and their reason. A missing role (`Default user role not found…`)
  is one of those errors: its page now shows the fixed sentence. `@spfn/auth:service` logs every
  error the redirect answers, and every failure of a link callback (whose redirect carries only
  `oauthLink=failed`), with its description, by core's error handler's rule (`errorLogLevel`): error
  level for an untyped error or a typed 5xx, warn for a refusal (the fixed sentence is the line's
  message).
  `oauthFailureUrl(error, fallback)` from `@spfn/auth/server` builds that redirect beside
  `buildOAuthErrorUrl`.
- **BREAKING: @spfn/auth: log lines hand the caught error to core's logger (#382).** The context
  key `reason` (Kakao and Naver user-info lookup, id_token verification) is now `error`, and with
  the session-info, session and pending-session validation, OAuth provider call, Next.js OAuth
  callback and admin-account create lines it holds the error's description, not its message. The
  passkey boot line ("…so boot continues.") moves the error's text from the message to
  `context.error`. Not changed here: the info-level "API access" line of
  `@spfn/auth:middleware`, which logged the account's `email` on each request it was written for
  until #429 (above) removed it.
- **BREAKING: @spfn/monitor: groups, events and the Slack message hold the error's description, and
  the fingerprint is the fault, not the message (#382).** `error_groups.message` stored the error's
  message and `error_events.stack_trace` its stack, the Slack message sent both, and the group was
  fingerprinted on the message: a failed statement's SQL and bound values were stored, sent, and
  split one fault into a group per value. Now:
  - `generateFingerprint(description, path)` (was `(name, message, path)`) hashes the route path,
    each link of the cause chain by its name, code, constraint and table, and the top three stack
    frames by the place in code they name: no line and column, a dependency's file from the last
    `node_modules/` on (no pnpm version-and-hash directory), app code relative to the working
    directory (a `file://` frame read as the path it names) — so a dependency bump keeps every
    group, and a release-directory deploy does when the process's working directory is inside the
    release directory and the code runs from it (not with a working directory of `/`, not for a
    workspace package outside the working directory).
  - `error_groups.name` is the description's name, `error_groups.message` one line naming the fault
    (`Name [code=…] [constraint=…] [table=…]: message`, per link of the cause chain, the message only
    where the description kept one).
  - `error_events.stack_trace` is the description as indented JSON.
  - The Slack message carries the group's line and the description's top three frames.

  Existing rows are not migrated. New events of a fault tracked before this release open a new group
  once (its fingerprint changed); the old group keeps its count and stops growing. A group an
  operator marked `ignored` is no exception: its fault comes back once as a new `active` group and
  sends one Slack alert. Mark that new group `ignored` again; it stays quiet from then on.
  The dashboard's event preview shows the group's line for the event (`summarizeError` over the
  stored description: per link of the cause chain its name, code, constraint and table, and a kept
  message — so a wrapped database error shows its cause's code, a plain error its message, a thrown
  non-Error value what its description holds) and its top three frames, not the first lines of the
  stored JSON. An event stored before this release (a raw stack)
  previews as its error's name and its V8 frame lines (indented, of the frame grammar — not every
  line starting `at `), not its first five lines, whose header and `params:` line held a failed
  statement's SQL and bound values. A group stored before this release keeps its `message` as
  stored — the raw message, for a failed statement its SQL and bound values — and the list and detail
  views show it. No new event matches an old group, so deleting the groups first seen before the
  upgrade removes that text; their events go with them.
- **BREAKING: @spfn/workflow: a failed step's `error` is the error's description as JSON text
  (#382).** `executions.error`, `step_executions.error` and the `error` of the `step.failed` and
  `failed` events held the error's message — for a failed statement its SQL and bound values. They
  now hold `JSON.stringify(describeError(error, { stack: false }))`; no schema change. The default
  logger (`defaultLogger`) is core's logger as `@spfn/workflow`, not the console, which printed the
  error object whole; the engine hands a caught error to any logger as `{ error }` (was the error as
  the second argument), and its messages lose their trailing colon.
- **BREAKING: @spfn/notification: the error Slack message and a failed send guard's row hold the
  error's description (#382).** `createErrorSlackNotifier`'s default message quoted the error's
  message and the lines after its stack header; it now quotes the description's safe fields (name,
  a database error's code, constraint and table, a kept message, per link of the cause chain) and
  its top frames. A scheduled notification whose send guard throws stores
  `Send guard <name> failed: <description as JSON>` in `error_message`, not the error's message.
- **@spfn/auth, @spfn/core: client-visible failure answers carry a fixed sentence, not a caught
  error's text (#382).** `OAuthCallback` (and `runOAuthCallback`) showed and passed to `onError` the
  message of an error thrown while finalizing — a fetch failure's, say; it now shows
  `Failed to finalize OAuth`, `reason` still `failed`. The api client's `'network'` `ApiError` had the
  fetch error's message (a server-side fetch's can name an internal host); its message is now
  `Network error` and the fetch error is its `cause`. The RPC proxy's 502 (the backend call or a
  response interceptor threw) and 500 (a request interceptor threw) answered the error's message; they
  now answer `Failed to connect to backend` and `Internal server error` — the error is in the proxy's
  log line. A `debug` proxy (`RpcProxyConfig.debug`, on by default in development and settable in
  production) added the error's stack, whose first line is its message — for a failed statement its
  SQL and bound values; its 500, 502 and 504 now add `description`, the error's `describeError`
  description (the log line's value), and never `stack`.
- **BREAKING: @spfn/core: the error handler's development answer carries the error's description,
  not its text (#382).** Under `includeStack` (every `NODE_ENV` but `production`) a standard error
  that is not a database error was answered with its `message`, its cause's message as `cause`, and
  its raw `stack` — a fetch failure's internal host, a wrapped error's raw text. Its body is now
  `{ __type: 'Error', message: 'Internal Server Error', description }` with `description` its
  `describeError` description, as a database error's already was in `database`. A
  `SerializableError`'s `stack` is now the description's frames, without the header line (its
  message is in the body already). The handler owns `stack`: one a `toJSON()` override returns is
  removed in every mode, production included, and in development only the description's frames,
  when there are any, take its place. Production answers are otherwise unchanged.
- **@spfn/core: `isSerializableError(error)` and `errorLogLevel(error)` from `@spfn/core/errors`
  (#382).** The error handler's check for a typed error is now exported, and auth's OAuth error
  redirect asks it instead of its own `instanceof`, so both give one answer. `errorLogLevel` is the
  handler's level rule (`error` when the status — a typed error's `statusCode`, another error's
  numeric `statusCode`, else 500 — is 5xx, `warn` otherwise), which the handler and auth's OAuth
  failure log both read.
- **BREAKING: @spfn/core: a typed error is known by its brand, not its shape (#382).** The error
  handler took any object with a `toJSON()` and a numeric `statusCode` for a `SerializableError` —
  `instanceof` fails across the two copies of the module dev can load — so a provider's or
  library's error of that shape was answered (and put into auth's OAuth redirect) with its own
  text. `SerializableError` now carries a brand under the global-registry symbol
  `SERIALIZABLE_ERROR_BRAND` (`Symbol.for('spfn.core.serializableError')`, exported from
  `@spfn/core/errors`), set by the class as a prototype getter, so a second copy's errors still
  pass and `toJSON()` never copies it; `isSerializableError` reads only the brand. An app error
  class that answered through the handler by shape alone must extend `SerializableError`.
- **@spfn/auth, @spfn/monitor, @spfn/workflow, @spfn/notification need the `@spfn/core` that
  exports `describeError` (#382)**, auth also the one that exports `isSerializableError` and
  `errorLogLevel`. Their peer
  range (`>=0.4.0-beta.1`) still admits 0.4.0-beta.1, which exports neither; release them together with core.
- **BREAKING (behaviour, under `secondFactor.required: true` only): @spfn/auth: a user-verified
  passkey registration is marked as a second factor whenever the policy requires one (#399).**
  `passkeys/register/verify` marked only in the enrolment-only state, so a spare passkey added by an
  enrolled account was stored unmarked: refused as the second factor at `mfa/verify` and
  `mfa/step-up` until a separate `mfa/passkey/mark`. Now, with `required: true` and `'passkey'` in
  `methods`, every registration with user verification marks the passkey and answers `mfaStatus`.
  Only the registration that takes the account out of the enrolment-only state also records a
  step-up: an enrolled account adding a spare does not refresh its window (#372). With
  `required: false` or no policy nothing changes — registration marks nothing. No data migration:
  passkeys registered before are repaired with `mfa/passkey/mark`, which `listPasskeys` now shows
  where it can succeed (Added).
- **@spfn/auth: a passkey registration that marks the account's first passkey factor counts as a
  step-up (#372).** In the second-factor policy's enrolment-only state, `passkeys/register/verify`
  with user verification already marked the passkey; it now also opens the step-up window for the
  credential that registered, in the same transaction, as `totp/confirm` does. So first set-up
  (temporary password, required passkey) changes the password without a second ceremony.
  No other registration records one: none without user verification, and adding a passkey to an
  enrolled account does not refresh the window. `currentPassword` stays required on that password
  change. Not breaking.
- **BREAKING: @spfn/core, @spfn/auth: a middleware factory call returns a named middleware; calls
  are never merged by name (spfn/spfn#168).** A call of a factory made by
  `defineMiddlewareFactory(name, factory, options?)` returns `{ name, _name, handler, skips?, instance: true }`
  instead of the inner Hono handler. `defineMiddlewareFactory` takes the same `options` as
  `defineMiddleware`, and `skips` declared on the factory apply to every call (they were dropped
  before). `defineMiddleware(name, fn, options?)` no longer guesses from `fn`'s parameter count
  whether `fn` is a factory: `fn` is always the handler, so a one-parameter
  `async (c) => c.json(…)` answers its response. **Rename** every `defineMiddleware(name, (...args) =>
  handler)` to `defineMiddlewareFactory(name, (...args) => handler)` — the old call is now a type
  error (the factory returns a handler, not a response). Every call carries the factory's name: `.skip(['permission'])` and another middleware's
  `skips: ['permission']` remove every `requirePermissions(...)` a route inherits — which also means
  **a route can now `.skip([...])` an authorization guard by its factory name** (`'permission'`,
  `'anyPermission'`, `'role'`, `'roleGuard'`, `'opsScope'`, `'machineScope'`, `'opsOrUser'`,
  `'tenancyGuard'`, `'rateLimit'`, …), the same power `.skip(['auth'])` has. A call's result is never
  merged with anything by name: a router's `requirePermissions('a')` and a route's
  `requirePermissions('b')` both run, and so do two calls of a factory that returns one cached handler;
  the same result object at two levels runs once. A call can sit
  in a router's `.use([...])`. `opsOrUser(...)` and `signedTokenAuth(...)` are now such factories
  (with `skips: ['auth']`), so a router's `opsOrUser({ opsScopes: ['read'], … })` no longer drops a
  route's `opsOrUser({ opsScopes: ['write'], … })` — before, only the router's check ran and a
  read-only ops token passed the write route. `tenancy.guard(...)` is typed as returning
  `NamedMiddleware<'tenancyGuard'>`. `rateLimitPolicy(...)` is unchanged (one counter per policy name
  stays intended). A `rateLimit(...)` call can now sit on a router; limiters that share a
  scope count against one key, so an equal `rateLimit(...)` on a route below counts each request
  twice — as the global default and a route-level `rateLimit(...)` already did. Replace the
  inherited one with `.skip(['rateLimit'])`, or give one its own `scope`, or use `rateLimitPolicy`.
  **To migrate:** pass `.handler` where a call result goes to Hono (`app.use`,
  `app.get(path, …)`, `combine`, a hand-written chain), or put it in `.use([...])` directly; a
  `defineMiddleware(name, factory(args))` wrapper becomes `factory(args)`.
  @spfn/auth at this release needs the core of the same release: it reads `.handler` from factory
  calls and passes `{ skips }` to `defineMiddlewareFactory`. Core 0.4.0-beta.1 satisfies auth's
  current peer range and would give it `undefined` handlers (`opsOrUser` answers 500 to every
  caller its first check admits) and drop the `skips` of `opsOrUser`/`signedTokenAuth`, so the
  release raises the `@spfn/core` peer floor of @spfn/auth — the only package that calls a core
  middleware factory — to that core.

- **BREAKING: spfn: `spfn dev` stops when its children have (#358).**
  - **It takes as long as the slowest child:** the server's shutdown, up to core's
    `SHUTDOWN_TIMEOUT` (280 s by default). It used to exit once the codegen watcher had, the
    server still shutting down. A process manager with a shorter stop timeout SIGKILLs `spfn
    dev`, which reaches no child: kill the cgroup or each child's group, or allow for core's
    deadline.
  - **A second Ctrl-C escalates, and so does a stop no second Ctrl-C can reach.** A SIGINT once
    the stop has begun SIGKILLs every child's group, and `spfn dev` exits 130. A repeated SIGTERM or
    SIGHUP changes nothing; under #353 any second signal ended the watcher at once and left the rest
    alone. A stop escalates the same way, at once, saying so, once **both** its launcher has exited
    **and** another process group has the terminal (`spfn dev`'s own no longer gets a Ctrl-C). The
    launcher is `spfn dev`'s
    ancestors inside its own process group, from its parent up (`spfn dev` typed directly has none:
    its parent is the shell; in `cat | pnpm exec spfn dev` it is pnpm, not the group's leader
    `cat`); `spfn dev` finds it at start and, while stopping, asks every 100 ms whether its outermost
    process, the one the shell started, has exited (an inner one exiting — pnpm in `bash -c 'pnpm
    exec spfn dev; sleep 20'` — does not end the shell's job) and, once it has, where the terminal sends a Ctrl-C. `pnpm exec spfn dev`, `pnpm spfn
    dev`, `yarn spfn dev` and yarn 1's `yarn dev` exit on the first Ctrl-C and the shell takes the
    terminal back, so no second Ctrl-C can reach `spfn dev`: under them, one Ctrl-C no longer gives
    the server its graceful stop, also as `cat | pnpm exec spfn dev`, `… | tee log` or after `&`
    and `fg`, and neither does a `kill %1` or `kill -INT %1` to such a job in the background, after
    Ctrl-Z and `bg` too (the shell forgets the job: no `fg` or Ctrl-C reaches it again). Nothing else
    escalates: not `spfn dev` typed directly, after Ctrl-Z and `bg` too (the terminal is the shell's,
    no launcher exited); not `pnpm exec spfn dev | tee -i log`, or any pipeline whose reader outlives
    the Ctrl-C, nor a launcher that left on its own while its job kept the terminal (the launcher
    exited, the job still has the terminal: a second Ctrl-C still reaches `spfn dev`, and the stop
    escalates once the reader is gone); not `true | spfn dev`; not `pnpm dev`, `npm run dev` or `npx
    spfn dev`, which wait; not a terminal hanging up, nor a process manager or CI without one (the
    graceful stop); off Linux, not before the one `ps` that finds the launcher at start has
    answered, nor when it fails, and the terminal is read by a `ps` started only during the stop,
    after the launcher exited, one at a time — one that fails or does not answer escalates nothing.
    The watcher's stopping line no longer says `(Ctrl-C again to exit now)`; `spfn dev`'s does.
  - **Exit status:** 0 after a stop by any signal; 141 after a stop begun by a closed reader
    (`spfn dev | head -1`), as for a process SIGPIPE ended. After a Ctrl-C, or a `kill` of the bin, the
    shell used to see the bin killed by the signal (130, 143).
  - **The server's process** is Node under tsx, not `pnpm exec tsx`/`npx tsx`: it no longer gets
    what the package manager adds to its environment (`npm_*` variables, its own
    `node_modules/.bin` on `PATH`) unless the `pnpm dev`/`npx spfn dev` that started `spfn dev`
    added it already.
  - **No stdin for any child:** the server, Next.js and the watcher read an empty stdin. In a
    session of their own they have no controlling terminal: a read of the terminal they inherited
    would take what the user types from the shell.
  - **Ctrl-Z stops `spfn dev` only:** the children, in sessions of their own, run on while it is
    stopped; after `bg`, a stop is the graceful one unless the launcher has exited (above).
  - **Without tsx** for the app and for the CLI, `spfn dev` exits 1 with `tsx is not installed
    in this project, and it is what loads TypeScript. Add it: …` before starting anything. It
    used to start without the watcher and fail to start the server.
  - Windows, which has no `execve` and no process groups, keeps the bin's child process and
    signals each child of `spfn dev` alone.
- **BREAKING (security-relevant): @spfn/core: a middleware declaring `skips` now removes what it
  names when it is attached to a router (spfn/spfn#165).** It was ignored on `defineRouter(...).use([...])`
  and honoured only in a route's own `.use()`; now it removes the listed names from what that
  router inherits — the server-level list and every enclosing router's `.use()` — for every route
  below it. **This can widen access:** router-level `optionalAuth` under a global `auth` changed
  from "sign-in required" (both ran, `auth` refused anonymous callers first) to **"anonymous
  admitted"** for the whole subtree. A router-level replacement authenticator (`machineAuth`,
  `signedTokenAuth(...)`, `opsTokenAuth`, …) used to require a session *and* its own credential;
  it now admits on its own credential alone. Order is unchanged (server, outer, inner, route); a
  sibling in the same `.use()` is never removed; a skipper's `skips` count only while the skipper
  itself runs on the route, so a route that `.skip()`s it gets the skipped middleware back;
  `.skip('*')` still drops everything inherited; an inner router or route may `.use()` the removed
  middleware again. Registration now **throws** when a middleware declaring `skips` sits at or
  above a package router — in the package router's own `.use()` or in that of any router above
  it — a package router being one mounted with `.packages([...])`, or one its package defined
  with the new `defineRouter(routes, { packageName })`. So
  `defineRouter({ auth: authRouter }).use([optionalAuth])` is refused too, as is
  `authRouter.use([optionalAuth])` however it is mounted, and any depth of nesting. Package
  routes have no authenticator of their own; `@spfn/auth`'s `authRouter` now states
  `packageName`, and a third-party package whose routes rely on the app's authenticator should
  too (a package whose every route authenticates itself states none: `@spfn/cms`,
  `@spfn/monitor`, `@spfn/mcp` and `@spfn/notification` do not, and stay mountable under a
  skipper as a plain entry) — and puts a replacement authenticator for some of its routes on those routes or on a
  nested router inside its package router, never in the package router's own `.use()`. **To boot again**, move the skipper onto a nested router that holds
  no package router (`defineRouter({ machine: defineRouter({ ... }).use([machineAuth]) })
  .packages([authRouter])`), or onto the routes themselves (`route.get(...).use([optionalAuth])`).
  The refusal for a package router mounted as a plain entry needs the package and core from the
  same release — an older package's router carries no `packageName` (mounting through
  `.packages()` is refused with any version) — so the release raises each package's `@spfn/core`
  peer floor to the core that reads it.
  New: `resolveRouteMiddlewares(router, serverMiddlewares?)` (the
  chain `registerRoutes` registers, per route) and `RegisteredRoute.middlewares`. The SSE/WS token
  endpoints (`resolveEndpointMiddlewares`) are unchanged.
  **To find affected routers**, look for a router-level `.use([` naming a middleware that declares
  `skips` — those `@spfn/auth/server` exports: `optionalAuth`, `machineAuth`, `signedTokenAuth`,
  `opsTokenAuth`, `opsOrUser`, `oneTimeTokenAuth`, `authenticateForRenewal` — plus any of your own
  `defineMiddleware(..., { skips })`:
  `grep -rnE -A4 "\.use\(\[" src/ | grep -E "optionalAuth|machineAuth|signedTokenAuth|opsTokenAuth|opsOrUser|oneTimeTokenAuth|authenticateForRenewal"`
  and check which hits follow a `defineRouter(...)` rather than a `route.*(...)`.
- **BREAKING: @spfn/core no longer depends on `drizzle-typebox` (#376).** Nothing in core imported
  it. An app that imports `drizzle-typebox` without declaring it, reaching core's copy through
  npm's hoisting, must declare it in its own `package.json`, or import `drizzle-orm/typebox-legacy`,
  which drizzle-orm `1.0.0-rc.4` ships.
- **BREAKING: spfn: npm installs pass no `--legacy-peer-deps`, so an existing npm app that lists
  `drizzle-typebox@0.x` gets npm's `ERESOLVE`, with the CLI's explanation and fix (#376).** The
  flag was there only for drizzle-typebox, whose peer range `drizzle-orm >=0.36.0` admits no
  `1.0.0-rc.4`; the scaffold no longer adds it, and without it npm installs the SPFN set with no
  peer warning. The flag also hid every other peer conflict. `init`, `add`, `create`,
  `setup icons` and the generated Dockerfile's `npm ci` / `npm prune` drop it. An npm app
  scaffolded before still lists `drizzle-typebox`, which npm now refuses. The CLI does not predict
  that: when an install it runs fails, it prints npm's own lines, and when npm's error is
  `ERESOLVE` over drizzle-typebox's peer on drizzle-orm (text or `json` output), one more line: why, and to remove it from the `package.json` npm
  names (the app's, or the workspace root's), move to a drizzle-typebox version that accepts the
  prerelease, or import `drizzle-orm/typebox-legacy`. The command exits non-zero as for any failed
  install (`create`'s `@svgr/webpack` install only warns, as before). When `spfn init` fails there,
  what it wrote before the install stays, as for any install failure: the server and lib
  templates, the RPC proxy route, in full mode the `next.config` rewrites (bare mode does not touch
  `next.config`), the Docker files, `spfn.config.js` and the patched `package.json`; no `.env` file, `.spfnrc.ts`, `.gitignore`, `tsconfig.json` change or
  README. Delete the flag from your own Dockerfile and scripts too. pnpm, yarn and bun installs are
  unchanged.
- **spfn: the scaffold no longer adds `drizzle-typebox`, `tsup` or `dotenv` (#376, #368).** No
  template imports them; `spfn build` bundles with the CLI's own tsup, and core and the CLI declare
  their own dotenv. An existing app keeps them harmlessly, apart from `drizzle-typebox` under npm
  (above). The unused `buildServerForCommand` helper, which ran an app-level tsup, is gone.
- **BREAKING (behaviour): @spfn/auth: `passwordChangeRequired` is enforced as a restricted session
  (#362).** The flag (set by admin seeding, default `true`) used to be only reported; nothing was gated
  on it, so a seeded account used the app with its seeded password. Now, from an account's next request
  after the upgrade, a session of a flagged account is answered **403 `PasswordChangeRequiredError`**
  (`PASSWORD_CHANGE_REQUIRED`, `details.requirements`) on every route — the app's included — except
  `PUT /_auth/password`, `logout`, `GET /_auth/session`, `mfa/status`, `mfa/step-up/options` and
  `mfa/step-up` (the step-up a change asks of an enrolled account), plus the two sign-in completions
  that hand such an account its session (`oauth/finalize`, `mfa/verify`). It is the same mechanism as
  the second-factor policy's enrolment-only state, generalised: the account's outstanding requirements,
  in order, are `passwordChange` then `secondFactorEnrolment`; a request is admitted when none is
  outstanding or the route admits any one of them (so an account held to both can enrol and can change
  the password), and a refusal names the first — `details.requirements` lists them all. Not signed out:
  the Next.js proxy keeps the session on it, and the same session works everywhere from the request
  after the change. `optionalAuth` reads such a caller as anonymous; a one-time token, an OAuth 2.1
  access token (`verifyAccessToken` throws the error) and the token endpoint (`invalid_grant`) refuse
  it whatever the route. Renewal is unchecked, as for enrolment. What clears it: the change itself, in
  its own transaction under the account lock, or a completed password reset. **The new password must
  differ from the current one**: `PUT /_auth/password` with the current password as `newPassword` is
  400 `ValidationError` and clears nothing (one more hash compare); a reset of a flagged account to
  its current password is the same 400, its setup session left usable for another try (an unflagged
  account may still reset to the password it had). `GET /_auth/session`, the web
  OAuth finalize answer and the native OAuth answer now carry `passwordChangeRequired`.
  `createAuthLifecycle()`'s `afterRoutes` now refuses to boot an app built by another copy of Hono
  whatever the second-factor policy (next entry). Mobile contract
  **0.15.0** (supported range `>=0.15.0 <0.16.0`): the new code, an optional `passwordChange` on each
  operation that can answer it, and `OauthNativeResponse.passwordChangeRequired`; `PUT /_auth/password`
  is not a contract operation — a native client clears the requirement off-contract, as it enrols a
  second factor. **Migrate:** find the accounts still flagged before upgrading —
  `SELECT id, email, created_at FROM spfn_auth.users WHERE password_change_required;` — and either let
  each person change the password on next sign-in (send them to your change page on the 403, reading
  `GET /_auth/session` rather than your own routes), or clear the flag for accounts whose seeded
  password was already replaced out of band: `UPDATE spfn_auth.users SET password_change_required =
  false WHERE id IN (…);`. Seeding sets it only on accounts it creates; `passwordChangeRequired: false`
  in `SPFN_AUTH_ADMIN_ACCOUNTS` seeds an account without it. An app that enforced the flag itself
  should stop calling its own routes from its change-password page. No schema change, no migration.
- **BREAKING (boot): @spfn/auth: `afterRoutes` refuses another copy of Hono in every app (#362).** It
  used to refuse an app built by a second copy of `hono` only while `secondFactor.required` was set;
  an app with no second-factor policy booted. It now refuses that app too: seeding flags accounts in
  any app, and a flagged account's every request — `PUT /_auth/password` included — reads which route
  it matched, which a second copy hides, so the app would boot and answer that account 500 on the
  change that frees it. Refusing only those requests was the alternative and was not taken: it is the
  same 500, found by the first seeded admin rather than at deploy. **Migrate:** an app that boots on
  two copies today (`pnpm why hono`; an app run as CommonJS beside an ESM server) resolves `hono` to
  one install and runs as one module format. A custom `app.ts`, which core does not run this hook for,
  still answers the flagged account's request 500 instead.
- **BREAKING (behaviour): @spfn/auth: a password change keeps the session that made it (#372).**
  `PUT /_auth/password` used to revoke every key of the account, the caller's included, so the person
  changing their password was signed out by it — and on an enrolled account signed back in as a new
  device, with the second factor again. It now ends sessions as `POST /_auth/keys/revoke-all` does,
  through the same code: every other key, every key waiting on a second factor, device-code approvals
  and device links not yet collected, and OAuth 2.1 grants; the key the request signs with moves into
  the new key generation in the same statement and stays signed in — not re-issued, so its binding,
  the browser's cookies and its step-up window are unchanged. A one-time token spares the key that
  issued it; an application profile spares no device key. The body gains `includeCurrent` (optional
  boolean): `true` signs the caller out too, as on `revoke-all`. **Migrate:** an app that sent the
  person to sign in again after a change finds the session alive; send `includeCurrent: true` where
  the change is meant to end this device's session as well. A password reset is unchanged. No schema
  change, no proxy change; the mobile contract does not list the operation and does not move.
- **BREAKING: @spfn/auth: a disabled or pending-deletion account answers password sign-in as a wrong
  password does (#364).** `POST /_auth/login` used to answer a wrong password `InvalidCredentialsError`
  (401) and the right one `AccountDisabledError` / `AccountPendingDeletionError` (403), telling any
  caller the password of an account that cannot sign in was right. Now a disabled, suspended,
  pending-deletion or purged account is answered `InvalidCredentialsError` — same status, code and
  body — whatever the password, after the same comparison against its own hash, with the refusal
  read from columns already on the row (no extra query; the purge date is no longer looked up there).
  The same holds under the account lock when the account changes between the check and the session
  write. `POST /_auth/deletion/cancel` answers `DeletionNotRequestedError` only to an active account;
  a password for an account that is not active and has nothing pending is `InvalidCredentialsError`.
  With a sign-in guard, `settled` is told `failed` with `accountDisabled` / `pendingDeletion` for the
  right password (`credential` for a wrong one), and `admit` is asked again after either, as after a
  wrong password; the README has a recipe for e-mailing the owner from there. No separate event.
  Those two reasons are told only for the right password, so a counter, a delay or any answer
  derived from `settled` must treat them exactly as `credential`: the README's lockout example now
  counts every failure at `stage: 'credential'` (and records `stage`) instead of
  `reason = 'credential'`, which fired after five wrong passwords and never after the right one.
  **Migrate:** a client that showed the account status or offered restore on a 403 from password
  sign-in gets a 401 instead; tell the owner out of band (`signIn.settled`). OAuth, passkey, device
  code, device link and one-time-token sign-in keep their answers. The mobile contract does not
  change: its error list is one list for the whole surface, and both codes stay in it for those
  operations.
- **BREAKING: @spfn/auth: the package sends no account-deletion notice; events and an `onPurge`
  hook give the app what it needs (spfn/spfn#170).** The package sends a message itself only when it
  carries, or stands in for, a credential it minted; deletion has none. Removed:
  `deletion.sendNotifications` (and the exported `DEFAULT_DELETION_SEND_NOTIFICATIONS`) and the
  three fixed-English notices it switched — "requested" (e-mail, else SMS), "cancelled" and "deleted"
  (e-mail only). With the default configuration nothing is sent on request, cancel or purge.
  - `createAuthLifecycle({ deletion })` refuses to boot for an option it does not know, and names
    `sendNotifications` as removed, pointing at the README recipe, so an app that relied on the
    notices does not silently stop sending them. A misspelt option is refused the same way, listing
    the options.
  - Two `createAuthLifecycle()` calls combine their `deletion` options as their `channels` do: what
    was stated holds. A lifecycle that states no `deletion` (or leaves an option out) changes nothing,
    so a later one no longer silently drops the first one's `onPurge` or `allowSelfImmediate`. An
    option stated twice with different values, or two different `onBeforePurge`/`onPurge` functions,
    refuses boot naming both. `configureDeletion()` with no argument no longer resets to the defaults.
  - `auth.deletion.requested` gains `immediate: boolean`, true whenever the grace period is 0
    (`gracePeriodDays: 0`, or a request with `immediate: true`): the purge runs right after that
    commit, so there is no date to announce and nothing to cancel. `auth.deletion.cancelled` and
    `auth.deletion.completed` (`{ userPublicId, purgeStrategy }`, no contact details) are unchanged.
  - New `deletion.onPurge(account)` hook, with type `PurgedAccount` (`{ publicId, email, phone,
    purgeStrategy }`, read under the account lock). It is called inside the purge transaction, under
    the account lock, once the request is claimed and before the destructive writes, so the account's
    rows (its language setting among them) and the app's own rows a `hard-delete` cascades away are
    still readable through the transaction. It is never published or queued. Database work only:
    write an outbox row through the app's own repository and send from a job after the commit. A
    hook that opens its own transaction (`requiresNew`) and touches the account's rows never
    returns: it waits on the lock the purge holds, and PostgreSQL does not see a deadlock. A
    throw rolls the purge back — account and request stay `pending`, no `completed` — and the next
    sweep retries. `onBeforePurge` is unchanged: it runs before the transaction opens, without the
    lock.
  - A throwing `onPurge` rejects the purge with the new `PurgeHookFailedError` (500,
    `@spfn/auth/errors`), which names the hook, the deletion request (`requestId`) and what the
    hook threw by identifiers only: its class name (`hookErrorClass`) and, for a failed database
    statement, the SQLSTATE (`hookErrorCode`). It keeps no reference to the hook's error — no
    `cause`, no field — because the hook was handed the account's email and phone and its error
    may quote them; no log line at any level (the rollback line included), stored job failure or
    response body carries them. A throwing `onBeforePurge`, handed them too, is logged the same
    way and no longer by its message. An app that needs its own error handles it inside the hook.

  **Migrate from `sendNotifications: true`:** remove the option, then follow the README recipe
  ("Account Deletion & Recovery" → "Telling the person"): `registerTemplate` three templates with
  `locales`, subscribe to `authDeletionRequestedEvent` (skip when `immediate`) and
  `authDeletionCancelledEvent` and send with `sendEmail`/`sendSMS` to the account read by `userId`,
  and have `onPurge` write an outbox row that a job sends. An app that passed
  `sendNotifications: false` only removes the option.
- **BREAKING: @spfn/core: workers started on `getBoss()` run core's fetch loop, not pg-boss's
  worker, so they no longer appear in pg-boss's `wip` events (#359).** Core needs to know when a
  worker's last fetch has settled, which pg-boss 11 does not expose; the loop runs on pg-boss's
  public `fetch` / `complete` / `fail` and keeps the worker's options and behaviour (polling
  interval, `batchSize`, `includeMetadata`, `priority`, the handler bound, completion with the
  handler's result, failure with its error, `error` events, `offWork`, `notifyWorker`; see the job
  README). `work()` returns core's worker id, which `offWork({ id })` and `notifyWorker(id)` on
  that instance take. Kept: the instance's own `stop({ graceful, timeout, wait, close })` and
  `start()` — `stop()` is the path `stopBoss()` takes, so it waits for core's workers within
  `timeout`, fails the jobs of handlers still running (non-graceful: at once), and stops their
  polling; `work()` after it rejects as pg-boss's does until `start()`. A `PgBoss` the app
  constructs itself is unchanged.
- **BREAKING: @spfn/core: a graceful `getBoss().stop()` ends pg-boss's cron and queue supervision
  after its wait for handlers, not before it (#359).** pg-boss's own stop ends them first and then
  waits; core's waits for its workers first and then runs pg-boss's stop, which has no hook between
  the two. A cron tick during the wait may still insert a job row, which stays for a live instance.
- **@spfn/core: the shutdown budget has a `jobFetch` phase (#359):** Phase 2's wait for fetches in
  flight, capped at 5s and reserving nothing, inside the half of the work share the HTTP and
  WebSocket closes use. It cannot cut into the drain's guaranteed half, but it may take up to 5s
  the drain would otherwise get (at the default 280000ms, a drain of at least 195000ms rather than
  200000ms). When the closes use their whole half, the fetch wait is 0ms: Phase 2 warns that a
  fetch is still in flight, and a job it takes starts on the stopping instance.
- **BREAKING: @spfn/core, spfn: one rule for pending function package migrations (#357).**
  Core's status (`spfn db status`, the `spfn dev`/`spfn start` pre-flight, the boot gate, detailed
  health, the Kit `db-status` gate) ignored the legacy shared `drizzle.__spfn_fn_migrations` table,
  while the CLI's `db push` preview and every apply counted it: on a database recorded only there,
  `db status` reported all 45 `@spfn/auth` migrations pending and `db push --dry-run` 1. The rule now
  lives in `@spfn/core/db` as `pendingFunctionMigrations(db, packages)` (with the
  `FunctionMigrationSource` and `PendingFunctionMigrations` types): a package's migration is pending
  when it is newer than the newest `created_at` in its own table or, while that table is missing or
  empty, newer than the newest of its migrations the legacy table holds. Package tables have no
  `name` rule. The CLI's preview and applies import it. The legacy table is read only for a package
  with no rows of its own, so a role without SELECT on it still reads status on a database where
  every package has its own rows; when the legacy read is needed and denied, the boot gate starts
  with "Could not verify migration status" and `db status` exits 1. The legacy table has no package
  column, and when the operator may drop it is in the `@spfn/core/db` README.
- **BREAKING: @spfn/core, spfn: project migration status is decided by drizzle-orm's own rule (#370).**
  For `src/server/drizzle`, `spfn db status`, the `spfn dev`/`spfn start` pre-flight, the boot gate
  and detailed health counted a migration as applied when its name was recorded *or* its timestamp
  was not newer than the last applied row; `spfn db migrate` (drizzle-orm 1.0) goes by name alone.
  So a migration merged with an older timestamp than one already applied was reported applied and
  the gate let the server start without its schema, and a folder renamed after it was applied
  read as applied while migrate ran it again. Status now calls drizzle-orm's `readMigrationFiles`
  and `getMigrationsToRun`, the calls migrate makes, so it lists exactly what migrate will run. This
  is the bug being fixed: an app that read "0 pending" may now read "N pending" and the gate
  refuses to boot it. What to do depends on why it is pending — read the names `spfn db status`
  lists: a migration with an older timestamp that was never applied → run `pnpm spfn db migrate`;
  a folder renamed after it was applied → do **not** migrate (it would run the applied SQL again):
  rename the folder back, or set that row's `name` in `drizzle.__drizzle_migrations` to the new
  folder name, then check that `spfn db status` no longer lists it. A bookkeeping table written
  before drizzle-orm 1.0 (no `name` column) is named the way migrate names it, without writing;
  when a row matches no folder in `src/server/drizzle`, or the folder still has the drizzle-kit
  ≤0.31 `meta/_journal.json` layout, migrate refuses, and status now reports the error
  `bookkeeping does not match local migrations` (new `MigrationBookkeepingMismatchError` in
  `@spfn/core/db`) instead of a clean count: `db status` exits 1, `db status --json` reports
  `reachable: false` with the new `reason: "bookkeeping-mismatch"` and the text in `detail`
  (`spfn kit install`/`update` refuse on it with `CLI_MIGRATION_BOOKKEEPING_MISMATCH`, exit 4,
  where they would otherwise wait for a database forever), `spfn dev`/`spfn start` refuse to
  spawn the server, health reports `status: "unknown"` with the reason, and the boot gate refuses
  to start whatever `SPFN_ALLOW_PENDING_MIGRATIONS` / `allowPending` say — they mean "start
  although migrations are still to be applied", and migrate refusing the database means nothing
  applied later repairs it; the refusal says so. For a version-0 row no folder matches, the error
  names each row and the folder stamp or hash that would match it: restore that folder, or delete
  the row after confirming its SQL is applied; for the journal layout, run `drizzle-kit up`. Then
  check `spfn db status`. Function package migrations keep #357's rule.
- **BREAKING: spfn: the Kit's `db-status` gate fails on a migration status it could not read, and
  `spfn db status --json` answers `"permission-denied"` for a permission error (#405).** The gate
  passed whenever the status carried no pending names, which an unread status never does: with no
  `DATABASE_URL` (`not-configured`), an unreachable database, or a role the database refused, it
  passed without reading anything. It now fails, naming why (`the migration status could not be
  read: not-configured`). Who meets it: `spfn kit restore` on a checkout with no `DATABASE_URL` — a
  fresh clone, a CI job — when the release manifest lists `db-status` (`install` and `update`
  already wait for a database before their gates); configure the database first, or resume once
  it is. `spfn db status --json` reported a
  permission error (SQLSTATE 42501, typically the app role without a grant on schema `drizzle`)
  as `reachable: false, reason: "unreachable"`; it now reports `reason: "permission-denied"` with
  PostgreSQL's message in `detail`. A reader that branches on `reason` and treated `"unreachable"`
  as "wait and retry" meets the new value; one that stops on `reachable: false` is unaffected.
- **BREAKING: @spfn/core: `filterPendingEntries` is no longer exported from `@spfn/core/db`
  (#357).** It was the shared "name OR timestamp" filter; function packages now go through
  `pendingFunctionMigrations`, and the project target's rule (unchanged here, #370) is private to
  `collectMigrationStatus`. Read status with `collectMigrationStatus`, or a package's pending list
  with `pendingFunctionMigrations`.
- **BREAKING: spfn: the legacy `drizzle.__spfn_fn_migrations` table is no longer converted or
  dropped (#357).** Every apply (`db push`, `db migrate`, `spfn add`) copied the hashes of the
  packages it was given into their own tables and dropped the shared table, so `spfn add <pkg>` lost
  every other package's records and the next `db migrate` re-ran them (`schema "…" already exists`,
  or an idempotent migration applied twice). The table is now only read; it stays in the database.
  An apply with nothing pending writes nothing, not even an empty bookkeeping table.
- **BREAKING: @spfn/core: pending counts on databases recorded in the legacy table drop (#357)** —
  to what `db push` and `db migrate` apply. A deploy gated on `migrations.pending === 0` or on
  `spfn db status --json` sees fewer pending migrations there than in earlier versions.
- **@spfn/auth: `POST /_auth/login` and `POST /_auth/deletion/cancel` no longer run under a route-wide
  `Transactional()` (#361).** Their services open their own transactions — the session's, and with a
  sign-in guard one per recorded failure — so a failure the app records survives the 401. For an app
  that leaves the `signIn` option out, two things changed and nothing else: a failed `/login` or
  `deletion/cancel` (wrong password, unknown identifier) no longer opens a transaction at all, where
  on main it ran inside the route's (begin … rollback); and both look the account up on the primary
  (`usersRepository.findByEmailOrPhoneOnPrimary`), as they did inside the route's transaction on main
  — not on a replica. A successful sign-in sends the same statements as before.
  `POST /_auth/mfa/verify` now reads its own request's address and user agent (`deviceProvenance`)
  for the guard.
- **BREAKING: spfn: the `spfn dev` codegen watcher no longer exits on a codegen config that fails
  to load (#353).** It exited 1 at start ("fix the config and restart spfn dev"), and never read
  the config again; now it logs `✗ Codegen config failed to load: … Regeneration is paused; save a
  fix to retry.`, stays up generating nothing — not even with the generators of the last good
  config — and loads the config again on the next change to what the failing load read or looked
  for. `spfn codegen run` and `spfn build` still fail on such a config.
- **BREAKING: @spfn/core: generator instances are re-created when the watcher reloads the config
  (#353).** A reload calls each factory again (a package generator's with the new options; a
  custom generator's file evaluated again); state a generator keeps in its factory's closure
  starts over, and the old instance is never called again.
- **BREAKING: @spfn/core: `OrchestratorOptions` declares `loadGenerators?: never` (#353).** A type
  that extends or widens `OrchestratorOptions` and declares its own `loadGenerators` property no
  longer compiles (`interface X extends OrchestratorOptions { loadGenerators?: … }` is TS2430).
  Extend `LoadingOrchestratorOptions` if the property means the orchestrator's loader, or rename it.
- **BREAKING: @spfn/core: watch mode's generations, the initial one included, log and do not
  reject under `throwOnError: true` (#353).** `watch()` ran its initial generation as `generateAll('watch')`,
  so under `throwOnError` a failing generator rejected `watch()` before any watching began; now
  the initial generation is a cycle of the watch loop, logged like every other. `watch()` still
  rejects with the first failure when no generator has `watchPatterns` (it then runs one
  `generateAll('watch')` and returns), and `generateAll()` still rejects, also while watching.
- **BREAKING: spfn: the `spfn dev` codegen watcher needs a tsx resolvable from the app or from the
  CLI (#353).** It ran through the package manager, so an npm app with no tsx installed got one
  fetched by `npx tsx`; now the watcher is not started there, and `spfn dev` logs the command that
  installs tsx in the app (`npm install --save-dev tsx` in an npm app). The
  server and Next.js still start.
- **BREAKING: @spfn/core: `CodegenOrchestrator.generateAll()` and `settled()` reject when called
  while the calling generator's own `generate()`, run by the watch loop, is still running (#353).**
  Awaited there, they could never finish, since each waits for that generation; they reject whether
  or not the call is awaited. Call them after `generate()` has returned (from a timer or a promise
  callback); the loop runs a generator again when a file it read changes.
- **BREAKING: spfn: inside a pnpm/yarn/bun repository, a directory that is not a workspace member
  is no longer treated as using the repository's manager (#345).** The manager was taken from any
  `pnpm-lock.yaml`, `yarn.lock` or `bun.lockb` up to five directories above, and `package-lock.json`
  was never looked at. Now the app's own lockfile decides (`package-lock.json` and bun's text
  `bun.lock` included) before anything above it is read; then the workspace that lists the app,
  where each ancestor's lockfile selects the manager whose declaration decides (`pnpm-workspace.yaml`
  `packages` for pnpm, `package.json` `workspaces` for yarn, npm and bun; negations honoured; an
  ancestor declaration that does not parse declares nothing); otherwise npm. So `init`, `add`,
  `build`, `start`, `dev`, `setup`, `provision` and `create` (without `--pm`), run in such a
  directory, use the app's own lockfile or npm, and install, add and run scripts there;
  `create --pm pnpm` there installs in the app directory instead of from the repository root.
  `spfn init` gains `--pm`. **To keep the repository's manager** for such an app: add its directory
  to the workspace's globs, or commit the app's own lockfile (`pnpm-lock.yaml`, `yarn.lock`, …);
  `create` and `init` also take `--pm`, but `dev`, `build`, `start`, `add`, `setup` and
  `provision` have no `--pm` and follow the lockfile only.
- **BREAKING: spfn: `spfn db` and `spfn provision` load a type-less app's source as ESM, as
  `spfn dev` does (#349).** In an app without `"type": "module"`, `spfn db generate`, `db push`,
  `db tenant` and the `spfn provision` runner loaded entity files, `drizzle.config.ts` and
  `server.config` as CommonJS, beside a second copy of every `@spfn/core` entry they reached (5
  under `db generate` in example 03, 15 under `provision`). The `spfn` bin now runs every command in
  a process with the CLI's module hook registered for the app — re-running itself unless the process
  already has it, also when `tsx` was already there (`node --import tsx`, `npx tsx`,
  `NODE_OPTIONS`) — and every `tsx` child a command starts (the `provision` runner, the dev server
  and watcher) gets the same hook. A CommonJS-only shape — `require`, `__dirname`, a named import of
  a `module.exports` file — now fails where the CLI loads the file itself, as it fails under `spfn
  dev` (table in the CLI README, "Your server source runs as ESM"): in entity files under `db push`,
  `db tenant`, and `db generate` with the entity registry or a function package and no
  `drizzle.config.ts`; in `server.config` under `provision`; in `drizzle.config.ts` under `db push`
  and `db tenant`, which read its `schema` and `schemaFilter`. **A `drizzle.config.ts` that does
  not load as ESM now stops `db push`, with and without `--schema`, and `db tenant`** (exit 1, naming
  the file, the CommonJS name and `import.meta.dirname`/`import.meta.filename`/`import` as the
  remedy; the credentials of a URL in the config's load error are blanked): its `schemaFilter` is
  what they may touch, and `--schema`, which replaces only its files, no longer goes on without it.
  `drizzle-kit`, which `db generate`, `check`, `drop` and `studio` hand `drizzle.config.ts` to,
  reads it and the schema by its own rule as before. Top-level `await` in an entity now loads (`db
  generate` failed on it). `spfn env` loads `env.schemas` files the same way. The cost: every `spfn`
  command in a project re-spawns itself once to get the hook, and the hook's resolve adds ~73 ms of
  self-time over 2,815 resolves on `spfn --version` in example 01 (dev VM, Node 22).
- **BREAKING: spfn, @spfn/core: every `spfn db` command and the `spfn provision` runner refuse a
  second copy of `@spfn/core` (#349)**, with the message a server refuses with: a `.cjs` file that
  requires `@spfn/*` from an entity or `server.config` stops the command, naming the file. A `spfn`
  that is not the app's own (global, `npx`/`dlx`) in an app with its own `@spfn/core` is refused
  naming the CLI's install as the second one and the app's own command to run (`pnpm exec spfn …`);
  `markAppSourceProcess({ foreignRunner })` carries that.
- **BREAKING: @spfn/core: `markCodegenProcess()` is `markAppSourceProcess()` (#349)**, exported from
  `@spfn/core/codegen` and now also `@spfn/core/server`. It marks any process the spfn CLI started
  to load app source, and from the mark on a second copy is refused where it is recorded, as in a
  server — in a codegen process too, inside the router load, besides the check after it.
- **spfn: `spfn db push` output and failures follow the new apply order (#378).** The plan lists each
  function package's pending migrations first, then the project statements, with one line saying
  so. A function package migration that fails now means the project schema was not applied
  (`❌ Failed to apply function package migrations — nothing of the project schema was applied`);
  it used to mean the project statements were already committed.
- **spfn: `spfn db push`'s destructive confirmation has three outcomes (#378).** No skips the listed
  statements and still applies the other project statements and the package migrations, as the
  question now says. An aborted question (Ctrl-C, EOF) used to count as No and apply the rest; it
  now exits 1 with nothing applied (`❌ The confirmation was aborted — nothing was applied`). A run
  whose stdin is not a terminal used to hang at the question; with a destructive statement pending
  and no `--force` it now exits 1 before any write, naming `--force`. A project failure says
  package migrations stay applied only when this run applied one.
- **spfn: a failed `db push` statement and a failed `db tenant export`/`import` print a database
  error by core's rule (#378, #382).** First line: `databaseErrorMessage` (the server's message
  only where `@spfn/core`'s `describeError` keeps it, else the SQLSTATE class's fixed text), then
  the code, constraint, table and column, with the connection URL and any URL's credentials cut
  out. A class-22 failure used to print the row's value (`invalid input syntax for type integer:
  "…"`); it now reads `Invalid input value (22P02)`. Under it, every one of these commands prints
  the statement that failed (`   Failed statement: ALTER TABLE …` / `COPY (SELECT …) TO STDOUT`),
  so a class-22 or class-42 failure still says what failed: a tenant export over a column the
  database lacks used to name it (`column "ghost" does not exist`) and names it in the statement
  now. A function package migration adds its name (`   In: @spfn/cms migration …`); a tenant
  import file value a column cannot take adds the file and the COPY line (`   In: tenant file
  …copy`, `   At: COPY spfn_tenant_import_1, line 3`), never the value. Unique, foreign-key and exclusion failures keep the server's message; a
  not-null or check failure raised while altering a table reads `Integrity constraint violated
  (23502, table …, column …)` / `(23514, constraint …, table …)`. An authentication failure reads
  `Database authentication failed (28P01)` (was `authentication failed (28P01)`). spfn now reads
  `databaseErrorMessage` from `@spfn/core/db`, so the release raises spfn's `@spfn/core` peer
  floor to the core that has it.

### Fixed

- **spfn: `kit install`, `kit update` and `kit restore` authenticate under pnpm 12.23 (#482).** The
  registry session reached pnpm only as `npm_config_//host/npm/:_authToken`. pnpm 12.23's corepack
  entry starts its native binary through `/bin/sh`, and dash (Debian's and Ubuntu's `/bin/sh`)
  drops every variable whose name is not a shell identifier, so the install went out with no
  `Authorization` header and the registry answered 401; 12.22 started the binary directly and was
  not affected. The session is now also handed over as `pnpm_config__auth`, the structured `_auth`
  setting pnpm 11.10 and later read, keyed by the release's scopes (from the signed manifest, in
  `kit restore` too) and never by `@`. pnpm 11.10 and later take each key as a route as well, and
  that route takes precedence over the project's `.npmrc`: a release scope a project `.npmrc` sends
  to another registry is resolved from the kit registry anyway. Unscoped packages and every other
  scope keep the project's routing. pnpm 9 and 10 keep reading the `npm_config_` keys, which route
  nothing. No file carries the session. The install test pins its pnpm through corepack instead of running
  npm's `latest`, and its pnpm matrix gains 12.23.0.

- **@spfn/auth, @spfn/core: an error the client restores keeps every field it was thrown with —
  `SignInRefusedError` and `PasswordChangeRefusedError` keep `details.code`, `HttpError`,
  `DatabaseError`, `QueryError` and `TransactionError` keep their `statusCode` (#459).** The two
  refusals took `{ code }` and stored it as `details.code`, but `ErrorRegistry.deserialize` hands a
  constructor the fields where the body carries them, `{ message, details: { code } }`, so the
  missing `code` overwrote the one in `details`: an app's page could only show a generic failure for
  every refusal the `admit` hooks gave. The two constructors now take that serialized shape (see
  Changed); the refusals' wire is unchanged. `toJSON()` left `statusCode` out of every
  body, so an instance given its status came back with none (`HttpError`) or 500 (a
  `DatabaseError`, `QueryError` or `TransactionError` thrown with another): such an instance now
  carries `statusCode` in its body, and its constructor reads it back; the production body of an
  internal database error keeps it beside `__type`, read with the new `carriedStatusCode(error)`
  and never through the error's `toJSON()`, so an app's internal error whose serializer throws is
  still answered with the generic body. The constructor marks it with the new protected
  `SerializableError.carryStatusCode()` only when `new` was called on that class itself, so every
  class that fixes its status — `NotFoundError`, `DeadlockError`, every auth error — and a
  `QueryError` or `TransactionError` thrown without one keep the body they had. A class whose status is
  fixed by its type is restored with its own status whatever the response was answered with; the
  client still never reads the response status into an error. A body from an older server, without
  `statusCode`, restores as before: `HttpError` with none, the three database classes with 500. A test round-trips every class of `errorRegistry` and of
  `authErrorRegistry`, each built with every constructor field set, and fails for a registered class
  with no fixture.
- **@spfn/auth: a role check an app calls itself, judged on a stale premise, reaches the client as
  `AuthorityContendedError` (409) (#459).** Outside `runJudgedTransaction`, `assertCanChangeRole`,
  `assertCanChangeAuthority` and `roleChangeRefusal` throw it as an internal subclass, which
  travelled under its own name: no registry holds that name, so the client restored a generic
  `ApiError`, and `error.code` named a class no SDK knows. It now serializes as the refusal it is
  answered as.
- **Release: one tarball per version on both registries — npmjs gets the bytes the Gitea registry
  already has (#463).** A release was built twice, once by `.gitea/workflows/release.yml` for the
  Gitea registry and once more by the GitHub mirror's `publish-<pkg>.yml` for npmjs, and the type
  build is not byte-deterministic, so one version named two tarballs and a lockfile written against
  one registry failed `ERR_PNPM_TARBALL_INTEGRITY` against the other (`@spfn/auth@0.4.0-beta.4`,
  `@spfn/notification@0.3.0-beta.4`, `@spfn/auth@0.3.0-beta.53`; `spfn@0.4.0-beta.4` too, whose
  npmjs workflow also deleted `publishConfig.registry` before publishing). The GitHub workflows no
  longer build: the fourteen `publish-<pkg>.yml` call one reusable `publish-from-gitea.yml`, which
  runs `scripts/republish-from-gitea.mjs` — wait (at most 90 minutes) for the Gitea release to
  publish the version, download its tarball, verify it against Gitea's `dist.integrity`, `npm
  publish` that file to npmjs, read npmjs's integrity back, and move its dist-tags — the channel's
  and `latest`, as before, but only to a version newer than the one a tag names, so two releases
  finishing out of order no longer leave `latest` on the older (a version older than every tag it
  would take goes out under `superseded`). Any re-run moves the tags of a version npmjs already has. A version npmjs
  already has with different bytes now fails the run instead of being skipped green. npmjs auth is
  unchanged (`NPM_TOKEN`, provenance kept); the one new secret is `GITEA_PACKAGES_READ_TOKEN` on
  GitHub, a read-only Gitea packages token. Versions already split stay as they are — a published version
  cannot be replaced.

- **@spfn/core, @spfn/mcp: a stream says no intermediary may transform it — `Cache-Control: no-cache,
  no-transform` (spfn/spfn#174).** The Next.js server (`next start`, `next dev`) runs the `compression`
  middleware on every response, one rewritten to the SPFN server included, and skips only a response
  whose `Cache-Control` carries `no-transform`. The SSE stream carried hono's `no-cache` alone, so
  behind a rewrite such as `/events/:path*` and with the browser's `Accept-Encoding: gzip` it was
  gzipped, and the zlib buffer held the small frames: the headers arrived, then no `connected`, no
  `ping`, no event, and the client never reconnected. Every `createSSEHandler` stream now answers with
  `Cache-Control: no-cache, no-transform` beside `X-Accel-Buffering: no`, written through the context
  after `streamSSE`'s own header, so a middleware that read `c.res` first (hono's `cors`) does not
  bring `no-cache` back. `@spfn/mcp` adds `no-transform` to the SDK's `text/event-stream` answers on
  `/mcp`, which the SDK sends with `no-cache` alone on a request's stream and on
  `subscriptions/listen`. No new option or export.

- **spfn: `db push` replaces a check whose expression changed (#442).** drizzle-kit 1.0.0-rc.4's
  push never alters an existing check (`mode !== "push"` in its diff): PostgreSQL stores a check
  normalised (`op in ('a', 'b')` reads back as `(op = ANY (ARRAY['a'::text, 'b'::text]))`), so the
  declared text cannot be compared with the stored one, and the database went on enforcing the old
  expression — a value added to the list was refused on insert. `db push` now compares each
  declared check the table holds under its name with PostgreSQL's own normalisation, without
  touching the table: in a transaction it always rolls back, it builds a temporary table from the
  table's declared columns (the types the push leaves), adds the declared check to it, and compares
  the two as PostgreSQL stores them (`pg_get_expr`). One that differs gets one statement in the
  plan, `ALTER TABLE … DROP CONSTRAINT IF EXISTS "<name>", ADD CONSTRAINT "<name>" CHECK (…)`,
  after drizzle-kit's statements (a column they drop may have taken the old check already), listed by
  `--dry-run` and applied with the other project statements in their transaction; it is a warning,
  not a destructive change (it deletes no data), so it needs no confirmation. Its `ADD` re-checks
  every row: a row the new expression refuses fails the push with the statement, and the old check
  stays. A check that cannot be compared before the push is left as it is and named —
  `Check "<name>" on … was not compared, and stays as it is:`, the reason and PostgreSQL's message —
  when PostgreSQL refuses the declared check while this push creates an enum or changes its values
  (through a column of the type or a cast inside the expression; the next push compares it), or
  when the target refuses the temporary table (a dry run against a read-only database or a
  standby, which still plans); with nothing else to apply, push then ends with `No statements to
  apply; the checks above stay as they are`. With no enum to create or change, a declared
  expression PostgreSQL refuses over the declared columns ends the plan (`Planning failed — nothing
  was applied`, the SQLSTATE, `In: check "<name>" on …, as declared` and the statement). This
  replaces the notice of
  spfn/spfn#167 (`differs from the one in the database … db push does not change an existing
  check`) and its `EXPLAIN` comparison. What else drizzle-kit's push does not compare — an index's
  columns (when their number is unchanged) and `WHERE`, view definitions, policy `USING` / `WITH
  CHECK`, generated column expressions — is named in one line (`Not compared by db push: …`) when
  the schema declares such an object, above the plan or its closing line.
- **spfn: `db push` drops, then creates, what one push removes and adds of one kind, instead of
  dying with `resolver(table) was called without a HintsHandler` (spfn/spfn#173).** Drizzle Kit's
  `pushSchema` asks whether an object removed and one added of the same kind are a rename and takes
  no answer, so a push that removed table `a` and added table `b` — or a column, index, unique
  constraint, check, foreign key or policy in one table, or a schema, enum, sequence or view — ended
  at the plan stage, `--force`, terminal or not. `db push` does not rename: it plans as before, one
  `pushSchema` diff, and only when Drizzle Kit throws that error for a kind does it plan that kind in
  two steps, each with nothing to ask — in one transaction that always rolls back, the drops, then
  the creates from the state after them — shown as one plan (`ℹ️  db push does not rename`, each kind
  with what is removed and added), confirmed once, applied in that order. Every other push plans as
  before. A dry run that needs two steps runs them in that rolled-back transaction instead of
  read-only ones; such a plan, dry run or not, holds the `ACCESS EXCLUSIVE` locks of its `ALTER
  TABLE`/`DROP TABLE` on existing tables until the rollback, waiting for them as long as the
  server's `lock_timeout` lets it (push sets none, as for applying). A primary key replaced by
  another, which a table cannot hold beside the old, stops push at the plan stage with nothing
  applied (`Planning stopped — nothing was applied`), naming the kind, the table and both keys.
  Before the drops are planned push creates the added objects of the reported kind, every added
  schema, enum, sequence, table and column, all that is added in an added schema or table, every
  added object that names one of those by identifier, and the keys a foreign key among them
  references. An object names an added one when it lists a column its table gains, or when a
  token of its expressions (an index's expression or predicate, a check, a policy) equals the name
  of a column its table gains or of a table, view, enum or sequence this push adds in any schema,
  whatever the token's role there — a cast's type, a function, the object's own column — and
  whatever schema qualifies it; comments, string literals (`'…'`, `E'…'` with its backslash
  escapes, dollar-quoted `$$…$$`) and numbers are skipped as PostgreSQL reads them with
  `standard_conforming_strings` on. The rule reads text, so it can take in an object that only shares
  a name (an index on `lower("category")` beside a new table `category`, one over
  `("created"::date)` beside a new column `date`) and miss a dependency through another table (a
  policy whose subquery names a column another table gains). When what it creates first keeps a
  name an object the push drops still holds — an index moving from a replaced table, a table named
  like a dropped enum — push stops at the plan stage with nothing applied (`Planning stopped —
  nothing was applied`), naming the object, the holder of its name and, when it is created first
  because it names one, the added object it names by identifier; a missed dependency fails at the
  plan stage with PostgreSQL's error, nothing applied. Either way: `db generate` + `db migrate`,
  or push in two pushes. To rename, use `db generate` + `db migrate`. A push planned in two steps
  compares the existing checks (#442) in its own rolled-back transaction, after both steps, on the
  tables as they leave them: a check changed on a table the steps leave is replaced after their
  statements, as on a plain push, and one the steps drop with its column and create as declared
  is not replaced again. Which enums the push creates or changes is read before the steps, as on a
  plain push, so a check PostgreSQL refuses there because the steps added an enum value it names
  (a value is usable only once its transaction commits) is not compared, and the push applies.
  `DROP VIEW`, `DROP MATERIALIZED VIEW`, `DROP SEQUENCE`,
  `DROP POLICY` and `ALTER TABLE … DISABLE ROW LEVEL SECURITY` are now destructive, so they wait for
  `--force` or the confirmation like `DROP TABLE`.

- **@spfn/auth: `revoke-all` from an application profile no longer spares a device key that shares
  the profile's key id (#372).** `POST /_auth/keys/revoke-all` spared whatever key id the request
  reported (`getAuth(c).keyId`). For an application profile that is the id its verifier reports, and
  `POST /_auth/login` takes a client-chosen `keyId`, so anyone able to sign in to the account could
  register a device key under that id, and it survived the owner's "sign out everywhere" from the
  profile. The key to spare is now the one the credential signs with (`signingKeyOf`), as on
  `PUT /_auth/password`: a device key spares itself, a one-time token the key that issued it, a
  profile no device key. `POST /_auth/logout` and `POST /_auth/keys/rotate` read the key the same
  way, so a profile's logout no longer revokes a device key with its key id, and a profile's rotate
  is refused (401, as for a key no longer live) instead of retiring that device key.
  `revokeAllKeysService` takes the key to spare from `credential`: `currentKeyId` is gone, and
  `credential` is required unless `includeCurrent: true`. `LogoutParams.keyId` and `RotateKeyParams.oldKeyId` accept `null` (revoke
  nothing / refuse). **Migrate:** a direct `revokeAllKeysService` caller passes `credential`
  (`getAuth(c).credential`) in place of `currentKeyId`.
- **spfn: `spfn db push` applies function package migrations before the project statements
  (#378).** On an empty database, a project table with a foreign key to a package table (say
  `spfn_auth.users`) failed with `schema "spfn_auth" does not exist`: the project statements ran
  first, rolled back, and the package migrations never ran, so every retry failed the same way,
  while `--dry-run` showed a clean plan. Both halves are still planned read-only, once, before any
  write, and destructive project statements are confirmed (or declined) before any write. Then
  each package's pending migrations apply, one committed transaction per package as `db migrate`
  does, and then the project statements in one transaction. A failing project statement now exits
  1 with a printable description of the error and the statement (`❌ The project statements were
  rolled back: …`; it used to be uncaught), and the package migrations it followed stay applied.
- **spfn: a new app is told to run `spfn db push` (#378).** Both scaffold modes ship the starter
  `examples` entity and no project migration, but `spfn init --mode full` said `db migrate` (which
  creates the auth tables and never the app's), `spfn create --mode full` printed init's list and
  then its own, and `--mode bare` named no database command at all — the app's first query failed on
  a missing table. One list of next steps, printed once by whichever command ran, now names
  `spfn db push` wherever the scaffold holds an entity or `@spfn/auth`. The generated README, the
  entities README, the auth and MCP guides say `db push` for development and keep
  `db generate` + `db migrate` for a migration-based deployment.
- **Every package: each source module is emitted once, so a class, a singleton or a configuration is
  the same object whichever entry point it is imported from (#398).** Every multi-entry build now
  splits shared code into chunks (`dist/chunk-*.js`, not exported); before, a module two entries
  reached by a relative import was inlined into both. `exports`, the `'use client'` / `'use server'`
  files and the declarations' public names are unchanged. What is now one object:
  - **@spfn/auth:** a refusal `authApi` restores (`RecentAuthenticationRequiredError`, the
    `mfa/step-up` errors, every class in `authErrorRegistry`) is `instanceof` the class from
    `@spfn/auth/errors`; before, `@spfn/auth` restored its own copy of every auth error class, and
    passing `authErrorRegistry` to `createAuthApi` did not help. `CanonicalJsonError` and
    `ProofInputError` are one class across `/client-proof` and `/server`, `SessionUnsealError` across
    `/nextjs/api`, `/nextjs/server` and `/server`. 61 modules were in more than one file.
  - **@spfn/core:** `requireOwner` (`/authz`) throws the `NotFoundError` and the rate limiter
    (`/middleware`) the `TooManyRequestsError` of `@spfn/core/errors`, and `errorRegistry` is one
    registry; `OpsRouterError` is `SurfaceError`, as `src/ops/error.ts` documents; `/env/loader` and
    `/server` share the load-once state of `loadEnv`; the job, SSE and route builders are one copy
    each between their own entry and `/server`. 53 modules were in more than one file (56 in esbuild's
    record; the rollup pass removed 3 copies). Each entry still records its evaluation once
    (`recordEvaluation`).
  - **@spfn/notification:** configuration set through `@spfn/notification/config` is what
    `@spfn/notification/server` sends with; before, `/config` configured a copy `/server` never read.
  - **@spfn/pages:** `/server` throws the `PagesError`, `SiteConfigError` and `FrontmatterError` that
    `@spfn/pages` exports.
  - **@spfn/mcp:** `McpError` and the dispatcher are one copy across the four entries (the
    `Symbol.hasInstance` brand stays, for two installed versions).
  - **spfn:** `SurfaceManifestError` is one class across `spfn` and `spfn/surface`.
  - **@spfn/monitor, @spfn/workflow:** the drizzle schema and table objects are one object across
    `/` and `/server` (monitor) and across the two entity entries (workflow).
  - **@spfn/signing, @spfn/pages-next, @spfn/i18n, @spfn/cms:** shared helpers, one copy each (no class
    or state was affected).

  A build check, `scripts/check-bundle-identity.mjs`, runs after `tsup` in every package's `build`.
  It reads esbuild's own record of which modules each output file holds (its metafile, which
  every tsup config writes to `dist/*.metafile.json`; `files` keeps it out of the package) and
  fails when one module — the package's own or a dependency it bundles, such as
  `@sinclair/typebox` — is in two output files, or when an output file is in no record. CI's verify
  step also runs it over every built package's `dist` (`pnpm check:bundles`), whatever a package's
  `build` script runs. Packages built with tsup's `treeshake` (core, i18n, mcp, signing, workflow)
  no longer are: its rollup pass rewrites the files after esbuild recorded them, and dropped chunk
  imports esbuild writes to keep evaluation order. esbuild still tree-shakes; `@spfn/auth`'s root
  browser entry grows from 79,563 to 82,927 bytes minified (+0.7 KB gzipped).
- **@spfn/core: a rolled-back transaction, a failed job and a failed request no longer log the
  failed query's bound values (#382).** drizzle's `Failed query: … params: …` message, its
  `params`, its stack header and the driver's `detail` reached the logs through the runner's
  rollback lines, the afterCommit/afterRollback/beforeCommit callback failure lines, the job
  failure and orphan-schedule lines, the error handler's log data and the unhandled-rejection
  context (`extractQueryInfo` parsed `params:` out of the message on purpose). Those sites now pass
  the error object and the logger describes it — also when the message is printf-style
  (`logger.error('… %s', err)` formatted the raw error). Describing never throws: a throwing getter
  is left out, a cause chain ends after 10 links (`CauseChainTruncated`) or at a loop
  (`CircularCause`). A source-scan row keeps a caught error's `.message` / `.stack` /
  `String(err)` / `.toString()` / `JSON.stringify(err)` out of every package's logger calls
  (including `log.…` and `logger[level](…)`) and persisted writes, with an exact, counted list of
  the auth, cms and monitor sites left for the follow-up. It follows a `const`/`let` copy of the
  caught value (directly, through `as`, `!` or `satisfies`, or as a ternary branch) and of its
  text (including an Error made from it, `new Error(String(err))`); it does not follow
  destructuring, a value passed to a function and returned, one read back out of an object, or
  a reassignment. In core, a caught value or such a copy never reaches a logger as the lone
  second argument.
- **spfn: a migration status that could not be read is no longer "nothing pending" (#405).**
  `spfn kit install`/`update` used to report `migration-applied` when the status read after
  `spfn db migrate` failed: an unread status carries an empty `pending` list, and the Kit took it
  for "all applied" (the step, its re-check on resume, and the `db-status` gate). Now:
  - `spfn db status --json` reports a permission error (SQLSTATE 42501, typically the app role
    without a grant on schema `drizzle`) as the new `reason: "permission-denied"`, with
    PostgreSQL's message in `detail`, instead of `"unreachable"`; the human form names the grant.
  - the Kit's migration step refuses on it before or after migrating —
    `CLI_MIGRATION_STATUS_UNREADABLE`, exit 4, `evidence.reason: "permission-denied"` — instead of
    waiting forever on `KIT_WAITING_DATABASE` ("needs a database connection") or reporting
    success. The remedy is still the hand SQL in the `@spfn/core` db README, "Database roles": no
    spfn command grants anything yet.
  - an after-migrate read failing for another reason is `KIT_MIGRATION_FAILED` (resumable); the
    step's re-check and the `db-status` gate fail on any unread status with the reason
    (`not-configured` included, which the gate used to pass).
  - `spfn dev`/`spfn start` print one line when the pre-start check cannot read the status
    (`Could not check migrations: …`; with the grant on a permission error) and start, where they
    were silent. They still do not block on it.
  - a `spfn db status --json` child that printed no report (it crashed, or could not load tsx or
    an import) is no longer taken for a project without a database: the gate summary, the step's
    re-check and the `KIT_MIGRATION_FAILED` evidence say `report-unreadable (…)` with the tail of
    the child's stderr, URLs redacted, where they said `not-configured`.
- **Tests: a database or two-role row that did not run is reported skipped, with the reason, not
  passed (#405).** 23 test files in core and spfn returned early (`if (!available) return;`) when
  PostgreSQL or the second test role was missing, so vitest counted those rows as passed. They
  now skip through the test context; the two-role harness (`tenancy-db.ts`,
  `migration-gate-roles.test.ts`) also checks that the app role connects, and fails instead of
  skipping under CI, whose PostgreSQL has both roles. "CI" means `CI` set to anything but
  nothing, `false` or `0`, there and in the spfn tenant tests' database check; `CI=false` used to
  count as CI and turn the skip into a failure.

- **@spfn/auth: `enrollPasskey` adds a passkey to an account with session binding on (#400).**
  `passkeys/register/verify` asks a bound account for the `passkeyAdd` proof, and the helper never
  sent one, so it rejected with 403 `PASSKEY_PROOF_REQUIRED` every time. It now reads
  `GET /_auth/session/binding` and, for a bound account, runs the proof (`provePasskey(api,
  'passkeyAdd')`) **before** the registration prompt, so a dismissed proof leaves no credential on
  the authenticator that the account never stored. A bound account sees two prompts, an unbound
  one still sees one. If the verify still asks for the proof, the proof runs once and the same
  attestation is sent again; a second refusal rejects. `enrollPasskey(api, { passkeyResponse })`
  sends an app's own proof as given; its refusal rejects, with no proof prompt of the helper's. A
  binding read that fails rejects as itself before any prompt. New results: a dismissed proof
  prompt is `no-credential`, and a 503 at the verify is `busy` with `retry`, which
  `enrollPasskey(api, { retry })` posts again — the same attestation and proof, no prompt. Every
  other way it ends after the registration prompt without the passkey stored hands `retry` back
  too: a proof asked after it (binding turned on since the read) and dismissed is `no-credential`
  with `retry`, and a rejection after it — `passkey-proof/options` refused, the verify refused, a
  network `TypeError` — is the error as it came, carrying `retry` (`enrollPasskeyRetryOf(error)`).
  A `retry` past the registration's challenge answers 401 `PasskeyChallengeError`; a new ceremony
  is then the only way. A dismissed registration prompt is still `cancelled`. Not breaking. `GET /_auth/session/binding` is
  an enrolment route while `'passkey'` is listed (`ROUTE_ENROLMENT`), so an enrolment-only session
  reads it; on a bound account its proof is refused before the registration prompt, and it marks an
  existing passkey instead (README, "Enrolling, from a Next.js client component").
- **@spfn/auth: `PasskeyProofProcedure` (`@spfn/auth/client`) is read off the route's input
  (#400).** The hand-written union had left out `opsTokenIssue`, which the server accepts.
- **spfn: `spfn dev` delivers each signal to each child once and exits after its children
  (#358).** Who got a signal depended on where it came from. A terminal's Ctrl-C reached the
  server, Next.js and the codegen watcher directly *and* through `spfn dev`'s forward, so the
  watcher saw a "second signal" and abandoned its generation. `kill <pid>` of the bin, as a process
  manager sends it, killed the bin alone and left the whole tree running. A SIGTERM to `spfn dev`
  never reached Next.js: `pnpm run` and the `sh -c` it runs `spfn:next` under forward nothing. And
  `spfn dev` exited before the server had stopped, which then held its port, orphaned. Now:
  - `bin/spfn.js` re-runs itself under tsx with `process.execve` instead of spawning a child: the
    pid you start is the CLI's, for every command (a SIGTERM to the bin's pid during `spfn db
    migrate` used to leave the command running, orphaned). A relaunch that fails stops the command
    with `Error: spfn could not re-run itself under tsx and its module hook: …`, exit 1. It used to
    run the command without the hook, saying nothing, when the spawn failed, and would have when
    `process.execve` throws (Node.js 26.1+); before 26.1 a failed `execve` ends the process itself.
    Only a `tsx` that is not installed (no `tsx/package.json` resolves) runs the command without
    the hook; a package that is there but whose entry does not resolve (a `package.json` that does
    not parse or cannot be read, an entry file missing) stops it
    with `Error: spfn could not resolve tsx, which it re-runs itself under: …`, exit 1.
  - Each child of `spfn dev` leads a process group of its own and is stopped by one SIGTERM to that
    group, from `spfn dev`, whatever stopped `spfn dev`: Ctrl-C or Ctrl-\\, or SIGTERM, SIGINT,
    SIGHUP or SIGQUIT to the pid. `spfn dev` exits 0 once every group is empty.
  - The server and the watcher run as `node --import <tsx> --import <spfn's hook> <entry>`: not
    through `pnpm exec`/`npx` (the server did), which exit before what they run, nor through the
    `tsx` CLI (the watcher did), which relays a signal its child already got unless the child
    reports it within 30 ms — a busy child got it twice.
  - `--watch` waits until nothing is left in the old server's group before starting the new one,
    instead of sleeping 500 ms.
  - Next.js exiting with an error stops the server and the watcher before `spfn dev` exits 1;
    they used to run on.
  - SIGHUP (a closed terminal) stops `spfn dev` as SIGTERM does; it used to kill `spfn dev` and
    the watcher mid-generation.
  - What reads `spfn dev`'s output exiting stops it gracefully, once. Outside a stop — `spfn dev |
    head -1` — the line that fails (EPIPE) begins the graceful stop, and `spfn dev` exits 141 after
    its children, as a shell reports a process SIGPIPE ended (`set -o pipefail` sees the failure); it used to die of the EPIPE with its children SIGTERMed by execa's exit cleanup.
    During a stop — `spfn dev | tee log`, whose Ctrl-C kills `tee` too, or a terminal that hung up —
    the stopping lines of `spfn dev` and the codegen watcher fail (EPIPE, EIO) and end neither;
    `spfn dev` used to die on them, leaving the server unsupervised, and the watcher before
    finishing its generation. Any other error on stdout or stderr still ends `spfn dev`.
  - `spfn dev` exiting on an uncaught exception SIGTERMs every child's group it has not signalled
    yet. execa's exit cleanup, which stopped the server and the watcher before, skips children in
    groups of their own.
- **spfn: without tsx, `spfn db` and `spfn provision` say what to install (#349)**, as `spfn env`
  did: `tsx is not installed in this project, and it is what loads TypeScript. Add it: <the app's
  own add command>`, exit 1. `db generate`, `push` and `tenant` stopped on Node's `Cannot find
  module '…/example.entity'`; `provision` on the package manager's `Command "tsx" not found`. The
  message now names the app's package manager (`npm install --legacy-peer-deps --save-dev tsx` in an
  npm app) instead of always `pnpm add -D tsx`.
- **@spfn/core, @spfn/auth, spfn: `updatedAt` is never written by hand, and the docs, templates and
  auth's upserts now agree (spfn/spfn#166).** One rule everywhere: on a `timestamps()` table never
  write `updatedAt`; every Drizzle `update()` and every `onConflictDoUpdate` sets
  `updated_at = now()` from the database clock; only raw SQL you write yourself says
  `updated_at = now()`.
  - Docs: `db/schema/README.md` no longer tells you to set `updatedAt: new Date()` (the "do not
    exist" note and the Pitfalls item); the `db/README.md` upsert example and its `upsert` pitfall
    drop `updatedAt: new Date()`.
  - Templates: the entity README that `spfn init` copies, and those of examples 02 and 03, use
    `id()`, `...timestamps()` and `foreignKey()` like their `example.entity.ts`; the template's
    hand-written `updatedAt` column never moved on update.
  - @spfn/auth: the upserts of roles, permissions, role mappings, user permissions and OAuth2
    grants no longer stamp `updated_at` from the application clock, and the user-settings upsert
    drops its redundant `updatedAt`. The `setWhere` guards still move the stamp only on a real
    change.
- **@spfn/auth: `mfaLockedEvent`, `passkeyEnrolledEvent` and `passkeyRevokedEvent` are exported from
  `@spfn/auth/server` (#361)**, with `MfaLockedPayload`, `PasskeyEnrolledPayload` and
  `PasskeyRevokedPayload`. The README documented all three and the package emitted them, but an app
  could not import them to subscribe. A unit test now fails when an event defined anywhere in the
  package's source is not exported and not named as deliberately private.
  Reported again as #420 against 0.3.0-beta.53: the published `0.4.0-beta.1` predates the fix too —
  its `dist/server.js` export block and `dist/server.d.ts` carry none of the three events nor
  their payload types — so the first release with them is the next one after it.
- **@spfn/auth: the export test also holds the payload types and the README (#420).** The test above
  compared event objects at run time, so an event exported without its payload type still passed and
  still built. Two rows now read the source with the type checker: every event
  `server/events/index.ts` exports has a payload type exported beside it (the type of its
  `_payload`), and `@spfn/auth/server` exports that same type; and every event or payload type the
  README's Events section names is exported from `@spfn/auth/server`. The README's list of payload
  types now names `MfaLockedPayload`, which was exported and not listed.
- **@spfn/auth: the README no longer says seeded accounts are required to change their password
  (#361).** `passwordChangeRequired` is set for seeded accounts, returned by sign-in and cleared when
  the password changes; nothing in the package gates on it. An app that wants the change enforced
  does it itself.

- **@spfn/core: a graceful shutdown waits for in-flight job fetches before it calls fetching
  stopped (#359).** `stopFetching()` only asked pg-boss's workers to stop, so a fetch already in
  flight could run its SQL after the drain began and take a job enqueued during it, which then
  started on the stopping instance. Phase 2 now logs `Stopped job fetch` once every fetch has
  settled; if its budget ends first it warns that a fetch is still in flight and that a job it
  takes starts on this instance. Phase 5 waits for core's running handlers itself and fails the
  jobs of those still running (`"pg-boss shut down while active"`, as before: `retry` or `failed`)
  before the pool closes, since pg-boss's stop fails only jobs its own workers hold.
- **@spfn/core: `loadCodegenConfig` evaluates `.spfnrc.ts` on every call (#353).** A second call
  in one process returned the module the first had evaluated — `require()` caches by file name
  and dropped the generation query — so the config and what it imports were never read again.
- **@spfn/core: the `spfn dev` codegen watcher no longer loses changes (#353).** It decided what
  changed from file events and its own bookkeeping, so a change arriving while that bookkeeping was
  not valid was lost: only the first of the changes queued during a generation was regenerated (a
  queued `notes.md` that matched nothing dropped the route edit behind it); an edit during the
  initial generation, or before chokidar's first scan, was never seen; a file created or edited
  between a load's read and the watch armed for it — the missing import of CI 725's failing
  generation — was never regenerated; a file unlinked and recreated inside its own generation was
  dropped by chokidar while the watcher believed it watched, so every later edit was lost until a
  restart. Now every file a load reads — the tsconfig and package.json files it resolves by
  included — is stamped (a hash of the bytes used; every path a resolution looked at and found
  nothing, stamped absent) and attributed to the generator that ran; one
  serialized loop runs, in one generation, every generator a dirty path matches or that read one,
  then watches the directories of the new inputs and then compares every input with its stamp, so
  a change that lands during a generation is found by the comparison. Such a change is a late
  file event: it waits the quiet period input events wait (150 ms with no write in the input's
  directory) before the next generation starts. After 3 consecutive cycles started that way, one
  warning names the files and the generators that read them; regeneration continues. Logged: `Changed during generation: + <path>`, and in debug `Queued ~ <path>`; `No generators
  matched this file` only when nothing matched. A generator's `✓`/`✗` is logged after that
  comparison, and a run whose inputs changed while it ran says so instead and is run again once
  they settle, whatever a later comparison finds: a save between two of the environment probe's
  loads was reported as `ConditionalRegistrationError: The route map depends on the
  environment`. A failure is held back that way at most once in a row per generator; the next
  failure is reported, so a real one shows by the second run at the latest, or as the watch loop
  ends when it ends before that run (`close()`, or an exception that rejects `watch()`).
- **@spfn/core: `CodegenOrchestrator.close()` stops the watch loop.** A change queued when it was
  called ran the generators again after it resolved; now nothing new starts, and it resolves once
  the generation running has finished every generator, so the `spfn dev` watcher's SIGTERM no
  longer leaves the route map and contract from two different generations. A generation cannot be
  cancelled, so the watcher entry exits at once on a second signal. An orchestrator is
  single-use: `watch()` after `close()`, while its loop runs, or after the loop ended by an
  exception rejects instead of opening watchers nothing closes. When the loop ends by an
  exception, a `generateAll()` queued or in progress rejects with it as the `cause`. A
  chokidar error is warned about once, naming the pattern directories.
- **spfn: `spfn create --pm yarn` works with yarn 1; npm, pnpm and bun run the one-off packages
  through `npx --yes` (#367).** create ran create-next-app and shadcn as `<pm> dlx`. `yarn dlx` does
  not exist in yarn 1 (it looks for a script named `dlx` and fails with "Couldn't find a
  package.json file"), so `--pm yarn` failed with a yarn 1 that is not corepack's and under an
  ancestor pinned to `yarn@1`. With corepack, `yarn dlx` is Yarn 4 and worked, producing a Yarn 4
  app; it still does. create now asks the yarn that answers in the directory (`yarn dlx --help`)
  and keeps `yarn dlx` where it exists, using `npx --yes … --use-yarn` only where it does not: yarn
  1's `yarn run v1.` banner means no `dlx`, exit 0 with the `yarn dlx <command>` usage means `dlx`.
  With no yarn on PATH, `--pm yarn` stops before anything is downloaded or written, with "yarn was
  not found; install it or choose another --pm" (exit 1); any other answer (a corepack refusal, a
  failed download) stops create with yarn's output. The question shares the terminal, so corepack's
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=1` prompt shows as it does for `yarn dlx` itself. For
  npm, pnpm and bun, create-next-app and shadcn now run through `npx --yes` (they ran through
  `npx` without `--yes`, `pnpm dlx`, and `bunx dlx`, which was broken); `--pm` still picks the
  installer (`--use-<pm>`, and shadcn reads the lockfile). A missing npx now says "npx was not
  found; install npm" instead of `spawn npx ENOENT`. create-next-app and shadcn are the only sites
  of this one definition: the Kit's older-CLI hint (`KIT_CLI_INCOMPATIBLE`) is not one of them, since
  a Kit installs only with pnpm, and it stays `pnpm dlx spfn@…` as on main. Not breaking.
- **spfn: `spfn dev` waits for its codegen watcher on SIGINT/SIGTERM (#353).** It sent the watcher
  SIGTERM and exited at once, through `pnpm exec`/`npx`, which do not wait (npx did not even
  forward the signal), and execa SIGKILLed the wrapper 5 s later: a `kill -TERM` of `spfn dev` left
  the watcher running, writing into the project. The watcher now runs under a tsx CLI started by
  Node directly — the app's, else the one installed beside `spfn` — and never through the package
  manager: with no tsx found, it is not started, and one error says to install tsx in the app.
  `spfn dev` exits once it has; how each signal reaches it, the server and Next.js, and what a
  second signal does, is #358's (below). Every child is
  started through one place that refuses once a stop has begun: a stop before the server was
  ready no longer starts Next.js when it becomes ready, leaving it running after `spfn dev`
  exited. A SIGKILL of `spfn dev` reaches none of them.
- **@spfn/core: `CodegenOrchestrator.generateAll()` called while watching** ran the generators
  beside the cycle running, two generations writing the same outputs at once; it is now queued as
  a run of the watch loop and settles when that run has finished.
- **@spfn/core: watch state is per orchestrator.** The files each router's load reached were kept
  in a module-wide map, so a second orchestrator in the process watched the first app's files.
- **spfn: `spfn create --pm <manager>` installs with that manager, and an install is reported
  only when it installed (#345).** `create` chose the manager, then `init` detected one again, so
  `create --pm npm` in a pnpm repository ran `pnpm install` in a directory the workspace did not
  list — a no-op for the app that exited 0 — and printed `✔ Dependencies installed` with
  `@spfn/core`, `spfn` and `drizzle-orm` missing. `create` now hands its manager to `init`, and
  `init` and `create`'s workspace-root install print `Dependencies installed` only once every
  package in the app's `dependencies` and `devDependencies` resolves from the app directory, as
  Node resolves it there (Plug'n'Play included, the CLI's own `NODE_PATH` not); otherwise they exit
  1 naming the missing packages, and, when pnpm installed the workspace above a directory it does
  not list, say so and how to fix it.
- **spfn: `spfn add` in an npm app installs with `--legacy-peer-deps`, as `init` does (#345).** It
  ran `npm add <package>`, which npm refuses with `ERESOLVE` for every SPFN app (drizzle-typebox's
  peer range `drizzle-orm >=0.36.0` admits no `1.0.0-rc.4`). `init`, `add`, `create` and
  `setup icons` now share one set of install arguments per manager, and the generated Dockerfile's
  `npm ci` and `npm prune`, which failed the same way, carry the flag too; it copies bun's text
  `bun.lock` as well as `bun.lockb`. (The flag is gone again: no SPFN app needs it, see #376
  under Changed.)
- **spfn: `spfn db push --dry-run` writes nothing (spfn/spfn#163).** In 0.4.0-beta.1 a dry run
  whose project schema had no pending change applied the function package migrations (and created
  their bookkeeping tables) instead of previewing them; with a pending project change it said
  nothing about them. `db push` now plans first — the project statements and, per function package,
  the pending migrations, worked out without writing — prints both, and stops on a dry run before
  any write. Each query of the dry run's plan runs on one connection in its own `BEGIN READ ONLY`
  transaction, rolled back when the query ends, so the dry run holds no lock between statements;
  before the plan runs, `transaction_read_only` is read once, in one such transaction, and every
  plan query then opens its transaction with the same `BEGIN READ ONLY`; when that read is not
  `on` it exits 1 naming `--dry-run`. Applying reads the same pending list, so a preview and the
  push after it agree.

  Output changes scripts may match: `✅ No changes detected — database is up to date` is now
  `✅ No changes detected — project schema is up to date` (the old sentence was false while
  package migrations were pending); when at least one function package is installed, every push
  and dry run prints `📦 Function package migrations pending:` with one `<package> (<n>):` line
  and its `- <migration>` lines per package, or `📦 No function package migrations pending`; a
  dry run ends with `🔍 Dry run: nothing was applied.` The `📦 Applying function package
  migrations:` header and its `- <package>` lines are unchanged, as in `spfn db migrate`.
- **spfn: `spfn build` no longer sets `LOG_LEVEL` (#350).** It set `LOG_LEVEL=warn` to quieten
  codegen, but no logger has read that variable since core's logger moved to `SPFN_LOG_LEVEL`, and
  that level is fixed when the CLI starts, so no variable set there could work. Build now runs
  codegen with its `debug` switch off, so a build no longer prints the four `debug`-gated lines
  `generateAll` can reach: route-map's `Loading router` and `Found N routes`, states'
  `Found N states`, and the orchestrator's `[<generator>] Skipped (runOn: …)` for each generator
  that does not run on `build` (the other gated lines belong to watch mode). A custom generator
  from `.spfnrc` receives `debug: false` too. Failures and the `Running N generator(s)` and
  `✓ Generated successfully` lines are unchanged. For quieter output run
  `SPFN_LOG_LEVEL=warn spfn build`. An app that defines its own `LOG_LEVEL` no longer has it
  forced to `warn` during `next build`. Core's env docs now name the app-defined example variable
  `APP_LOG_LEVEL`.

- **@spfn/core, spfn: codegen loads the app as ESM in the process's own module graph; one copy of
  `@spfn/core` (#335).** Codegen loaded the router (and `.spfnrc.ts`, the generator module, custom
  generators) with jiti, and every jiti load evaluated the app **and the `node_modules` packages it
  imports** again as CommonJS beside the ESM copy the process held: `@spfn/core/logger` 1 ESM + 7
  CommonJS in one `spfn codegen run`, `@spfn/auth/server` ×123 over 41 watcher rounds. The router is
  now `import()`ed under a hook core registers with `module.registerHooks`
  (`@spfn/core/codegen/loader`): project TypeScript runs as ESM by the rule `spfn dev` uses (now
  shared through `@spfn/core/codegen/loader`), is transformed with TypeScript's `transpileModule`,
  and is re-run on each load through a generation query appended to project files only; every
  package is evaluated once, under the pinned `production`. One load per generation is shared by
  the route-map, contract and states generators. `loadCodegenConfig` stays synchronous
  (`.spfnrc.ts` is `require()`d as an ES module); `<package>/codegen` and custom `.ts` generators
  are imported natively, so the generator that runs is the process's own. Measured on a copy of
  `examples/03-auth` with a state router, an `@/` import and all three generators: every
  `@spfn/*` entry evaluated once in `spfn codegen run`, the watcher (20 rounds), `spfn build
  --server-only` and `spfn contract check`; a watcher reload took about 35 ms instead of about
  300 ms. `jiti` is no longer a dependency of `@spfn/core`.
- **@spfn/core: the module-evaluation registry counts evaluations**, and codegen refuses a second
  copy of an `@spfn/core` entry after each router load in a process the spfn CLI started
  (`markCodegenProcess()`, called in-process by `spfn codegen run`, `spfn build`'s generation
  step, `spfn contract` and the `spfn dev` watcher entry, so nothing they spawn inherits it); a
  programmatic caller or a test is warned. The registry used to merge evaluations of one path by one
  evaluator, and reported "ESM + CJS" where 1 + 7 existed. `startServer`'s refusal is unchanged.
- **@spfn/core: the `spfn dev` codegen watcher regenerates for every project file the router
  reaches.** It watched only `src/server/routes/**` and the router, so editing
  `src/server/lib/segment.ts` imported through `@/` regenerated nothing. The watched set follows each
  load; a file no load reaches any more leaves it. A load that failed on an import that resolved
  nowhere is retried when a file appears at any path the import was looked for at (a directory
  that does not exist yet included).
- **@spfn/core: the environment probe's header is true now.** A package does not run again on a
  varied load, as it said; with jiti it did, so a package's `NODE_ENV`-dependent route was refused
  or not depending on an unrelated project file, and the refusal blamed that file.

- **spfn: `tsup` `^9.0.0` and `esbuild` `^0.28.2`, so no range spfn publishes admits
  GHSA-g7r4-m6w7-qqqr** (esbuild `>=0.27.3 <0.28.1`, low: file read through esbuild's dev server
  on Windows). spfn depended on `tsup` `^8.5.0` and `esbuild` `^0.27.0`. tsup 8.4.0 and 8.5.0
  depend on esbuild `^0.25.0`, outside the advisory, but 8.5.1 moved to `^0.27.0`, and a fresh
  resolve of `^8.5.0` takes 8.5.1 and with it esbuild 0.27.7, inside the advisory; so did spfn's
  own `^0.27.0`. tsup 9 requires esbuild `^0.28.2` and rollup `^4.64.6`. `spfn init` now writes
  `tsup` `^9.0.0` into a new app's devDependencies, and every package builds with tsup 9.
  `@/` aliases still resolve through the app's tsconfig `paths`, with or without `baseUrl`. tsup 9
  requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`, which spfn's own floor
  (`^22.23.4 || ^24.22.1 || >=26.12.1`) already satisfies, so the Node floor does not move.

  **Class fields in `spfn build` output, if your server tsconfig targets ES2022 or later.** Check
  `target` (and `useDefineForClassFields`) in `src/server/tsconfig.json`. Below ES2022 — the
  examples and a fresh scaffold target ES2020 — `spfn build` output is byte-identical to before.
  At ES2022 or later (unless `useDefineForClassFields` is `false`), or with
  `useDefineForClassFields: true` at any target, esbuild 0.27.5 and later emit a
  TypeScript parameter property as a class field (define semantics), as `tsc` does at that target
  and as `spfn dev` (tsx) already does at any target. Before, the build assigned it in the
  constructor. What you can see:
  - a parameter property named like an inherited property becomes an own enumerable field. For an
    error class `constructor(public readonly message: string)` extending `SerializableError`,
    `message` is then a field `toJSON()` serialises, and `message` is a reserved response key:
    `toJSON()` throws `<YourError> declares the reserved field "message"` under test and logs that
    ERROR in production, omitting the field. Drop the modifier and pass the value to `super`;
  - a parameter property with the name of an accessor the base class defines shadows the
    accessor;
  - `Object.keys()` and `JSON.stringify` list such fields in a different order.

  This is new only relative to an older lockfile. A fresh install of spfn 0.4.0-beta.1 already
  resolves esbuild 0.27.7 and builds this way.

### Changed

- **BREAKING: route modules are ES modules in codegen**, as they already are in `spfn dev` and `spfn build`.
  A type-only name imported or re-exported without `type` fails to link there too; top-level await
  in a route module now loads (in `.spfnrc.ts` it cannot: it is `require()`d).
- **BREAKING: a `.cts` route that requires `@spfn/*` is refused in CLI codegen** when tsx evaluates what it
  requires as a CommonJS copy (tsx 4.20, 4.23), with the message `startServer` refuses with, naming
  the file. Import `@spfn/*` from an ES module.
- **BREAKING: a package's `NODE_ENV`-dependent route is no longer refused** — it was only by accident, when a
  project file also read `NODE_ENV`. The map has the route as production registers it.
- **BREAKING: tsconfig `paths`: every target of an entry is tried per import, in order, as tsc does**, the
  pattern with the longest prefix wins, and a `*` may sit anywhere in a pattern. One target per key
  used to be chosen for the whole load (the first that held anything), with warnings about the
  others; an import now resolves through whichever target has it, and a failure lists every target
  tried.
- **BREAKING: TypeScript outside the app root is evaluated once per process and not watched.** A
  sibling workspace package's source reached through tsconfig `paths` (or a link) is transformed
  and evaluated once, like a package; jiti re-ran it on every load. After editing it, restart
  `spfn dev`'s watcher (or whatever runs codegen) for the route map to see the change.
- **BREAKING: `.spfnrc.ts` and custom `.ts` generators are ES modules.** `__dirname`, `__filename`,
  `require` and `module.exports` are not defined in them (jiti ran them as CommonJS). Write
  `import.meta.dirname` and `import.meta.filename`, `import`, and `export default`.
- **BREAKING: a codegen config that exists and fails to load is an error, and so is a generator
  it names that cannot be loaded.** A `.spfnrc.ts` that throws or does not compile, a
  `.spfnrc.json` or `package.json` that is not JSON, a custom generator whose file fails to load,
  exports no factory or whose factory throws, and a package generator that is not found (a
  misspelt `@spfn/core:route-mapp`, a package not installed), whose `<package>/codegen` throws on
  import or whose factory throws, or an entry that is not `"<package>:<generator>"` nor a `path`,
  used to be logged as a warning and skipped: `spfn codegen run` printed "No generators
  configured" (or "Make sure X is installed") and exited 0, so a CI build skipped codegen. It now
  fails — `spfn codegen run` and `spfn build` exit non-zero with the reason (`Failed to load
  .spfnrc.ts (at .spfnrc.ts:4:17): <message>`, `Cannot load generator "@spfn/core:route-mapp":
  …`), and the `spfn dev` watcher reports it and stops, saying route maps are not regenerated
  until the config is fixed and `spfn dev` restarted (the server keeps running). Only an absent
  config, or one naming no generator, means none; `enabled: false` still skips an entry.

### Documentation

- **@spfn/core: `enumText` is documented as what it is** (spfn/spfn#167): it narrows the TypeScript
  type only; the column is plain `text`, the database accepts any string, and adding a value needs no
  migration. The schema README called it a column "with enum constraint" and "plain text + CHECK";
  there never was a CHECK. `enumText` itself is unchanged.

## [@spfn/core@0.4.0-beta.1, @spfn/auth@0.4.0-beta.1, spfn@0.4.0-beta.1, @spfn/storage@0.4.0-beta.1, @spfn/cms@0.4.0-beta.1, @spfn/mcp@0.4.0-beta.1, @spfn/notification@0.3.0-beta.1, @spfn/monitor@0.3.0-beta.1, @spfn/i18n@0.3.0-beta.1, @spfn/migrate@0.3.0-beta.1, @spfn/pages-next@0.2.0-beta.1, @spfn/pages@0.2.0-beta.1, @spfn/signing@0.2.0-alpha.1, @spfn/workflow@0.3.0-alpha.1] - 2026-11-18

**Upgrading.** 0.3 and 0.4 packages cannot be mixed: upgrade every `@spfn/*` package and `spfn`
together, then `tsx`, and regenerate with `pnpm codegen`. The order, who has to act on each
BREAKING item, and the error each missed step produces are in
[Upgrading from 0.3 to 0.4](./docs/guides/migration/upgrade-0.4.md).

### Changed

#### Dependencies (all packages)

- **BREAKING: each `@spfn/*` package requires the others' 0.4 line; 0.3 and 0.4 packages cannot
  be mixed**. Every peer range one `@spfn/*` package has on another moves to the new line — for
  example `@spfn/core` `>=0.4.0-beta.1 <0.5.0-0`, `@spfn/notification` `>=0.3.0-beta.1 <0.4.0-0`,
  and `@spfn/pages-next`'s `@spfn/pages` `>=0.2.0-beta.1 <0.3.0-0`. pnpm checks peers with
  prereleases included, and `0.5.0-beta.1` orders below `0.5.0`, so a range ending `<0.5.0` would
  admit the next line's betas; the 0.4 ranges end `-0`, which refuses them. The published 0.3
  ranges end `<0.4.0` and cannot change, so they admit `0.4.0-beta.1`. pnpm therefore reports only
  one direction of a mix: a 0.4 package beside a 0.3 one is an unmet peer (`✕ unmet peer
  @spfn/core@">=0.4.0-beta.1 <0.5.0-0": found 0.3.0-beta.38`), while a 0.3 package beside a 0.4
  `@spfn/core` installs without a warning — hence upgrade every `@spfn/*` package together.
    - **Migration**: upgrade every `@spfn/*` package and `spfn` in one step: the beta packages by
      `@beta`, `@spfn/signing` and `@spfn/workflow` by `@alpha`.

- **BREAKING: Next.js `^16.4.5`, `hono` `^4.13.16` and `@hono/node-server` `^2.1.6` are
  required**. Every package that couples to Next.js requires `^16.4.5`, the release that clears
  the seven advisories of 2026-11-03 (information disclosure through `use cache` functions and
  root params, a poisoned fallback shell, response desynchronisation, Edge cookie exposure and
  SVG image optimization). `@spfn/core` depends on `hono` `^4.13.16` (RegExpRouter skipping
  wildcard middleware, `mount()` prefix bypass, `validator('form')`, `csrf()` and `css` fixes)
  and `@hono/node-server` `^2.1.6`, which answers 400 to a raw backslash in the request path
  instead of routing `/admin\x` as `/admin/x`, and no longer crashes on a reset during a
  WebSocket upgrade; an app gets both through core. `@spfn/auth`'s `hono` peer moves to
  `^4.13.16`, the range core depends on. `@spfn/mcp` and `spfn` use hono only in their tests,
  so nothing they publish changes.
    - **Migration**: upgrade Next.js to 16.4.5 or later; an app that declares `hono` itself
      raises it to `^4.13.16`. A server behind a path-matching reverse proxy now refuses a
      request-target with a raw `\`.

- **BREAKING: the AWS and Google Cloud SDKs these packages accept have security floors**. A
  root override in this repository only moved the repository; an app installing the published
  ranges could still resolve the vulnerable graphs, so the ranges move. `@spfn/signing`:
  `@google-cloud/kms` `^5.0.0` → `^6.0.0` (5 reaches, through google-gax and gaxios 7, a rimraf
  on glob 10 and minimatch 9 with no patched release — GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249;
  6 changes no API signing uses and requires Node 22, as signing already does) and
  `@aws-sdk/client-kms` `^3.0.0` → `^3.1074.0`. `@spfn/notification`: `@aws-sdk/client-sns`
  `^3.0.0` → `^3.1074.0` and `@aws-sdk/client-sesv2` `^3.0.0` → `^3.1074.0`. `@spfn/storage`:
  `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` `^3.1022.0` → `^3.1074.0`. Every AWS
  client before 3.974.0 pins `@aws-sdk/core` exactly, and through it an XML builder on a
  vulnerable `fast-xml-parser` (one critical advisory among them); from 3.974.0 until 3.1074.0
  the core is a caret range whose lowest release still reaches one, so a lockfile holding it keeps it.
  3.1074.0 is the first release of each client whose lowest admitted graph has no advisory.
  `@spfn/storage`'s optional `@google-cloud/storage` `^7.19.0` → `^8.3.0` (every 7.x and 8.0–8.2
  reach a `uuid` with GHSA-w5hq-g745-h8pq; 8 requires Node 22, and with a base64 key its
  google-auth-library prints one cosmetic deprecation line at start — see below).
  `@spfn/pages`: `yaml` `^2.5.0` → `^2.8.3` (GHSA-48c2-rrv3-qjmp, stack overflow on deeply
  nested YAML). `@spfn/auth`: `jsonwebtoken` `^9.0.2` → `^9.0.3`; 9.0.2 admits `jws` 3.2.2
  (GHSA-869p-cjfg-cm3x, HMAC signatures verified improperly), 9.0.3 depends on `jws` `^4.0.1`.
    - **Migration**: an app using a KMS or notification provider upgrades the SDK it installed:
      `pnpm add @google-cloud/kms@^6`, `pnpm add @aws-sdk/client-kms@^3.1074.0`, `pnpm add
      @aws-sdk/client-sns@^3.1074.0 @aws-sdk/client-sesv2@^3.1074.0`. An app that depends on
      `@google-cloud/storage` itself raises it to `^8.3.0`. Storage's AWS SDK, auth's
      `jsonwebtoken` and pages' `yaml` are dependencies and need nothing.

#### @spfn/auth

- **BREAKING: a second copy of `hono` is refused, not answered as policy** (#329). The
  enrolment gate reads which route a request matched, and only the copy of Hono that built the
  request can say. Under `secondFactor.required: true`, `createAuthLifecycle()`'s `afterRoutes`
  refuses to boot an app built by another `hono` copy (`Refusing to start: @spfn/auth cannot read
  the server's routes — two copies of hono are loaded in this process …`). A request from another
  copy that reaches the gate — under a custom `app.ts`, where that hook does not run — is a 500
  with a logged error instead of 403 `SECOND_FACTOR_ENROLMENT_REQUIRED`. Without a required second
  factor nothing reads a route, and the app boots as before.
    - **Migration**: make `hono` resolve to one install for the app, `@spfn/core` and
      `@spfn/auth` (`pnpm why hono`), and run the server as one module format: under `spfn dev`
      from a `spfn` CLI of the same release as `@spfn/core`.

#### @spfn/storage

- **`engines.node` is declared**: `^22.23.4 || ^24.22.1 || >=26.12.1`, the range of every other
  package that declares one. Storage had none, while its optional `@google-cloud/storage` 8 needs
  Node 22.

- **One deprecation line at start with a base64 GCS key**: with `GCS_CREDENTIALS_JSON_BASE64` /
  `credentialsJsonBase64` set, google-auth-library 11.3.2 and later (what `@google-cloud/storage`
  8 installs) print "The `credentials` option is deprecated…" once per process. It is cosmetic;
  the provider keeps passing the key as `credentials`, which storage 8.4.0 still documents. The
  replacement the warning names, `authClient`, signs URLs with the wrong account, so it is not
  used. For no warning, point `GOOGLE_APPLICATION_CREDENTIALS` at a key file instead of setting
  the base64 variable: that is silent and signs as the key's account.

#### @spfn/core

- **BREAKING: a server process refuses a second copy of `@spfn/core`** (#329). Each built entry
  records where it was loaded from and what evaluated it — Node's ESM loader, a CommonJS
  evaluation (as `tsx` runs one), vitest's module runner, or a bundler. `startServer` marks the
  process as a server before it loads anything of the app; from then on another file (a second
  install: two versions, or one version installed twice) or the same file by another evaluator is
  refused where it is evaluated — at boot, or later by the `import` or `require` that would load
  it, which fails that request or job and is logged once while the server keeps serving. The
  message starts `Refusing a second copy of @spfn/core in this process:` and names the files,
  the evaluators and the remedy. Processes that never call `startServer` — `spfn codegen`, the
  codegen watcher, `spfn db generate`, scripts, a Next.js server bundling core — record and
  never refuse.
    - **Migration**: upgrade `spfn` and `@spfn/core` together — an older `spfn` CLI runs a
      project without `"type": "module"` as CommonJS, and this core refuses that boot. Make
      `@spfn/core` resolve to one install (`pnpm why @spfn/core`), and import `@spfn/*` from ES
      modules only.

- **BREAKING: code generation runs under `NODE_ENV=production`, and the route map refuses any
  environment-dependent content** (#334). The committed route map was written by two
  generators under two environments — `spfn dev`'s watcher under `development`, `spfn codegen
  run` / `spfn build` under `production` (pinned only when unset) — and the environment probe
  compared only name → method + path, so a `csrf` declared in one environment, an
  environment-dependent entry order, or a `.packages()` mount present only in development
  produced two different files that both passed. Code generation now runs under `production`
  unconditionally, logging once when it replaces a different value. The value belongs to the
  generating process and is set before any project code is evaluated — `spfn dev` starts its
  watcher with `NODE_ENV=production`; `loadCodegenConfig`, `createGeneratorsFromConfig` and
  the `CodegenOrchestrator` constructor pin — so `.spfnrc.ts` and a custom generator listed
  before or after the route map see `production` on every watcher run, not `development` on
  the first one only. The built-in generators no longer pin for themselves. A programmatic
  caller's process keeps `NODE_ENV=production` from its first codegen call on. The probe
  compares the whole file it would write and names the difference (`~ ping: csrf 'required' →
  none`, `order of the app's routes: a, b → b, a`, else the first differing line); when
  the header's mount lines differ it shows both lists in full, each under the environment that
  wrote it, since no part of a mount line identifies the same mount across two loads. It varies `NODE_ENV` over each conventional value other than `production` —
  `development` and `test`, one load each — and names the value that produced the difference,
  so a route registered only under `test` is refused too. Any other key is varied once (set →
  deleted, unset → `'true'`), so a comparison of such a key against one particular value
  (`=== 'on'`) is not covered; nor is a `NODE_ENV` value outside the three.
  The `Generated with NODE_ENV=…` header line is gone from the route map and the state
  manifest. A route a package registers only outside production is served by `spfn dev` but is
  not in the map.
    - **Migration**: register routes, `.csrf()` and `.packages()` mounts unconditionally and
      gate behaviour inside the handler; regenerate committed files (`pnpm codegen`), which
      drops the header line.

#### spfn (CLI)

- **BREAKING: `spfn dev` runs application server source as ESM, as `spfn build` does** (#329).
  A project without `"type": "module"` — every `spfn create` scaffold — ran its `.ts` source as
  CommonJS under `tsx`, which loaded a second, CommonJS copy of each `@spfn/*` package beside the
  server's ESM one: rate-limit `policies` and `.trustedProxyHops()` were ignored by `@spfn/auth`'s
  routes, and with `secondFactor.required` an account without a factor got 403
  `SECOND_FACTOR_ENROLMENT_REQUIRED` on the enrolment routes too. `spfn dev` now passes `tsx` a
  module hook (`--import`, registered with `module.registerHooks`) in the server process and the
  codegen watcher: `.ts` and `.tsx` run as ESM whatever the `"type"`; `.js` and `.jsx` in a
  package with no `"type"` are decided by their own syntax; a stated `"type"` or a `.mjs`,
  `.cjs`, `.mts` or `.cts` extension is left alone; dependencies are not touched. Dev only:
  `spfn build` already bundled server source as ESM.
    - **Migration**: CommonJS shapes in server source stop running under `spfn dev` — `require`,
      `__dirname`/`__filename`, a named import from a file written with `module.exports`, and a
      CommonJS file that requires `@spfn/*`. Write them as ESM (`import`, `import.meta.dirname`,
      `export const`). The full table, against `spfn build` + `spfn start`, is in the CLI README
      under "Your server source runs as ESM, as it does in production".

- **BREAKING: the scaffold requires `tsx` `^4.22.4`** (#329). `spfn dev` runs the project's own
  `tsx`, and one before 4.22 registers its hooks with the deprecated `module.register()` and
  prints `DEP0205` at every start on Node 26. `spfn init`, which `spfn create` runs, writes
  `^4.22.4`, and so do the examples.
    - **Migration**: `pnpm add -D tsx@^4.22.4`.

- **BREAKING: the `spfn dev` codegen watcher runs under `NODE_ENV=production`** (#334): it is
  started with it in its environment, so the watcher entry, `.spfnrc.ts` and every generator
  load under it from the first run, as under `spfn codegen run` and `spfn build`, so all three write the same generated bytes; the
  dev server keeps `development`. An app whose generated content differs by environment beyond
  its route set is now refused at generation by all three (see `@spfn/core`).
  `scripts/smoke-dev-example-03.mjs` asserts the watcher generates the route map and leaves it
  byte-identical to the committed blob (`git show HEAD:…`) instead of restoring it; a watcher
  that exits before writing fails the run.
    - **Migration**: as for `@spfn/core` above — register routes, `.csrf()` and `.packages()`
      mounts unconditionally, then regenerate (`pnpm codegen`) and commit.

- **BREAKING: `spfn build` runs under `NODE_ENV=production` from its codegen step on** (#334).
  Codegen pins `production` in the building process whatever the shell set, so with
  `NODE_ENV=development spfn build` (or `test`) the later steps of the same process — the
  project's `build` script (`next build`) and the tsup server build — now inherit `production`
  where they used to inherit the shell's value. A build that needs another value for those steps
  has to run them itself.

### Added

#### @spfn/auth

- **A `passkeyLogin` channel** (#330). `createAuthLifecycle({ channels: { passkeyLogin: false } })`
  closes signing in with a passkey alone: `passkeyLoginOptions` and `passkeyLoginVerify` answer 404
  `CHANNEL_DISABLED` (`details.channel: 'passkeyLogin'`) from the first of the route's own
  middlewares, so no rate-limit budget is spent. An app whose rule is a password plus a passkey
  (`secondFactor: { required: true, methods: ['passkey'] }`) can now close the routes that
  bypassed the password. Registering, listing, renaming and revoking passkeys, proving one at
  `mfa/verify` and `mfa/step-up`, session renewal and a bound session's passkey proofs stay on.
  The channel is on by default, so an app that states nothing serves what it served before.

### Fixed

#### @spfn/mcp

- **The app origin is read at first use, not when the router is created** (#337), so an app
  that mounts the MCP route passes `spfn codegen run` without an env file. `createMcpRoute`
  and `createMcpHttpRoute` accept `appUrl` as a function, called on the first `/mcp` request
  or the first answer of a metadata route and kept once it succeeds; a call that throws fails
  that request with a `500` through the application's error handler, and the next request
  calls again. The new `resourcePath` option (default `/mcp`) names the resource's path in
  code, so the route set does not depend on the environment; with a function `appUrl` the
  resource is `<origin of appUrl()><resourcePath>`, and `resource` is not accepted beside it
  (nor beside `resourcePath`) — a type error, and refused at run time. A string `appUrl`
  behaves as before.

#### spfn (CLI)

- **The `spfn ops token` hint for an `@spfn/auth` without `@spfn/auth/crypto` names the release
  line, not a range** (#340). It said `pnpm add @spfn/auth@'>=0.3.0-beta.2 <0.4.0'`, which after
  this release installs an auth of the previous line. It now says to update `@spfn/auth`
  together with `@spfn/core` by dist-tag (`pnpm add @spfn/core@beta @spfn/auth@beta`), and `spfn`
  the same way where it is installed.

## [0.3 beta line: @spfn/core@0.3.0-beta.5…0.3.0-beta.38, @spfn/auth@0.3.0-beta.5…0.3.0-beta.53, spfn@0.3.0-beta.5…0.3.0-beta.22, @spfn/storage@0.3.0-beta.2…0.3.0-beta.3, @spfn/cms@0.3.0-beta.2…0.3.0-beta.6, @spfn/mcp@0.3.0-beta.2…0.3.0-beta.5, @spfn/notification@0.2.0-beta.2…0.2.0-beta.13, @spfn/monitor@0.2.0-beta.2…0.2.0-beta.5, @spfn/i18n@0.2.0-beta.3…0.2.0-beta.10, @spfn/pages-next@0.1.0-beta.8…0.1.0-beta.12, @spfn/signing@0.1.0-alpha.1…0.1.0-alpha.3, @spfn/workflow@0.2.0-alpha.2] - 2026-08-11 to 2026-11-17

Released across these versions between the 2026-08-10 release and 2026-11-17; where an entry names
the version it shipped in, it says so. `@spfn/migrate` (0.2.0-beta.1) and `@spfn/pages` (0.1.0-beta.4)
were not released in this span.

### Changed

#### Dependencies (all packages)

- **BREAKING: Node 20 is no longer supported, and Next.js `^16.4.1` is required** (#282).
  `engines.node` is `^22.23.4 || ^24.22.1 || >=26.12.1` in the repository root and in every
  package that declares `engines` (core, spfn, i18n, mcp, signing, workflow): Node 20 reached end
  of life without the fix for CVE-2026-111497 (remote code execution in the bundled Brotli
  decoder). Every package that couples to Next.js requires `^16.4.1`, the release that clears
  the 2026-10-14 advisories (two critical remote code executions and a Server Actions denial of
  service); #244 had raised the floor from `^16.3.3` to `^16.3.8` two weeks earlier.
  `@spfn/core` also moves to `undici` `^7.30.1`, `zod` `^4.6.6` and `hono` `^4.13.11`.
    - **Migration**: upgrade Node and Next.js first; nothing else in an app changes.
    - core 0.3.0-beta.31, auth 0.3.0-beta.47, cms 0.3.0-beta.6, i18n 0.2.0-beta.10, monitor
      0.2.0-beta.5, pages-next 0.1.0-beta.12, spfn 0.3.0-beta.19, mcp 0.3.0-beta.4, signing
      0.1.0-alpha.3, workflow 0.2.0-alpha.2.

#### @spfn/notification

- **BREAKING: a cancelled scheduled email or SMS is never sent** (#112). `cancelNotification`
  moves the history row from `scheduled` to `cancelled` in one status-guarded update, and the
  scheduled job sends only a row it can move to `pending`, so a cancel holds even when it races
  the send time. It answers `{ success, jobCancelled }`: `jobCancelled: false` means the queued
  job could not be removed, and the send is still stopped. A send in progress or already sent
  is refused with `success: false`. `notification` 0.2.0-beta.6.
    - **Migration**: `cancelScheduledNotification` is renamed `markNotificationCancelled`, and
      it now returns `Promise<boolean>` (whether it updated the row) instead of the updated
      `Notification` or `null`. It only updates the record and does not touch the queue; call
      `cancelNotification` to stop a send.

#### @spfn/auth

- **Per-person settings declared in code, and `locale`/`timezone` move out of `user_profiles`**
  (#161, #305). `spfn_auth.user_settings` is a library-owned table with one row per
  `(user_id, key)` and a `jsonb` value; no row means the declared default, and writing the
  default deletes the row, so a changed default reaches everyone who never chose. An app
  declares its keys once, `defineUserSettings([{ key, schema, default }])`, and installs them
  with `createAuthLifecycle({ userSettings })`; a duplicate key, a default its own schema
  rejects, a malformed key or a redeclared built-in throws when the module loads, and nothing
  can be installed after boot. `getUserSetting`, `setUserSetting`, `listUserSettings` and
  `resetUserSetting` refuse an undeclared key (404) and a value that fails its schema (400); a
  stored value that no longer passes reads as the default with one warning. Boot reports stored
  keys no declaration names and never deletes them. Self-only routes `GET /_auth/users/settings`
  and `GET|PUT|DELETE /_auth/users/settings/:key` reach the client as `authApi.listSettings`,
  `getSetting`, `setSetting`, `resetSetting`. `locale` (`string | null`, default `null`) and
  `timezone` (IANA name, default `'UTC'`) are built-in keys: the profile table says who a
  person is, settings say how they use the app. `defineProfileFields([{ key, schema, default? }])`
  declares the keys `user_profiles.metadata` may hold; with a declaration the metadata PATCH is a
  per-key merge, an undeclared key or a schema failure is a 400, and undeclared stored keys are
  hidden and reported at boot; without one, metadata stays free-form. Limits: a setting value
  16 KiB, a metadata patch 64 KiB, `locale` 35 characters, `timezone` 64, no NUL character.
  `auth` 0.3.0-beta.52.
    - **Migration**: run `spfn db migrate` before the first boot on this version — the
      migration creates the table and copies every non-blank `user_profiles.locale` and every
      non-blank, non-`UTC` `timezone` into it, and `initializeAuth` reads the table at boot.
      The two columns stay for this release but are no longer read or written; they are dropped
      in a later release. `PATCH /_auth/users/locale`, `updateUserProfile({ locale, timezone })`
      and `ProfileInfo.locale` / `chosenLocale` / `timezone` keep working and are deprecated;
      read them through `listUserSettings` instead. A legacy timezone that is not an IANA zone
      reads as `'UTC'`, and an invalid timezone on the profile PATCH is now a 400 (any string was
      stored before). An app that kept its own `user_settings` table declares its keys and moves
      the rows with the SQL in the auth README ("Migration — settings own locale and timezone").
- **Behaviour change: `auth.register`, `auth.login` and `auth.invitation.accepted` fire after
  the transaction commits, never on rollback** (#156 follow-up, #295). The web OAuth callback,
  email register (`/_auth/register`, `/_auth/signup/password`), password login and invitation
  accept published these events inside their transaction, so a subscriber could run before the
  account was visible to another connection, and hear about a sign-up that then rolled back. They
  now go through `onAfterCommit`. A failed publish (say, `cache.publish` rejecting) is logged and
  no longer turns a committed sign-in into an error and a rollback; a throwing subscriber was
  already only logged. `auth` 0.3.0-beta.51.
    - **Migration**: a subscriber that read the new account inside the request's transaction,
      or relied on its own failure failing the sign-in, must not: the event now arrives after the
      transaction is over, and its failure is only logged.
- **Behaviour change: account-existence checks find an address stored in another case, and
  `oauthEmailMatch: 'attach'` answers 409 for case variants it cannot choose between** (#156,
  #297). The startup backfill folds stored emails to lower case but leaves alone accounts that
  differ only by case, and an older instance can write a mixed-case row after it. Social
  sign-in's email match, the verified-email backfill, email register, the registration code,
  the signup link and invitation create now look an address up by `lower(btrim(email))`
  (`usersRepository.findByFoldedEmail`), so a sign-up or a first social sign-in no longer
  creates a second account next to `Owner@Example.com`. A stored lower-case row still wins over
  its variants. Login, password reset, `getUserByEmail` and account deletion keep the exact
  lookup. `auth` 0.3.0-beta.51.
    - **Behaviour change**: with two or more variants and no lower-case row
      (`Owner@Example.com` and `OWNER@Example.com`), `'attach'` refuses with
      `409 OAuthEmailInUseError` (`reason=email_in_use`), as `'reject'` does, rather than link
      the identity to one of them; an unverified provider email meeting them gets the same 409.
      `'separate'` still makes a new account.
    - **Migration**: a new migration, `20261101134440_fuzzy_moira_mactaggert`, adds the
      non-unique index `users_email_folded_idx` on `lower(btrim(email))`; run `spfn db migrate`.
      It is a plain `CREATE INDEX` inside the migration transaction, so it locks `users`
      against writes while it builds. An app that shows `email_in_use` only for `'reject'`
      should show it for `'attach'` too; settle the accounts the backfill logs as
      capitalization conflicts.
- **Behaviour change: `SPFN_AUTH_SESSION_TTL` takes effect** (#126). The variable was ignored
  and every session lasted seven days; a malformed value is now refused when the environment
  is validated. See the README's "Migration — `SPFN_AUTH_SESSION_TTL` takes effect".
  `auth` 0.3.0-beta.33.
- **Behaviour change: no localhost defaults for the app and API URLs** (#119). `@spfn/core`
  alone declares `SPFN_API_URL`, `NEXT_PUBLIC_SPFN_API_URL` and `SPFN_APP_URL`; an app-origin
  reader in `@spfn/auth` (OAuth callbacks, the OAuth 2.1 authorize URL, the emailed signup
  confirmation, password reset and sign-out-everywhere links) throws naming `NEXT_PUBLIC_SPFN_APP_URL` and `SPFN_APP_URL` when neither is set, where it
  used to fall back to localhost in production. `auth` 0.3.0-beta.32.
- **Behaviour change: a chosen locale is told apart from none** (#110). `user_profiles.locale`
  no longer defaults to `'en'`; NULL means the person never picked a language, and
  `getChosenLocale(c)` / `ProfileInfo.chosenLocale` answer it. See the README's "Migration —
  tell a chosen locale from none". `auth` 0.3.0-beta.31.

- **BREAKING: the package ships no HTML screens** (#108). `createRevokeAllPageHandlers` and
  `createOAuth2AuthorizeHandlers` are removed from `@spfn/auth/nextjs/server`, with
  `RevokeAllPageView`, `RevokeAllPageHandlerOptions`, `RevokeAllPageHandlers`,
  `OAuth2AuthorizeHandlerOptions`, `OAuth2AuthorizeHandlers`, the nextjs-side
  `OAuth2ConsentView` and `OAuth2ConsentScope`, and `escapeHtml`. The JSON routes are unchanged,
  and so is the `OAuth2ConsentView` `@spfn/auth/server` exports as their response type.
    - **Migration**: replace `app/account/revoke-all/route.ts` and `app/oauth/authorize/route.ts`
      with pages of your own that call `authApi` (`confirmRevokeAllLink` /
      `consumeRevokeAllLink`, `getOAuth2Authorize` / `createOAuth2AuthorizationCode`), as the
      login and reset screens already do. The README's "The sign-out-everywhere link" and "The
      consent screen" show both. The consent page owns what the handler enforced: the login
      redirect with `?returnUrl=`, redirecting only to the API-returned `redirectUri`, showing
      `unknown_client` / `redirect_uri_mismatch` instead of redirecting, rendering `clientName`
      as text, and `frame-ancestors 'none'` plus `Cache-Control: no-store` via `next.config`
      `headers()`. The consent POST's CSRF check is the proxy's, in every mode.
- **BREAKING: a sign-in no longer always answers with a session** (#95). An account that has
  enrolled a second factor and signs in from a device the account has never seen gets `202`
  and a challenge instead; the device key that sign-in registered stays inactive until the
  challenge is spent, so a phished password on its own no longer holds an account.
  `LoginResult` therefore gains one **required** field, `mfaRequired`, and every field it
  carried before is now optional. It is still **one** type rather than a union, because
  `authApi.login` infers its result from that declaration and a union would turn every
  `result.userId` in an app into a compile error with no narrowing available.
    - **Migration**: narrow on the discriminant before reading anything else.

      ```typescript
      const result = await authApi.login.call({ body: { email, password } });

      if (result.mfaRequired)
      {
          // No session yet. result.challenge is { secret, expiresAtMillis }.
          router.push('/auth/mfa');

          return;
      }

      console.log(result.userId); // string, from here on
      ```

      The same reshape applies to `authApi.oauthNative` (`OauthNativeResult`), to
      `completePasswordReset`, and to the approved branch of `pollDeviceAuth` — which carries
      `mfaRequired: false` and can never carry anything else, a device-code approval being a
      second factor already. An account with no second factor still answers `200` with
      `mfaRequired: false` and exactly the fields it always had, and an app on the Next.js
      proxy changes nothing at all: `mfaVerifyInterceptor`, registered for you in
      `authInterceptors`, handles the 202 and the pending cookie.
    - Mobile contract **0.13.0**. Four channels stop on a new device — password, web OAuth,
      `oauth-native` and password-reset. A device-code approval, a passkey sign-in, a key
      rotation, a session renewal and any path that creates the account do not, because each
      already carried a second proof or has nothing enrolled yet.
- A `202` moves nothing else either: `authLoginEvent`, `authDeviceRegisteredEvent` and
  `lastLoginAt` are held on the challenge row and fire together at `POST /_auth/mfa/verify`
  with the original channel (#95). An app that mails "new device signed in" therefore sends
  nothing for an attempt that never became a sign-in.

#### @spfn/mcp

- `validateToken` may refuse a bearer token by returning `null` or `undefined` as well as by
  throwing; the adapter treats all three identically (#93). That is what lets
  `@spfn/auth`'s `verifyAccessToken` be passed straight in, since it answers `null` for an
  expired, revoked or wrong-resource token. `@spfn/mcp` 0.3.0-beta.3.

#### @spfn/storage

- The local S3-compatible example in the documentation is **SeaweedFS** (`weed server -s3`,
  S3 on `:8333`, bucket versioning supported), not MinIO: open-source MinIO is archived and
  its binaries are no longer served. The `STORAGE_CONTRACT_S3_*` variables and the provider
  contract suite are unchanged — only the server you point them at.

#### @spfn/core

- **Behaviour change: the server checks the environment at boot** (#119). `startServer` runs
  `validateAllEnv` over `@spfn/core`'s registry plus the registries the app passes with
  `defineServerConfig().env({ registries })`. A missing or invalid variable is logged by key
  and reason, never by value, and the process exits 1 before a port is bound;
  `createServerlessApp` rejects instead. `SKIP_ENV_VALIDATION` does not apply. `core`
  0.3.0-beta.16.
- **Behaviour change: a job's `retryDelay` is milliseconds, as documented** (#233). It was
  handed to pg-boss, which reads seconds, unconverted, so `retryDelay: 5000` waited 83
  minutes. A job that passed seconds to work around it now retries far sooner. `core`
  0.3.0-beta.15.

- **BREAKING: a nested `runInTransaction` / `Transactional()` call is now a `SAVEPOINT` on the
  outer transaction's connection, not an independent transaction on a second one** (#82). It
  sees the outer transaction's uncommitted writes, takes no second connection from the pool,
  no longer self-deadlocks on a row the outer transaction locked, and commits or rolls back
  **with the root** — which is what the documentation had always claimed.
    - **Migration**: code that relied on a nested call committing on its own — an audit row or
      a failed-attempt record meant to survive an outer rollback — must pass
      `requiresNew: true`, a new option on `RunInTransactionOptions` and `TransactionalOptions`
      that opens a real `BEGIN` with its own timeouts and its own hook queues. Everything else
      needs no change.
    - **BREAKING, second dimension: nested calls made off one transaction no longer run
      concurrently.** They share one connection, where two open savepoints corrupt each other
      — the first `ROLLBACK TO` discards everything written on the connection since that
      savepoint, including a sibling's rows, while the sibling reports success. The runner now
      queues nested frames per transaction, so `Promise.all([nestedA(), nestedB()])` still
      returns both results but runs them one at a time. A branch that needs real concurrency
      takes `requiresNew: true` and its own connection. A nested call whose callback awaits a
      sibling started after it deadlocks — documented as misuse, with a once-per-process
      `warn` the first time frames contend.
    - A `timeout` passed to a nested call is ignored, as before (the root's `statement_timeout`
      is in force on the shared connection and is now genuinely inherited), but the `warn` for
      it fires only when the caller passed a timeout explicitly — it used to fire on every
      nested call, because the default is 30s.
    - Driver caveats now documented in `src/db/transaction/README.md`: the pinned driver never
      issues `RELEASE SAVEPOINT`, and a write inside a nested frame holds one of the backend's
      64 cached subtransaction ids until the root ends, so per-row nesting in a loop pushes the
      backend into subxid overflow.

- **The app's generated route map now carries the routes of the package routers the app
  mounts** (#101). `@spfn/core:route-map` used to walk `.packages()` for names alone and throw
  the method and path away, on the assumption that every package publishes its own route map
  for the app to merge (`{ ...routeMap, ...authRouteMap }`). Two first-party packages publish
  none and still address their routes by name — `@spfn/monitor`'s dashboard calls
  `monitorApi.getStats.call({})`, `@spfn/cms` calls `api.getLabelCache.call(…)` — and
  `createApi` resolves nothing itself: it posts `/api/rpc/{routeName}` and `createRpcProxy`
  looks the name up in the one map it was constructed with. Those calls resolved nowhere. A
  runtime merge is not available to fix it (`rpc.ts` lives in the Next.js app, `.packages()`
  on the backend router), so the generator — which already loads that router — keeps what it
  was discarding.
    - **`{ ...routeMap, ...authRouteMap }` is no longer needed and stays harmless**: the two
      maps now hold the same entries for auth, so the spread is a no-op. `authRouteMap` is
      still exported from `@spfn/auth` and nothing has to change in an existing app.
      `spfn init` stops emitting the merge (the `import '@spfn/auth/nextjs/api';` side effect
      stays), and `examples/03-auth` drops it. `eventRouteMap` stays merged by hand: it is a
      hand-written constant, not a mounted router.
    - A router built with `defineUnmappedRouter` contributes nothing, at any depth, exactly as
      before — the ops surface (`createOpsRouter`) and `@spfn/notification`'s tracking routes
      are reached by URL and named by nobody.
    - **BREAKING: two package routers reaching one name is now refused**, naming both mounts.
      It was tolerated while the app's spread order decided the winner and the generator
      neither saw nor wrote that order; the generator writes it now, so an app that already
      mounts two packages that took the same name stops building. **Migration**: drop one of
      the two mounts, or raise the name with the package that took it second — nothing of the
      app's own can be renamed to fix it, because neither of the two names is the app's. The
      same route reached through two mounts (a package exporting its routes under two routers)
      is still one route and is not a collision.
    - The generated file keeps the app's own routes first, in their order and spelling, then
      the package routes under a comment line naming where they came from; the header says how
      many there are and which mount each came through. **An app that mounts no package
      regenerates byte-identically.**
    - The copy is as old as the file: a package upgrade reaches an app only through a
      regeneration. `spfn build` and `spfn dev` regenerate, so what ships is right; a bare
      `next build` against a stale committed map is not, which is why the header names the
      mounts and their route counts — an upgrade then reads as an upgrade in the diff.
    - `@spfn/core` 0.3.0-beta.14, `spfn` 0.3.0-beta.12. `@spfn/monitor` and `@spfn/cms` raise
      their `@spfn/core` peer floor to `>=0.3.0-beta.14 <0.4.0`, because this generator is
      what puts their routes into an app's map: under an older `@spfn/core` their clients
      still resolve nowhere, and an app owning one of their names gets a build refusal
      describing a merge that no longer exists.

#### spfn (CLI)

- **Behaviour change: an env entry without `layer` may come from any layer** (#124). An unset
  `layer` was read as `environment`, so a value a package declares without one (each
  instance's own session secret) could not come from an instance secrets file or a `--with`
  file. `spfn` 0.3.0-beta.14.

- **Behaviour change: `spfn codegen run` exits 1 when a generator refuses** (#97), and stops at
  the generator that refused. It used to log the failure, print `✓ Code generation completed`
  and exit 0, leaving the stale output on disk — so a developer who added a route, ran
  `spfn codegen run` and saw a green check shipped a map that did not name it, and a script
  that gates on the exit code saw nothing. `spfn build` already failed this way; `spfn dev`
  still logs and keeps watching.


### Added

#### @spfn/i18n

- **A translator over qualified keys** (#145): `useT()` and `getT(locale)` take the namespace
  from the key. `i18n` 0.2.0-beta.8.
- **`negotiateLocale` and `localeCookie`** in `@spfn/i18n/next` (#226) pick the locale for an
  app behind sign-in, with no locale in the URL. `i18n` 0.2.0-beta.6.

#### @spfn/notification

- **Native push over FCM** (#232): `sendPush` reaches Android, iOS and web, to every device
  of a user or a chosen few (`notification` 0.2.0-beta.10). A malformed token is retired with
  the reason `invalid_token` (0.2.0-beta.11).
- **An SES configuration set named once** (#132) — `SPFN_NOTIFICATION_SES_CONFIGURATION_SET`
  or `configurationSetName` — reaches every email send. `notification` 0.2.0-beta.12.
- **Localised templates** (#231): a template carries content per locale and a send picks one
  with `locale`. `notification` 0.2.0-beta.9.
- **Send guards** (#230): a scheduled send names a guard the job asks at send time whether the
  send still applies. `notification` 0.2.0-beta.8.
- **Idempotency keys** (#229): a retried send with the same key, channel and recipient
  returns the first result without calling the provider. `notification` 0.2.0-beta.7.
- `./config` exports its schema as `envSchema`, so `spfn env` lists the package's variables
  (#119). `notification` 0.2.0-beta.11.

#### @spfn/core

- **`tenancy.table(..., { visibleTo })` and `tenantList(..., { visibleThrough })`: a second key
  per person, and a tenant list its members may read** (#162, #306). `visibleTo` names a declared
  integer column (not `id`, not the tenant property) as the table's user key; the table gets an
  index on it and four per-command policies in place of `_tenant_isolation`, so a row is visible
  through its tenant or through its person. `tenantList(..., { visibleThrough: { table, where? } })`
  puts the same four policies on the tenant list, reading the membership's tenant and user
  columns from its markers, and refuses a target that is not a tenancy table, belongs to another
  list, or has no `visibleTo`. `runInTransaction({ user })` binds `app.user_id` the way `tenant`
  binds `app.tenant_id` (one binding state, a nested mismatch throws `TenantMismatchError` with
  `key: 'user'`), `TenantRepository._selectOfUser(userId, fields?)` reads by person (rules
  U1–U5), a guarded request binds its tenant on the root transaction right after `BEGIN`, and the
  development query warning counts a condition on either key. A table without `visibleTo` keeps
  its SQL byte for byte. `core` 0.3.0-beta.37.
- **Behaviour change: the route-map generator refuses a router whose route set depends on the
  environment, found by loading it again with the keys it read varied** (#102, #304). While the
  router loads, `process.env` is a proxy recording reads that reach a project file; when any were
  made, the router is loaded again with those keys varied together (`NODE_ENV` development ↔
  production, set → deleted, unset → `'true'`), then up to four keys alone when the route set
  differs or the load fails — at most six loads. A route set that changes is refused with
  `ConditionalRegistrationError` naming each gating key, where it was read, and the routes it
  adds, drops or moves; only `NODE_ENV`'s values are printed, any other key may be a secret.
  `process.env` is the real object again afterwards. The source scan still runs first and still
  names an inline conditional by its line. A router that passed the scan with
  `process.env.X ? { admin } : {}` was accepted and is now refused: register the route
  unconditionally and gate its behaviour in the handler. The contract and states generators keep
  the source scan only. `core` 0.3.0-beta.37.
- **`defineTenancy({ property })` and `tenancy.reference(..., { onDelete })`** (#159, #160, #302).
  `property` (default `tenantId`) is the key the tenant column has on every tenancy table's
  rows, so an app whose code already reads `row.workspaceId` adopts a tenancy without renaming
  it; `column` still names the SQL column, and the generated SQL does not change.
  `onDelete: 'cascade' | 'restrict' | 'no action'` chooses a reference's delete action, on a
  required or an optional reference; the defaults stay `CASCADE` and `NO ACTION`, and
  `'restrict'` refuses to delete a row another still points at. `SET NULL` and `SET DEFAULT`
  are not offered, because the tenant column is part of the same foreign key; any other value
  throws when the schema module loads. `core` 0.3.0-beta.36.
    - **Migration**: none. Changing an existing reference's `onDelete` makes `spfn db generate`
      drop and re-create that foreign key.
- **`defineTenancy`: tenant tables the database itself keeps apart** (#158 part 2, #296).
  `defineTenancy({ tenants, authorize, column? })` names the tenant list table (a workspace
  table, or `users` from `@spfn/auth/server` when the tenant is a person) and who may act for a
  tenant. `tenancy.table(schema, name, columns, extra?)` adds the `tenant_id` column, a foreign
  key to the tenant list, `unique (tenant_id, id)` and the row-level security policy
  `<table>_tenant_isolation`, which `spfn db generate` emits with `ENABLE ROW LEVEL SECURITY`.
  `tenancy.reference(name, () => table, { optional? })` is a composite foreign key
  `(tenant_id, x_id) → (tenant_id, id)`, so a row cannot point into another tenant (`ON DELETE
  CASCADE` when required, `NO ACTION` when optional). `tenancy.guard({ param } | { resolve })`
  answers 400 for a malformed id and 403 when `authorize` refuses, and binds the request;
  `tenancy.of(c)` returns its tenant. `TenantRepository` sets `app.tenant_id` for every call on
  such a table (rules R1–R6), `runInTransaction(fn, { tenant })` binds a transaction, and a call
  naming another tenant than its transaction or its guard throws `TenantMismatchError` before
  any SQL. `core` 0.3.0-beta.35, `spfn` 0.3.0-beta.21.
    - **`DATABASE_OWNER_URL`**: PostgreSQL skips row-level security for a table's owner, so the
      app must connect as a role that owns nothing. `spfn db migrate`, `backup`, `restore` and
      `drop` connect with this URL, falling back to `DATABASE_URL`; `spfn add` and `db push`
      keep `DATABASE_URL`. `spfn` 0.3.0-beta.21 raises its `@spfn/core` peer floor to
      0.3.0-beta.35: an older core does not know `DATABASE_OWNER_URL`, and the commands would
      fall back to `DATABASE_URL` without saying so.
    - **Behaviour change**: with tenancy tables declared, the server checks its write and read
      connections' role at boot. A role that owns a tenancy table, or is a superuser or
      `BYPASSRLS`, refuses a production boot (`TenancyRoleError`) and logs one warning
      elsewhere. An app without tenancy tables sends no query.
    - **Migration**: none for an app that does not call `defineTenancy`. An app adopting it
      creates an owner role, sets `DATABASE_OWNER_URL`, grants the app role its row privileges
      and moves table ownership off it — see "Tenancy → Database roles" in the db README and
      the new [multi-tenancy guide](./docs/guides/multi-tenancy.md).
- **`tenantKey()` and `TenantRepository`: every query a repository builds stays in one tenant**
  (#158 part 1, #292). `tenantKey()` declares a table's `tenant_id bigint not null` column;
  `TenantRepository` has `BaseRepository`'s protected methods with the tenant id first, writing
  the tenant into WHERE, into each joined tenant table's ON clause in `_select`, and into the
  rows `_create` / `_createMany` / `_upsert` write (an upsert target must include the tenant
  column). `_count` on both repositories takes `{ cap }`. In local
  and development runs the connection warns once per SQL text about a query on a tenant table
  without a tenant condition. `core` 0.3.0-beta.34. The pattern page and the AGENTS.md block
  `spfn dev` writes point at `TenantRepository` for such tables (#293, `spfn` 0.3.0-beta.20).
- **A server-owned state, declared once** (#134). `defineState` / `defineStateRouter` in
  `@spfn/core/state` derive a state's read, write and snapshot routes and its SSE event; the
  app emits `state.changed` after a commit. `@spfn/core/state/client` (`createStateClient`)
  and `@spfn/core/state/react` (`useServerState`) keep a browser in sync. `core`
  0.3.0-beta.25 and 0.3.0-beta.26. Since then:
    - the client starts from the server-rendered snapshot, and the stream serves current
      frames on connect, so a page load makes no browser snapshot read (#140, 0.3.0-beta.28);
    - the client exposes its connection status, bounds its snapshot retry, and restarts on
      `retry()`, a new subscribe or `online` (#141, 0.3.0-beta.28);
    - codegen emits the declared state ids and manifest in `src/generated/states.ts`, so a
      browser root can compare them with the snapshot manifest (#144, 0.3.0-beta.29).
- **An SSE event declares who may subscribe** (#135). `.canSubscribe(predicate)` runs once per
  connection, and `.grant(subject)` / `.revoke(subject)` change an open connection.
  `core` 0.3.0-beta.24.
- **`contracts/current.json` describes the contracted SSE events** (#239).
  `defineEvent(...).contract({ since })` and `defineEventRouter(...).contract({ auth,
  streamPath? })` publish names, payload schemas, stream and token paths and the auth mode;
  the compatibility gate refuses a breaking event change. `core` 0.3.0-beta.19.
- **`createApi({ onOutcome })`** (#146): one observer told once how each call that reached
  `fetch` ended. `core` 0.3.0-beta.30.
- **`defineSurface`: a command surface on any namespace** (#127), the same authenticated
  router, manifest and modules `@spfn/core/ops` serves on `/_ops`, which is now built on it.
  An app's own surface command declares `.effect()` and `.summary()` (#128). `core`
  0.3.0-beta.20 and 0.3.0-beta.21.

#### @spfn/auth

- **`configureAuth({ oauthEmailMatch })`: the app decides what a first social sign-in does when
  its email matches an existing account** (#156, #294), on the web callback and native sign-in.
  `'attach'` (or unset) is the behaviour before: a verified email links to the account, an
  unverified one is `UnverifiedEmailLinkError`. `'reject'` refuses before any write with
  `OAuthEmailInUseError` (409, `OAUTH_EMAIL_IN_USE`, web `reason=email_in_use`). `'separate'`
  creates a new account without the email. Mobile contract 0.13.7. `auth` 0.3.0-beta.51.
    - **Migration**: `OAUTH_ERROR_REASONS` gains `email_in_use`; an exhaustive `switch` over the
      reason needs a case for it.
- **Link-only providers, and the app chooses the recent-auth rule on links** (#155, #157,
  #291). `configureAuth({ oauthProviders: { battlenet: { signIn: false } } })` lets a provider
  be linked and unlinked from a signed-in account but never used to sign in: every sign-in
  start is refused with `OAuthProviderLinkOnlyError` (403, `reason=link_only`), and
  `GET /_auth/oauth/providers` lists it under `linkOnly`. The recent-authentication check on
  link and unlink is `oauthProviders[p].recentAuth.{link,unlink}` over
  `oauthLink.recentAuth.{link,unlink}` over `true`, with its window in
  `oauthLink.recentAuthMinutes`; turn it off only for a link-only provider. With nothing set,
  nothing changes. Mobile contract 0.13.6. `auth` 0.3.0-beta.50.
    - **Migration**: `OAUTH_ERROR_REASONS` gains `link_only`; an exhaustive `switch` over the
      reason needs a case for it.
- **A built-in Battle.net provider, and linking a provider to the signed-in account** (#154,
  #290). The `battlenet` provider is enabled by `SPFN_AUTH_BATTLENET_CLIENT_ID` and
  `_CLIENT_SECRET` (`SPFN_AUTH_BATTLENET_REGION=cn` for the China host); its user id is the
  account id, never the BattleTag, and it reports no email, so it reaches an existing account
  only through a link. The BattleTag is kept in the new `user_social_accounts.provider_handle`
  and carried as `providerHandle` on `auth.login` / `auth.register`. `POST
  /_auth/oauth/:provider/link` and `/unlink` connect or remove a provider from a signed-in
  account, after MFA step-up and recent authentication; unlink refuses the last way in.
  `oauthLinkInterceptor` handles the proxy side, and `auth.oauth.linked` /
  `auth.oauth.link_removed` announce both. `auth` 0.3.0-beta.49.
    - **Migration**: run `spfn db migrate` for `20261030113538_fresh_blur` (the
      `provider_handle` column).
- **Sign in with Apple on the web and Android** (#142). The `apple` provider completes the
  OAuth code flow and the `form_post` callback is accepted (`auth` 0.3.0-beta.41). On Android
  the callback relays the token to an App Link listed in `SPFN_AUTH_APPLE_RELAY_URLS` (#149,
  0.3.0-beta.44).
- **A web browser can be the new device of a device link** (#143): `/web` routes take the
  proxy's key, and the approved poll seals the session. `auth` 0.3.0-beta.42.
- **`createAuthApi(config)`** (#148) builds the auth client with the app's own `createApi`
  configuration (`onOutcome`, `onRequest`, `onResponse`, `timeout`, …); `authApi` is
  `createAuthApi()`. `auth`
  0.3.0-beta.43.
- **The mobile contract declares `OauthNativeRequest.profile`**, and a provider's name is kept
  on first link (#150). `auth` 0.3.0-beta.45.
- **`signedTokenAuth`** (#127): the machine credential for a command surface whose caller
  holds a short-lived EdDSA JWT another service signed and publishes keys for as a JWKS.
  `auth` 0.3.0-beta.36.
- **`SPFN_AUTH_GUARD_TIMEOUT`** (#237) bounds the session lookup behind `RequireAuth`,
  `RequireRole`, `RequirePermission` and the server helpers, which waited the client-wide
  120 s before. Unset, nothing changes. `auth` 0.3.0-beta.34.

- **Roles can be restricted to email domains** (#106). `SPFN_AUTH_ROLE_EMAIL_DOMAINS`
  (`admin=example.com;support=example.com,partner.example`) lets a listed role be held only by an
  account with a verified email under one of its domains — exact, IDNA-normalised match. Unset,
  nothing changes. `@spfn/auth` 0.3.0-beta.28.
    - **Removed**: `fetchUserRoleAndPermissions`, the `usersRepository` method that was public through
      `@spfn/auth/server`. It read the stored role and its permissions; the role a request holds now
      depends on the policy. Use `getAuthSessionService(userId)` (exported) for the resolved role and
      permissions, or `usersRepository.fetchActiveRolePermissions(roleId)` (exported) when you already
      hold the role.
    - **Grant**: the admin role route, `updateUserService`, invitation create and accept refuse
      with `403 RoleEmailDomainNotAllowedError` (`details.reason`: `domain`, `unverified`,
      `no_email`).
    - **Check**: every role and permission resolution goes through `findUserWithEffectiveRole`;
      an account outside the policy resolves as `user` without its row being written, so a
      config revert restores the role. A target's protection still reads the stored role
      (`getStoredUserRole`).
    - **Boot** refuses a malformed value, a restriction on `user`, an unknown role, a
      `superadmin` restriction no stored superadmin satisfies, and a seeded admin account
      outside the policy.
    - `listRoleEmailDomainViolations()` and `demoteRoleEmailDomainViolations()` report and
      remediate. Ops tokens minted before an account fell out of policy are not revoked.

- **An OAuth 2.1 authorization server, so Claude Code and Codex can connect to an app's `/mcp`
  endpoint as the signed-in user** (#93). Dynamic client registration, PKCE and a consent
  screen: the CLI discovers, registers itself, opens a browser and catches the redirect on a
  loopback port, and nobody pastes a token. `@spfn/auth` 0.3.0-beta.19 and 0.3.0-beta.20.
    - Opt in by naming the scopes — there is no default, because the names are the
      application's own vocabulary: `createAuthLifecycle({ authorizationServer: { scopes,
      defaultScopes?, issuer?, authorizeUrl?, allowedRedirectOrigins?, accessTokenTtlMs?,
      refreshTokenTtlMs?, codeTtlMs? } })`. Without that block every endpoint below answers
      404 and the boot check does not run, so an app that wants none of this changes nothing.
    - New routes: `GET /.well-known/oauth-authorization-server` (RFC 8414),
      `POST /_auth/oauth2/register` (RFC 7591, public clients only, IP rate limited),
      `GET`/`POST /_auth/oauth2/authorize`, `POST /_auth/oauth2/token`,
      `POST /_auth/oauth2/revoke` (RFC 7009), `GET /_auth/oauth2/grants` and
      `DELETE /_auth/oauth2/grants/:id`.
    - The consent screen is one route file on the web app, at the path published as
      `authorization_endpoint` (default `{app url}/oauth/authorize`):
      `export const { GET, POST } = createOAuth2AuthorizeHandlers({ loginPath: '/login' })`
      from `@spfn/auth/nextjs/server`. `render` replaces the body; the handler keeps the
      status, the headers, the hidden fields and the form's own CSRF token.
    - `verifyAccessToken(token, resource)` — exported from `@spfn/auth/server` — is what you
      hand `@spfn/mcp`'s `validateToken`. It answers `{ clientId, scopes, expiresAt, userId }`
      or `null`, and an access token issued here is **not** a session: ordinary API routes do
      not accept it.
    - PKCE `S256` only, `resource` (RFC 8707) required and the token good against it alone,
      refresh tokens rotate and a replayed one revokes the grant, every code and refresh
      failure is one `invalid_grant`, and token-endpoint errors are RFC 6749 §5.2 rather than
      the SPFN error envelope. `revoke-all`, a password change, a completed password reset
      and a deletion request each revoke every grant the account has.
    - New sweep `auth.oauth2.client-purge` (daily 05:00, in `authJobRouter`) deletes
      unapproved client rows older than a day. The issuer is checked at boot — absolute, no
      path, `https` (or `http` on loopback for development) — naming `SPFN_API_URL` or
      `authorizationServer.issuer`, whichever it came from.
    - End-to-end, including both CLIs: [docs/guides/mcp-clients.md](docs/guides/mcp-clients.md).
- **A device-registered event and a signed sign-out-everywhere link** (#94), so an account
  owner can be told a device was added and act on it without a session.
  `@spfn/auth` 0.3.0-beta.21 and 0.3.0-beta.22.
    - `authDeviceRegisteredEvent` (`auth.device.registered`) fires after commit on every
      channel that registers a device key — `channel` is `register`, `signup-link`,
      `invitation`, `password`, `oauth`, `oauth-native`, `device-code`, `password-reset` or
      `passkey`. It carries `userId`, `keyId`, `algorithm`, a 12-character
      `fingerprintPrefix`, `createdAtMillis`, `mfaEnrolled`, and whatever the registration
      knew about the device (`deviceName?`, `platform?`, `ip?`, `userAgent?`). A login event
      says a session began and not what it began on, so a stolen password used on a new
      machine used to be silent. Key **rotation** is deliberately not announced.
      Payload type `AuthDeviceRegisteredPayload`.
    - `createRevokeAllLink(userId, { ttlMinutes? })` from `@spfn/auth/server` mints a
      one-time link your app mails to the address the account already proved; opening it
      signs every device out with no session at all. The returned `url` carries the plaintext
      token — hand it to the mail template and do not log, persist or queue it.
    - It opens a page in your app, not an API route. Mount the one that ships with the
      package: `export const { GET, POST } = createRevokeAllPageHandlers()` from
      `@spfn/auth/nextjs/server`. `GET` draws the expiry, the device count and one button;
      `POST` reports how many devices it signed out. Both mint and check a path-scoped CSRF
      cookie of their own, because there is no session here to derive one from.
    - New public routes `POST /_auth/keys/revoke-all/confirm` and
      `POST /_auth/keys/revoke-all/consume` — the token travels in the body, never in a path
      segment, every refusal is the same 404, and both share one 10/minute rate-limit counter.
      Neither is a mobile-contract operation.
    - New settings: `SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES` (default `30`) and
      `SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH` (default `/account/revoke-all`). New sweep
      `auth.revoke-all-token-purge` (daily 06:00) in `authJobRouter`.
    - `listKeys` rows gain `registeredIp` and `registeredUserAgent`, captured once from the
      request that registered the key and never updated — unauthenticated display material,
      so render them and decide nothing by them. Mobile contract **0.11.0**.
- **A second factor: TOTP, a passkey marked as the second factor, and ten recovery codes**
  (#95). Optional in the strong sense — an account that never enrols meets exactly the
  behaviour it met before, on every route. `@spfn/auth` 0.3.0-beta.23 and 0.3.0-beta.25.
    - New routes `POST /_auth/mfa/totp/enroll`, `totp/confirm`, `disable`, `passkey/mark`,
      `recovery/regenerate`, `step-up`, `step-up/options`, `GET /_auth/mfa/status`, and the
      two public ones a sign-in finishes on, `POST /_auth/mfa/verify` and `verify/options`.
    - **`SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` is now required by any app offering a second
      factor, including one with no social login at all** — it is the keyring a TOTP secret
      is encrypted with at rest. Unset, `totp/enroll` answers a 500 configuration error
      rather than the 401 a wrong code gets.
    - For an **enrolled** account, four kinds of change ask for the second factor again on
      the calling device within `SPFN_AUTH_MFA_STEP_UP_MINUTES` (default 10): the password,
      `keys/revoke-all`, the second factor itself, and the account's passkeys. Otherwise the
      answer is **403 `STEP_UP_REQUIRED`** — 403 and not 401, so a web client asks for a code
      instead of reading it as a dead session. `assertStepUp({ userId, keyId })` is exported
      from `@spfn/auth/server` for an application's own sensitive routes.
    - Recovery codes are ten, `xxxxx-xxxxx`, shown once at confirmation and once at each
      regeneration, stored as password hashes rather than unsalted digests, and
      `recovery/regenerate` retires every earlier one. `status` reports how many are left.
    - New settings: `SPFN_AUTH_MFA_ISSUER`, `SPFN_AUTH_MFA_STEP_UP_MINUTES` (`10`),
      `SPFN_AUTH_MFA_CHALLENGE_TTL_MINUTES` (`10`) and `SPFN_AUTH_MFA_CONFIRM_PATH`
      (`/auth/mfa`). New sweep `auth.mfa.sweep` (daily 07:00) in `authJobRouter`, which
      deletes unconfirmed enrolments after 24 hours and the inactive keys expired challenges
      were holding.
    - From a browser: `completeMfaWithCode`, `completeMfaWithRecoveryCode` and
      `completeMfaWithPasskey` from `@spfn/auth/client` finish the whole second half.
      `authLoginEvent` and `authDeviceRegisteredEvent` carry `mfaEnrolled`, which is the hook
      for offering enrolment; the package itself never blocks an account that has none.
    - Mobile contract **0.13.0** carries the `auth.mfa.*` family; the enrolment routes are not
      contract operations.
- **Opt-in session binding, so a copied session cookie stops working** (#97). A web session's
  signing key is sealed inside the cookie, which makes a copy of the cookie that device —
  binding puts that session on a key that expires in hours and that only a fresh WebAuthn
  assertion can replace. `@spfn/auth` 0.3.0-beta.24.
    - `authApi.setSessionBinding.call({ body: { mode: 'passkey' } })` turns it on and
      `getSessionBinding` reports `{ mode, keyExpiresAtMillis? }`; turning it **off** needs a
      fresh credential, so `disableSessionBinding(api)` from `@spfn/auth/client` runs the
      passkey ceremony or takes `{ currentPassword }`. New routes
      `POST`/`GET /_auth/session/binding`, `POST /_auth/session/binding/disable/options`,
      `POST /_auth/session/renew/options` and `POST /_auth/session/renew/verify`.
    - **It needs a deployment where `proxy-guard` tags the request `clientType: 'web'`** —
      that is the only signal the backend has that a request came through the proxy holding
      the session cookie. Without it, `setSessionBinding` answers 400
      `SessionBindingUnavailableError` rather than turning on a switch that protects nothing.
    - New settings: `SPFN_AUTH_BOUND_KEY_TTL_HOURS` (default `24`),
      `SPFN_AUTH_BOUND_KEY_RENEW_GRACE_HOURS` (default `168`, i.e. seven days past expiry a
      bound key may still be renewed), `SPFN_AUTH_CONCURRENT_USE_WINDOW_MS` (default
      `300000`) and `SPFN_AUTH_SESSION_RENEW_PATH` in `.env.local` (default `/auth/renew`).
    - Once the key runs out the proxy answers 401 `SessionRenewalRequiredError` and **keeps
      the cookies**: a client component calls `renewSession(api)` and the session continues.
      `RequireAuth` takes `renewalPath` and sends a server-rendered page there instead of to
      sign-in, because a server component cannot run a WebAuthn ceremony, and
      `getAuthSessionData()` answers a third state, `'renewal-required'`, for a hand-written
      guard.
    - A bound session presented from a different browser family is refused 401
      `SessionContextChangedError` and its cookies are cleared. The comparison is five
      families (`edge` / `chrome` / `firefox` / `safari` / `other`) with no desktop/mobile
      axis, so a version bump, a user-agent reduction and "Request desktop site" are all the
      same browser; a request with no `user-agent` is no signal rather than a mismatch.
    - `listKeys` rows gain `binding` and `concurrentUseAtMillis` — the last time one key was
      seen from two attested addresses inside the concurrent-use window. A signal to show and
      notify on, never a refusal, and the addresses themselves are never returned.
      Mobile contract **0.12.0**; every new field is optional and absent for an account that
      did not opt in.
- **`useMfaConfirm()`**, a headless hook for the second-factor confirm page, from
  `@spfn/auth/nextjs/client` (#107): it reads `?challenge=` and `?returnUrl=`, wraps the three
  `completeMfaWith*` helpers, reports one `state` (`idle | submitting | wrong | expired |
  failed`) and leaves for the return path on success; the app renders the page.

#### @spfn/storage

- **Prefix snapshots over object versions, for a pipeline that overwrites its own outputs**
  (#96). `snapshotPrefix(storage, prefix, { concurrency?, maxKeys? })` records which version
  of every object under a prefix was live at one moment, and
  `restoreManifest(storage, manifest, { onto?, concurrency? })` puts those versions back;
  `serializeManifest` / `parseManifest` are the JSON round trip, and storing the manifest is
  the application's job. `@spfn/storage` 0.3.0-beta.2.
    - `stat(key)` now answers `{ key, size, lastModified?, etag?, contentHash?, versionId? }`
      and `copy(from, to, { sourceVersionId? })` takes the version to copy — without the
      option it is exactly the old behaviour.
    - Restore does not stop at the first failure: every entry lands in `restored`, in
      `skipped` with a reason (`already-current`, `no-version`, `version-missing`) or in
      `failed`. A **missing** target key is not a failure — that is the case restore exists
      for. Everything checkable runs before the first copy: a manifest from another provider,
      an `onto` crossing the `public/` boundary, and every target key through the usual key
      validation.
    - **The bucket decides how far back you can go.** A manifest names versions and cannot
      protect them; S3 lifecycle and GCS Object Versioning retention are what keep them
      alive. Restore writes a **new** version of each object it touches and purges no CDN
      cache. Neither operation is atomic, and a manifest grows with the object count — split
      a very large prefix.
    - **GCS through the S3 interoperability endpoint cannot snapshot versions at all**: the
      AWS SDK reads `x-amz-version-id` and interop returns `x-goog-generation`, so every
      entry restores as `no-version`. Use the native GCS provider where versioned snapshots
      matter.
- `getDownloadUrl(key, options)` signs the response's `Content-Disposition` and
  `Content-Type` into the URL (#211) — the download side of a content-addressed layout,
  where the object has no file name of its own and the name to save it under is known only
  per download. Both values are part of the signature on S3-compatible providers and on GCS,
  so a client cannot edit the query to change them; the local provider appends them as query
  parameters and the app's own file route decides whether to honour them. The positional form
  `getDownloadUrl(key, 900)` still means `expiresIn`. `@spfn/storage` 0.3.0-beta.3.

#### @spfn/mcp

- **The RFC 9728 protected resource metadata document**, served unauthenticated at
  `GET /.well-known/oauth-protected-resource` and at the path-aware form whose suffix is the
  resolved `resource` path (`/.well-known/oauth-protected-resource/mcp`) (#93). It publishes
  `resource`, `authorization_servers`, `scopes_supported` and `bearer_methods_supported`;
  `authorizationServers` defaults to the origin of `appUrl`, `scopesSupported` is the list a
  client picks its `scope` from, and `resourceMetadataUrl` overrides the published URL for a
  deployment served under a base path. `@spfn/mcp` 0.3.0-beta.3.
- A rejected bearer token now gets `WWW-Authenticate: Bearer error="invalid_token",
  resource_metadata="…"` (RFC 6750 §3) where a request with **no** token gets the plain
  challenge (#93). That parameter is what lets a client tell the two apart: refresh the token
  it holds, or go and authorize for one.

#### @spfn/signing

- **0.1.0-alpha.2** (#118): RS256 verification, JWK Set input (`parseJwks`), `audience`,
  `issuer` and `issuedWithinSec` options with their own refusal reasons, and a purpose
  registry (`definePurposes`, `purposeVerifier`) that keeps each token kind's keys and
  audience apart. The package README's changelog has the detail.

- New package: one `Signer` interface with three key providers behind it — `local` (key
  material from an environment variable, a file or a `KeyObject`), `gcp-kms` and `aws-kms`.
  `sign()` returns a promise on every provider, including `local`, so moving a key into a
  KMS is a configuration change rather than a rewrite.
- EdDSA (Ed25519) is the default and ES256 (ECDSA P-256) is the alternative. Every provider
  signs both: `local` through `node:crypto`, `gcp-kms` through `EC_SIGN_ED25519` and
  `EC_SIGN_P256_SHA256`, `aws-kms` through `ECC_NIST_EDWARDS25519` and `ECC_NIST_P256`. On
  both KMS providers the key's spec decides the algorithm and a passed `alg` that disagrees
  is an error at construction. ES256 signatures are JOSE `r || s` on every provider, never
  DER; an Ed25519 signature is already those 64 bytes.
- AWS KMS is called with `MessageType: RAW` for both algorithms, which caps a signing input
  at 4 KiB. `ED25519_SHA_512` is PureEdDSA and signs the message itself; the pre-hashed
  `ED25519_PH_SHA_512` is a different algorithm and is not used.
- `@spfn/signing/verify` is a verify-only entry point that depends on `node:crypto` and
  nothing else, for token checks that run somewhere the issuer's dependencies cannot. It
  never throws on token input: `verifyJws()` answers `{ ok: false, reason }` with
  `malformed`, `invalid-claims`, `unknown-kid`, `alg-mismatch`, `bad-signature`, `expired`,
  `not-yet-valid`, `too-old` or `no-expiry`. `maxAgeSec` bounds how long a token is
  *accepted*, not only the life it granted itself: it needs both `exp` and `iat` (a token
  that omits either is `no-expiry` rather than exempt), it refuses an `iat` in the future as
  `not-yet-valid`, and it caps `exp - iat`. A time claim that is present but is not a finite
  number, and an `iat` after its own `exp`, are `invalid-claims` rather than `malformed` —
  a signature-valid token with a broken claim is the issuer's bug, and telling that apart
  from three bytes of garbage is the point of the reason code.
- The `kid` in the protected header selects the key, and that key's algorithm is the
  algorithm; the header's `alg` is only ever checked for equality against it. `alg: "none"`
  is an `alg-mismatch`, not a decision.
- `KeyRing` holds up to N keys (default 2) with one current, and `rotate()` walks
  add → switch → wait → remove in that order. It refuses to remove the current key, which
  is the step that would strand tokens still in flight, and both `keys` and `publicKeys()`
  hand out a copy so that no caller can delete its way past that refusal.
- Public keys travel as `kid:base64url(key)`, comma-separated — raw Ed25519, a SEC1
  uncompressed P-256 point, or SPKI DER. base64url is validated strictly *and* canonically:
  every segment is decoded, re-encoded and compared, so the sixteen strings that share one
  signature's bytes are not sixteen tokens.
- `contracts/signing/vectors.json` records six tokens with their expected verdicts, and a
  test regenerates them on every run.

#### spfn (CLI)

- **`spfn db tenant export <tenantId>` and `spfn db tenant import <dir> [--replace]`** (#158
  part 3, #298) move one tenant's rows of every tenant table — `tenancy.table` and
  `tenantKey()` tables alike, not the tenant list row, not auth data — out to
  `backups/tenant-<id>-<time>/` (a `manifest.json` and one `COPY` file per table) and back in.
  The export reads one snapshot as the app (`DATABASE_READ_URL`, else `DATABASE_URL`). The
  import checks the files' sha256 and the target's columns, then writes in one transaction as
  the owner (`DATABASE_OWNER_URL`, else `DATABASE_URL`): it refuses, writing nothing, when the
  tenant is missing from its tenant list, already has rows (unless `--replace`), or a row
  belongs to another tenant, and moves sequences forward only. Restoring a copy of the database
  to an earlier point, exporting the tenant from it and importing with `--replace` puts that
  one tenant back in time. `spfn` 0.3.0-beta.21.
- **One whole-app env list** (#119): `spfn env` and `spfn secret` read the app's schema
  modules named in `spfn.config.js` `env.schemas`, then every installed `@spfn/*` package's
  `envSchema`. A key declared differently by two sources is an error. `spfn` 0.3.0-beta.13.
- **`spfn secret export`** (#120) merges an environment file, an optional instance file and
  plaintext `--with` files into one dotenv file created 0600; `--instance` on the other
  `secret` subcommands; `secret set --stdin`. `spfn` 0.3.0-beta.13.
- **`spfn env audit`** (#121) reports direct `process.env` reads outside the schema modules and
  declared names nothing reads. `spfn` 0.3.0-beta.13.
- **`spfn/surface`** (#127): `createSurfaceClient`, the client `spfn ops` runs on, as a
  library export for any namespace a `defineSurface` serves. `spfn ops` shows the effect and
  summary an app command declares (#128). `spfn` 0.3.0-beta.15 and 0.3.0-beta.16.

- `spfn kit` — the generic installer for licensed Superfunction Kits: `install`, `restore`,
  `status`, `check`, `plan`, `update`, `resume` and `abandon`. It hard-codes no product;
  which Kit, which packages and which files are managed all come from the signed setup
  descriptor and release manifest, and product-specific judgement comes from the tooling the
  CLI discovers among the packages the manifest installs.
- A license key can only arrive through a masked prompt or `--license-key-stdin` — no option
  takes one as an argument. The local credential lives in the OS keychain under its own
  service (`superfunction.spfn.kit`), and the short-lived registry session reaches the
  package manager only through the child process environment.
- Every subcommand supports `--json`, prints newline-delimited events with a stable machine
  code and a safe next command, and never prompts in that mode. Exit codes follow the Kit
  contract: `2` waiting for a person, `3` resumable, `4` refused before any write, `5`
  service unavailable, `10` protocol incompatibility.
- Operations are journalled and resumable. A resume re-reads the project and accepts a
  recorded checkpoint only when its evidence still matches; a lock left behind by a dead
  process is reconciled against the journal rather than deleted.
- The Kit control-plane client is not part of this build yet, so `install`, `restore` and
  `update` report `CLI_CONTROL_PLANE_CLIENT_ABSENT` until it ships.

### Fixed

#### examples

- The example migration folders use the drizzle-kit 1.0 journal layout, so `spfn db migrate`
  applies them again (#261).

#### @spfn/auth

- **`next/navigation` stays a bare import**, so a route handler builds under Turbopack (#151).
  `auth` 0.3.0-beta.46, `pages-next` 0.1.0-beta.11.
- **Admission reads keys and account status from the write primary** (#133), so a read
  replica neither delays a revocation nor refuses a key registered a moment ago. `auth`
  0.3.0-beta.40.
- **A device link's poll tells a wrong pick apart from a refusal** (#130). `auth`
  0.3.0-beta.39.
- **A callback that finds no cookie at all is refused with `reason=no_cookie`** (#129). `auth`
  0.3.0-beta.38.
- **Every OAuth start keeps its own cookies, and the error redirect names a reason** (#238), so
  a person who opens the sign-in in two tabs can finish both, in either order. `auth` 0.3.0-beta.35.
- **A repeated OAuth finalize keeps the session** (#126): a reload of the callback page after
  the sign-in finished is answered with success and writes no cookie. `auth` 0.3.0-beta.33.

- **The OAuth2 consent POST is CSRF-checked in every mode** (#108). `POST
  /_auth/oauth2/authorize` issues an authorization code on the strength of the session
  alone, and under the default `warn` mode (or `off`) the proxy logged a missing or wrong
  `x-spfn-csrf` header and forwarded the request anyway. The proxy now refuses it with the
  usual `403` and repair cookie whatever `SPFN_AUTH_CSRF` / `configureAuth({ csrf })` says,
  and ignores an `exemptPaths` entry naming it (one warning line per process). No other path
  or mode changes; the readable CSRF cookie was already issued in every mode, so an app on
  `off` whose pages use the api client needs no change.
- **A passkey-bound session renewal answered 200 and left the browser signed out** (#99).
  `POST /_auth/session/renew/verify` matches two registered proxy rules:
  `loginRegisterInterceptor` mints the replacement key pair, and `generalAuthInterceptor`
  authenticates the request by signing it with the key that is expiring. Both wrote to the
  one `metadata` object the proxy shares between a request and its response, and both called
  their key `keyId` — so the id of the *retired* key was the last one written, and the
  response phase sealed the **new** private key around it. The renewal succeeded, the cookie
  it installed named a key that had just been revoked, and the next authenticated request was
  a `401`. The replacement credentials now travel as `newPrivateKey` / `newKeyId` /
  `newAlgorithm`, the names `keyRotationInterceptor` has always used. `@spfn/auth`
  0.3.0-beta.26.
    - Renewal is where it always bites, because that request is *defined* as one a live
      session makes. But the collision was never renewal's alone: every path on the login
      interceptor's list except `login` and `register` is an authenticated path as far as
      `requiresAuth` is concerned, so `passkeys/login/verify`, `password/reset/complete`,
      `signup/password` and `invitations/accept` sealed the wrong key id too whenever the
      browser still had a session cookie in the jar.
    - And the other half of it: `generalAuthInterceptor`'s near-expiry session refresh no
      longer re-seals the **inbound** session on top of a replacement an earlier rule in the
      same chain just installed. Response phases run in registration order, so that re-seal
      was the last write of the session cookie and undid a renewal, a sign-in or a key
      rotation that happened to land in the last day of the cookie's life.
    - Nothing else changes: the renewal protocol, the backend's proof check and its key
      retirement are untouched, and a refused verify still installs no session and clears no
      cookie.
- `OAuthCallback` finishes a social sign-in on an account with a second factor (#107): a
  callback carrying `?mfaChallenge=` is posted to `oauthFinalize` and, on its 202, sent to the
  confirm page (`mfaPath`, default `/auth/mfa`) instead of failing with "Missing required
  parameters".

#### @spfn/monitor · @spfn/cms

- **BREAKING: an app that owns a route named after one of theirs no longer builds** (#101),
  because both packages ship clients that call their own routes by name and those names
  resolved nowhere. `monitorApi` is `createApi<typeof monitorRouter>` and five dashboard
  components call through it (`getStats`, `listErrors`, `getErrorDetail`, `updateErrorStatus`,
  `listLogs`); `@spfn/cms` calls `api.getLabelCache.call(…)` itself. Neither package published
  a route map, so no app's proxy could resolve those names — and where an app happened to own
  a route of the same name, the call silently reached the **app's** route. Both routers go
  back to `defineRouter`, which is what puts their routes into the map of every app that
  mounts them. `@spfn/monitor` 0.2.0-beta.3, `@spfn/cms` 0.3.0-beta.3, both against an
  `@spfn/core` peer floor raised to `>=0.3.0-beta.14 <0.4.0` — that is the release whose
  generator writes these routes, and an older one resolving under them delivers no fix.
    - `defineRouter` restores the collision refusal, so `spfn codegen run` and `spfn build`
      now fail for an app that mounts one of these packages and declares its own route named
      `getStats`, `listLogs`, `listErrors`, `getErrorDetail`, `updateErrorStatus`,
      `listErrorEvents`, `getLabelCache`, `getSectionLabels`, `saveSectionDraft`,
      `publishSection` or `resetSectionDraft`. **Migration**: rename the app route. The
      refusal names both sides. It is a refusal replacing a silent wrong answer — with both
      routes registered and one entry per name, one of the two paths is unreachable while the
      types still describe the app's route.
    - Neither package gains a `.spfnrc.ts`, a generated map or an exported
      `monitorRouteMap`/`cmsRouteMap`: the app's generator is the only producer.
      `@spfn/notification`'s tracking router stays unmapped — email clients open those
      endpoints by URL and no client names them.

#### @spfn/core

- **An app role that cannot read the migrations table is no longer told every migration is
  pending** (#158, #299). The boot migration check looked its bookkeeping tables up in
  `information_schema`, which lists only the tables the current role holds a privilege on. An
  app role without rights on schema `drizzle` — the normal case once the owner role of #296
  owns the tables — saw none, counted every migration as pending and refused to boot with
  `PendingMigrationsError`. The check now finds the tables through `pg_catalog`; a table it
  cannot read logs one warning naming the cause (`permission denied for schema drizzle`) and
  the server starts unchecked. The db README's "Database roles" now grants the app role
  `USAGE` and `SELECT` on `drizzle`, and row privileges on every package schema (`spfn_auth`,
  …). `core` 0.3.0-beta.35.
- **Revoking a device key closes the SSE streams it opened, and the clients stop on 401**
  (#153). `core` 0.3.0-beta.33, `auth` 0.3.0-beta.48.
- **A state client applies every frame its stream carries**, so a later subscribe never gets
  an older value (#152, 0.3.0-beta.32). Earlier state fixes: frames go out after the commit,
  snapshot route options, a typed principal (#136, #137, #138, 0.3.0-beta.27), and a listener
  hears a change rather than a newer `at` (#139, 0.3.0-beta.28).
- **Transaction hooks belong to the savepoint that registered them** (#255), so a rolled-back
  savepoint fires nothing at the root commit. `core` 0.3.0-beta.28.
- **`ErrorRegistry` restores a class by the name its instances carry** (#131). `core`
  0.3.0-beta.23.
- **The Next.js client applies a per-call timeout and honours a caller's abort signal**
  (#125). The route builder gains `.timeout(ms)`; a caller's abort is `ApiError` `'aborted'`,
  status 0. `core` 0.3.0-beta.18.
- **`next/*` imports name their file** (#147), so a package's dist entries load under plain
  Node. `core` 0.3.0-beta.30, `auth` 0.3.0-beta.43, `cms` 0.3.0-beta.5, `i18n`
  0.2.0-beta.9, `pages-next` 0.1.0-beta.10.
- `undici` `^7.29.1` clears two high advisories in the production audit (#123). `core`
  0.3.0-beta.17.

- **BREAKING: a response interceptor could not redirect, and the caller was handed a network
  failure that never happened** (#104). The client ran `onResponse` inside the `try` that wraps
  `fetch`, whose `catch` tells apart only `AbortError` and calls everything else
  `ApiError(message, 0, url, undefined, 'network')`. Next.js implements `redirect()` and
  `notFound()` by throwing an error carrying a `digest`, so the pattern the scaffold's own
  `api-client.ts` suggests — `if (response.status === 401) redirect('/login')` — never
  navigated: the digest was caught and relabelled, and the caller got a transport error for a
  request that completed. That is worse than the interceptor doing nothing, because retry and
  offline handling keyed on `errorType === 'network'` act on it. The response interceptors now
  run **after** the `try`/`catch` rather than inside it, so an interceptor's throw reaches the
  caller unchanged — `redirect()` and `notFound()` navigate, and an interceptor raising a
  domain error of its own raises that error. The `try` still classifies exactly what it exists
  to classify: an aborted request is still `408` / `'timeout'`, a failed fetch is still `0` /
  `'network'`, and a body that is not the JSON its content-type claims is unchanged too.
  Replacing `response` / `body` from an interceptor still takes effect for everything after it,
  error-status handling included, and the global interceptor still runs before the per-call
  one. `@spfn/core` 0.3.0-beta.13.
    - **Migration**: the inversion is that an `onResponse` which throws now raises **its own**
      error at the call site, where beta.12 handed the caller an `ApiError(message, 0, url,
      undefined, 'network')` instead — so a `catch (e) { if (e instanceof ApiError) … }` around
      a call no longer sees it and the error escapes that catch. An interceptor whose throw was
      being absorbed that way must either catch it inside the interceptor and return a
      response, or the call site must widen its handler to the error the interceptor really
      raises; a `redirect()` or `notFound()` thrown from an interceptor needs no handler and
      must not be caught at all.

- **A `paths` target the generator could not read crashed it with a bare `EACCES`** (#103).
  Alias resolution asks whether a wildcard target names a directory holding anything, and
  `statSync(path, { throwIfNoEntry: false })` suppresses only `ENOENT`: a directory the
  process may not read stats fine and then makes `readdirSync` throw, and an unreadable parent
  makes `statSync` throw too. `projectAliases` runs before the `try`/`catch` that turns a load
  failure into a `RouteMapGeneratorError`, so `spfn codegen run` died with
  `EACCES: permission denied, scandir '<dir>'` and nothing naming alias resolution or the
  `paths` entry involved, where every other load failure names the file and the cause. A
  target that cannot be read now counts as unresolvable and the next target in the entry is
  tried — what already happened for a missing one — so `"@/*": ["./dist/*", "./src/*"]`
  resolves through `./src` when `./dist` is unreadable. The guard names `EACCES` and `EPERM`,
  the latter being what Windows and some container runtimes raise for the same directory, and
  lets every other error through. A narrow regression from the empty-directory change in #216.
  `@spfn/core` 0.3.0-beta.13.

- **A route declared inside a nested `defineRouter` could not be named the way the server
  registers it** (#100). `registerRoutes` has always walked into a nested router and
  registered every route inside it under its own flat name, and the two client-side type
  layers each disagreed with that, in opposite directions. `RouterOutput` / `RouterInput`
  unwrapped exactly one level: the nested router stayed a single key holding a `Router`, so
  none of the routes inside it appeared in the allowed name set, and naming the group key
  instead resolved to `never`. `Client` — what `createApi<AppRouter>()` returns — recursed
  into the nested router as a nested *property*, so it asked for `api.group.getThing`, which
  the runtime proxy never built: a property access there returns a call builder, so
  `api.group` was a builder for a route named `group` and `.getThing` on it was `undefined`.
  Nesting was therefore unusable in any app that referenced a route type or called a nested
  route — which is any app built on the generated client. Both layers now take the same flat
  set of route names across the whole tree, whatever depth a route was declared at:
  `RouterOutput<AppRouter, 'getThing'>` and `api.getThing.call(…)` name the route the way
  `registerRoutes` mounts it and the way the RPC proxy resolves it on the wire. A nested route
  yields exactly the type it yields when the same route is declared flat, and a name no branch
  declares is still a compile error, so a typo is caught rather than resolved to `never`.
  Routes mounted with `.packages()` remain deliberately absent from both — call them through
  the package's own client. `@spfn/core` 0.3.0-beta.11.
    - **Migration**: `api.group.getThing` is now a compile error. This is a compile error
      replacing a runtime failure, not a silent fix: that call could never have worked, since
      the proxy sends the property name as a whole route name and `/api/rpc/group` matches
      nothing in the route map. Call the route by its own name — `api.getThing` — which is
      what the server has always registered. A flat router's client is unchanged, so an app
      with no nesting has nothing to migrate.
    - **Migration**: a name declared in two places in one tree — two branches, or the same
      sub-router mounted twice — is left out of the namespace rather than resolved to one of
      them, the same collision the contract collector refuses. Naming it is a compile error at
      the line that names it; give the routes distinct names, or mount the sub-router once.
      Nothing that compiles today can be relying on the old silent answer, since a nested name
      resolved to nothing at all before this release.
    - A router whose routes are not known — `Router<any>`, or an unresolved type parameter
      constrained to it — now contributes no names rather than accepting every name. A helper
      written generically over `TRouter extends Router<any>` can no longer name a route
      through `RouterOutput`; take the concrete router type instead. The same applies to the
      client: `createApi<any>()` returns a client with no properties rather than one where
      every property exists. Give `createApi` the generated `AppRouter` type.
    - The RPC proxy itself is unchanged — it already sent one flat route name per property
      access. Only its JSDoc claimed dot notation, and that claim is now removed; there is no
      dotted traversal to add, because the route map the proxy resolves against is flat.
    - The generated route map is the layer underneath, and it dropped the same routes for its
      own reason. It is fixed in this release too — see the next entry — so a nested route
      now types, dispatches, and appears in the map under one name.

- **Four ordinary ways of writing a router dropped routes from the generated route map**
  (#97). `@spfn/core:route-map` read the router file as text: it found the **first**
  `defineRouter(` in the file, brace-matched it, and collected a name only when that name
  started its own line. So `defineRouter({ createUser })` written on one line contributed
  nothing, an aliased key `create: createUser` contributed nothing, and a second
  `defineRouter(` in the same file — which is how a nested router is assembled, as
  `const users = defineRouter({…})` and then `defineRouter({ users })` — was not read at
  all, silently costing the outer router its own routes. The RPC client sends
  `/api/rpc/{routeName}` and the server resolves it against this map, so each dropped name
  was a route that typechecked and answered 404.
    - The generator now **loads the router with jiti and walks it**, the way
      `@spfn/core:contract` already did, and takes `method` and `path` from the `RouteDef`.
      The names it writes are exactly the names `registerRoutes` registers for the same
      router: nesting recurses to any depth and every route lands flat under its own key,
      and `.packages()` routers stay out at every depth, because a package publishes its own
      route map and the app merges the two (`{ ...routeMap, ...authRouteMap }`). How the
      router is spelled stopped mattering.
    - **It refuses instead of dropping.** Two routes reaching the same name, a route with no
      method or path, a `method` that is not an `HttpMethod`, an entry that is neither a route
      nor a router, a module that will not load, and a file with no `appRouter` / `default` /
      `router` export are all errors that name the places involved. A failure is logged on
      every trigger and reaches the exit code of `spfn build` and `spfn codegen run`; there is
      no fallback to the old text parser.
    - **A conditionally registered route is refused**, the way the contract generator already
      refused it: `defineRouter({ a, ...(process.env.ENABLE_ADMIN ? { admin } : {}) })` used to
      emit `a` alone and exit 0, so the flag's value at generation time decided which names the
      client could address — with the flag set in production, `api.admin.call()` 404ed. The
      guard reads **the router the generator was pointed at** — the export its loader found,
      plus the routers that export mounts by name from the same file, since a nested router's
      routes land in the same flat map — with TypeScript's parser, so a second router the app
      router never reaches, a JSDoc spelling `defineRouter({ ... })` in prose and a brace
      inside a string are not scanned. Only a spread that **reads a condition** is refused (a
      ternary, `&&`, `||`, `??`); a call is allowed, because loading yields exactly the routes
      it returns — `...metadataRoutes(config, resource)` is how `@spfn/mcp` composes its
      router. A conditional spread inside an imported module, a router built by a factory, a
      condition hoisted to a variable before the spread and a `.packages()` list assembled
      conditionally are past what it can see; `NODE_ENV` pinning is the defence for those.
    - **An app route that collides with a route from a package publishing a route map is
      refused.** Both register at runtime and the app's proxy merges
      `{ ...routeMap, ...authRouteMap }`, so the *package* wins the name: an app defining its
      own `logout` with `@spfn/auth` mounted got a typed client claiming `api.logout` was its
      route while every call went to `POST /_auth/logout`. Package routes are still never
      emitted, and two packages sharing a name is not refused — the app's merge order decides
      that one. **The ops surface is not checked**: `createOpsRouter` publishes no route map
      for anything to merge and `spfn ops` invokes a command over the URL its manifest gave,
      so an app route named after an ops command overwrites nothing. `Router` carries
      `_publishesRouteMap` to say which is which, and a package that does publish a map is
      checked as before.
    - **A route module must now import without side effects** on `spfn build` and
      `spfn codegen run`, not only under the contract generator. A module-scope read of a
      required environment value, or a connection opened at import, turns a working build
      into a failing one — the error says so and names the file. All three examples load
      with an empty environment and regenerate byte-identical maps.
    - **`compilerOptions.paths` is read from the nearest `tsconfig.json` that declares them**
      — searched from the router file's own directory up to the project root, `extends` chains
      included — and handed to jiti, because jiti resolves a path alias only through its own
      `alias` option. Without this, the `@/*` alias `spfn init` writes into every app — and
      which the scaffold documents as the idiom — could not be resolved while the router
      loaded, so an app with one `@/` import anywhere in its route graph could not generate a
      map at all. The scaffold puts that alias in **`src/server/tsconfig.json`** (with
      `baseUrl: "../.."`, which is honoured), the config `spfn build` itself compiles with, so
      reading only the root config left a backend-only app unable to generate anything. The
      search stops at the project root, and a config declaring no `paths` is passed over
      rather than ending it. An import that still does not resolve now names the specifier
      instead of advising about module-scope side effects. The contract generator gets the
      same resolution. Several targets for one pattern resolve through the first that exists,
      as tsc and tsup resolve them; an `extends` target TypeScript cannot read is warned about
      rather than silently dropping every `paths` entry; a pattern whose `*` is not a trailing
      `/*` is skipped with a warning; and a wildcard is keyed with its trailing slash
      (`@x/*` → `@x/`) so an exact mapping of the same prefix survives beside it.
    - **`NODE_ENV` is pinned to `production` when the shell left it unset**, as the contract
      generator already did, and the pin is now shared by both. It is process-wide, so
      whichever generator ran first used to decide what the other one loaded: the same repo and
      the same command produced two different maps depending on the order `.spfnrc.ts` listed
      them.
    - `additionalRouteDirs` is **deprecated and ignored**. The loaded router reaches every
      route through its own imports, so there are no extra directories to scan. It is still
      accepted, and still contributes its `${dir}/**/*.ts` pattern to `watchPatterns`, so an
      existing `.spfnrc.ts` keeps working unchanged.
    - A path carrying a line terminator, a quote or a backslash, and a route named `__proto__`,
      are now emitted so the generated file parses and the map keeps every route as an own
      property. A path outside plain ASCII is emitted double-quoted (`JSON.stringify`); every
      realistic path is written exactly as before, and the repo's committed maps regenerate
      byte-identically apart from the reordering below.
    - `packages/auth`'s committed route map is regenerated on this change: same 89 routes, now
      in the order `defineRouter({…})` declares them, which is the order `registerRoutes`
      registers them in.
    - **TypeScript is loaded when a router is read, not when `@spfn/core/codegen` is
      imported.** The compiler is what reads a tsconfig's `paths` and the router's own source,
      and a top-level import of it cost every consumer of that entry ~0.3s and ~70MB —
      `spfn dev` startup, the watcher child, every `.spfnrc.ts` evaluation and
      `spfn codegen list`, none of which resolve an alias or parse a router.

## [@spfn/core@0.3.0-beta.4, @spfn/auth@0.3.0-beta.4] - 2026-08-10

### Added

#### @spfn/core

- `GET /_core/time` (`core.time`) exposes the server's Unix epoch milliseconds as an
  unauthenticated, session-free, non-cacheable built-in capability. It is registered before
  application middleware and routes, and the strict proxy guard excludes it.

#### @spfn/auth

- Mobile contract 0.9.0 imports `core.time` as the prerequisite for process-first
  `clientProofV1` clock synchronization. A client fails closed when synchronization is
  unavailable; the strict `0..300000ms` proof-age window and nonce-on-admission rule are
  unchanged and exported with their four finite boundary cases.

### Changed

#### @spfn/auth

- The `@spfn/core` peer floor is now `>=0.3.0-beta.4`, the first release containing the
  `CORE_TIME_*` exports loaded by `@spfn/auth/client-proof`. Older core prereleases are no
  longer advertised as compatible.

## [@spfn/core@0.3.0-beta.3, spfn@0.3.0-beta.3, @spfn/auth@0.3.0-beta.3] - 2026-08-09

세 가지 breaking change 가 함께 나간다. 배포 전에 아래 두 문서를 먼저 읽는 것이 좋다:

- health 엔드포인트 이전: [`docs/guides/migration/health-endpoint.md`](docs/guides/migration/health-endpoint.md)
- 포트·호스트 3층 정리와 `PORT`·`HOST` 제거: 아래 항목과 [`ENV_VARIABLES.md`](ENV_VARIABLES.md)

가장 눈에 띄는 것은 `@spfn/auth` 의 쿠키 이름 접미사다. `PORT` 를 설정해 두던 앱은 **기존 세션이 전부 끊긴다.** 다시 로그인하면 복구되지만, 배포 시점을 고를 때 알고 있어야 한다.

`spfn` CLI 는 `@spfn/core/app-config` 를 쓰므로 core 하한이 `>=0.3.0-beta.3` 으로 올랐다. 나머지 `@spfn/*` 패키지는 범위(`>=0.3.0-beta.1 <0.4.0`)가 이미 이 버전을 포함해 손대지 않았다.

### Changed

#### @spfn/core

- **BREAKING: 내장 health 엔드포인트가 `/_core/health` 로 옮겨가고, `/health` 는 더 이상 등록되지 않는다.** `/_core/` 는 `@spfn/core` 소유이고 그 안의 경로는 앱 라우트보다 먼저 등록돼 앱이 가져갈 수 없다. readiness probe·Dockerfile `HEALTHCHECK`·업타임 모니터·로드밸런서는 여기를 가리켜야 한다 — 앱이 무엇을 선언하든 답이 바뀌지 않는 유일한 주소다. `/_auth/`·`/_ops/` 와 같은 규칙이고, 그 두 곳에는 가려짐 결함이 한 번도 없었다.
    - **마이그레이션**: [`docs/guides/migration/health-endpoint.md`](docs/guides/migration/health-endpoint.md). probe 경로를 `/_core/health` 로 옮기는 것이 기본이고, 경로를 바꿀 수 없는 배포는 `.healthCheck({ path: '/health' })` 로 옛 주소를 되살린다.
    - `/health` 로 오는 `GET` 은 **한 릴리스 동안 410** 과 새 주소를 답하고, 첫 요청에 서버가 경고를 한 번 남긴다. readiness probe 실패는 운영자에게 응답 본문도 상태 문구도 보여주지 않아서, 404 하나로는 검색할 단서가 남지 않는다. 다음 릴리스에서 제거된다.
    - 앱이 `GET /health` 를 선언했다면 안내는 나가지 않는다. 그 경로는 이제 앱 것이다.
    - `healthCheck.enabled: false` 인 앱은 안내도 받지 않는다. 그 설정에서는 예전에도 `/health` 가 404 였으니 옮겨간 것이 없다.
  - `CORE_NAMESPACE`·`CORE_HEALTH_PATH`·`LEGACY_HEALTH_PATH` 를 `@spfn/core/server` 에서 내보낸다.
  - **`healthCheck.path` 는 이제 명시적 opt-in 이고 기본값이 없다.** 설정하면 `/_core/health` 와 **함께** 답하는 두번째 주소가 열린다. 옮기는 것이 아니다. 예전에는 이 값이 `/health` 로 기본 설정돼 앱이 그 경로에 선언한 라우트를 통째로 삼켰다.
  - **내장 주소는 전부 `lifecycle.beforeRoutes` 훅보다 먼저 등록된다.** Hono 미들웨어는 자기 뒤에 등록된 핸들러만 감싸므로, 앱이 그 훅에서 추가한 전역 인증 가드가 probe 를 막지 못한다. 훅의 문서화된 용도가 바로 `app.use('/*', globalMiddleware())` 다.
  - 설정한 `path` 에 앱 라우트가 겹치면 그 라우트가 실행되지 않는다고 warn 한다. 앱 라우트가 `/_core/` 안에 있을 때도 같다.
  - **프록시 가드가 health 경로 전부를 자동 예외에 넣는다.** 넣지 않으면 strict 모드에서 probe 가 403 을 받는다 — probe 는 RPC 프록시를 지나지 않아 서명이 없다. 파드가 rotation 에 들어가지 못하면서 이유를 아무도 말해주지 않는 실패다. `/health` 안내도 예외에 들어간다. 막히면 운영자가 410 을 읽지 못한다.
  - `RequestLogger` 기본 `excludePaths` 에 `/_core/health` 를 넣었다. 없으면 probe 주기마다 로그 한 줄이 쌓인다.
  - 부팅 배너가 답하는 경로를 함께 보고한다(`healthCheck.corePath`, 설정 시 `healthCheck.path`).
  - 예제 02·03 과 CLI 스캐폴드의 Dockerfile `HEALTHCHECK`, root 응답 안내가 `/_core/health` 를 가리킨다.
#### @spfn/core · spfn (CLI) · @spfn/auth

- **BREAKING: 포트·호스트 설정이 3층으로 정리됐다** — 환경변수 · `spfn.config.js` · 기본값. 그 이상은 없다.

  ```
  SPFN_PORT > spfn.config.js ports.server > 8790
  NEXT_PORT > spfn.config.js ports.next   > 3790
  SPFN_HOST > spfn.config.js host         > localhost
  ```

  기본값은 `@spfn/core/app-config` 한 곳에만 존재한다. 이게 이 형태의 핵심이다. 입력 층(CLI 옵션·생성된 엔트리·env 스키마)에 둔 기본값은 누가 실제로 준 값과 구분되지 않아 아래 층을 조용히 덮는다. 이 저장소에서 그 원인으로 결함 3개가 나왔다.

  - **`PORT`·`HOST` 를 core env 스키마에서 제거.** 기본값 4000·localhost 때문에 `env.PORT` 가 절대 undefined 가 아니었고, 그래서 해석 순서에서 환경변수를 맨 뒤에 둘 수밖에 없었다. 주입된 포트가 닿지 못한 이유가 이것이다. `PORT` 는 Next.js 자신의 변수이기도 하다.
  - **이름이 2개인 이유**: 프로세스가 2개다. `NEXT_PORT` 는 Next.js, `SPFN_PORT` 는 SPFN API 서버.
  - **`spfn.config.js` 를 실제로 읽는다.** `spfn init` 이 만들어 커밋해 왔지만 지금까지 아무도 읽지 않던 파일이다. 두 포트가 한 곳에 나란히 있으므로, 앱이 포트를 바꿀 때 고칠 곳이 한 군데다. 그 전에는 `examples/03-auth` 가 같은 숫자를 7개 파일에 적어두고 손으로 맞췄다.
  - **`ServerConfig.port()`·`.host()` 폐기.** 한 릴리스 동안 `spfn.config.js` 와 기본값 사이에서 계속 동작하고, 부팅 시 경고한다.
  - **`spfn dev --routes` 제거** — `@spfn/core` 가 읽지 않던 죽은 옵션.
  - **`@spfn/auth` 의 쿠키 이름 접미사가 `PORT` 대신 `SPFN_PORT` 를 쓴다.** `PORT` 를 설정해 두던 앱은 쿠키 이름이 바뀌어 **기존 세션이 끊긴다.** 다시 로그인하면 된다.
  - 스캐폴드 `Dockerfile` 의 HEALTHCHECK 와 compose 의 포트 매핑이 `SPFN_PORT`·`NEXT_PORT` 를 따른다. Docker 는 `spfn.config.js` 를 읽지 못하므로 두 파일만 같은 기본값을 예비로 갖는다.
  - **`examples/03-auth` 의 Next 포트 불일치 수정.** `spfn.config.js` 는 `ports.next: 3890` 인데 Dockerfile 은 3790 을 열고 compose 도 3790 을 매핑하고 있었다. `spfn start` 가 이제 선언된 값을 넘기므로, 컨테이너 안에서는 3890 에 뜨고 밖으로 열린 것은 3790 이라 프로덕션 compose 로 띄우면 프론트엔드에 닿을 수 없었다. Docker 가 읽지 못하는 숫자가 어긋나도 부팅은 성공하는 종류의 결함이라, 파일 간 숫자를 직접 비교하는 검사(`app-config/__tests__/deployment-files-agree.test.ts`)로 고정했다. 스캐폴드가 만드는 `spfn.config.js` 도 같은 검사가 덮는다.
  - **`spfn.config.js` 를 불러오지 못하면 경고한다.** 있는데 import 가 실패하는 것은 오타이지 부재가 아니다. 조용히 기본값으로 떨어지면 앱이 지정한 포트 대신 8790 에 뜨고, 증상은 아무도 고르지 않은 포트 하나뿐이다. 부팅은 여전히 막지 않는다.

#### @spfn/core · spfn (CLI)

- **BREAKING: `.env.server.local` 폐지** — 서버 전용 환경변수를 `.env.server` 단일 파일로 통합. `.env.server`는 이제 gitignored(시크릿 포함)이며, committed 템플릿은 `.env.server.example`을 사용. 서버 시크릿을 `.env.server.local`에 두던 프로젝트는 `.env.server`로 이전해야 함(둘 다 gitignored).
  - `@spfn/core`: env loader가 server 레이어에서 `.env.server`만 로드(`.env.server.local` 제거). loader 로딩 규칙 단위 테스트 추가.
  - `spfn` (CLI): `create`/`init`이 `.env.server.local.example`을 생성하지 않고 `.gitignore`에 `.env.server`를 추가. `env:init` 및 런타임 로딩에서도 `.env.server.local` 제거.

### Added

#### 저장소

- **풀 리퀘스트에 기계 검사가 생겼다** (`.woodpecker/pr.yml`) — 그 전에는 하나도 없었다. GitHub 쪽 두 워크플로가 `pull_request` 트리거를 선언하고 있지만, PR 은 Gitea 에 열리고 GitHub 는 미러라 그 트리거는 발화하지 않는다. 실제로 도는 것은 main push 뿐이라 **병합 뒤** 검사다. 이제 PR 에서 `pnpm build` · `lint` · `type-check` · `check:versions` · `check:exports` 와 예제 부팅 스모크가 돈다.
  - **예제가 처음으로 CI 에 들어왔다.** `examples/01·02·03` 에 `type-check` 스크립트가 없어 turbo 가 닿지 못했다. `next build` 는 프론트엔드만 컴파일하고 SPFN 서버는 건드리지 않는다. 그래서 부팅조차 못 하는 예제가 main 에 남아 있었다(issue #119).
  - `scripts/smoke-example-01.mjs` 가 예제 01 을 실제로 띄워 `GET /greeting`·`GET /health` 응답과 가려짐 경고 부재를 확인한다. DB·캐시·시크릿이 필요 없어 모든 PR 에서 돌릴 수 있다. 이 스크립트는 첫 실행에서 프로덕션 설정 로딩 결함을 잡았다.
  - **`pnpm test` 도 게이트에서 돈다.** PostgreSQL 과 Redis 4대를 test 스텝 컨테이너 안에서 `scripts/test-services.sh` 로 띄운다. Woodpecker `services` 를 쓰지 않는 이유는 테스트 쪽에 있다 — 캐시 통합 스위트가 `redis://localhost:6479`~`:6482` 를 env 오버라이드 없이 하드코딩하고 있어, 자기 호스트명을 받는 service 컨테이너로는 닿지 못한다. 전부 localhost 에 두면 CI 가 로컬 스크립트를 그대로 호출할 수 있어 로컬과 CI 가 어긋나지 않는다.
  - 검사는 두 스텝으로 나뉜다. lint 오류가 전체 스위트를 기다리지 않고 1분 안에 보고되게 하려는 것이다. 스텝은 워크스페이스 볼륨을 공유하므로 `verify` 가 만든 `dist/` 는 `test` 에서도 그대로 있다.
- **`pnpm setup:examples`** (`scripts/seed-example-env.mjs`) — 예제마다 커밋된 `.env.local.example` 을 `.env.local` 로 복사한다. 이미 있는 `.env.local` 은 건드리지 않는다.
  - **새로 클론한 저장소는 `pnpm build` 가 실패했다.** 루트 빌드가 예제까지 닿고, 예제의 `next build` 가 페이지 데이터를 수집하면서 환경변수를 검증하는데 거기서 `SPFN_API_URL` 이 필수다. 그 값은 gitignore 대상인 `.env.local` 에만 있었다. 파일 하나가 없어서 `01-minimal-api` 빌드가 깨지고, turbo 가 남은 빌드를 취소하고, `@spfn/auth` 의 `dist/` 가 생기지 않고, auth 테스트 46개 파일 중 34개가 `Cannot find package '@spfn/auth/config'` 로 실패했다. AGENTS.md 가 안내하는 검증 명령이 새 클론에서 돌지 않았다는 뜻이다.

### Fixed

#### 저장소

- **PR 게이트의 파드가 자원을 아무것도 요청하지 않고 있었다** — Woodpecker 는 Kubernetes 백엔드로 돌고, 에이전트 설정에도 `.woodpecker/pr.yml` 에도 스텝 파드의 요청·한도가 없었다. Kubernetes 에서 그것은 BestEffort 등급이다. 경합하면 CPU 를 최소한만 받고, 노드 메모리가 모자라면 가장 먼저 종료된다. 같은 커밋에서 두 증상이 다 나왔다 — 한 번은 website 정적 생성이 페이지마다 60초 제한을 넘겨 실패했고, 다음 실행은 오류 한 줄 없이 빌드 도중 죽었다. 같은 빌드가 노트북에서는 28초다. 느린 코드가 있었던 게 아니라 파드가 아무것도 요구하지 않았다. 두 스텝에 요청 `cpu 2`·`memory 4Gi`, 한도 `cpu 4`·`memory 7Gi` 를 주고 전용 빌드 노드풀(`role: build`, taint 가 있어 toleration 도 함께)로 보낸다. 통과했던 초기 실행들은 노드가 한가했던 것뿐이라 운에 기대고 있었다.

- **예제 01·02 의 `.env.local.example` 이 커밋되지 않고 있었다** — 각 예제의 `.gitignore` 가 `.env*` 를 걸어두고 예외를 주지 않았다(`examples/01-minimal-api/.gitignore:22`, `examples/02-database-crud/.gitignore:37`). 예제 03 만 `!.env.local.example` 예외가 있었다. 그래서 저장소를 클론한 채택자는 두 예제의 env 템플릿을 받지 못했고, "`*.example` env 파일만 커밋된다" 는 규칙이 두 예제에서 지켜지지 않았다. 두 템플릿에는 localhost 자리표시자만 들어 있다.
- **`pnpm type-check` 가 main 에서 에러로 끝났다** — `turbo.json` 에 `type-check` 태스크 선언이 없어 `Could not find task 'type-check' in project` 로 실패했다. AGENTS.md 가 안내하는 명령이다. 선언을 추가했다.

#### @spfn/core

- **DB 없는 서버의 health가 더 이상 503을 답하지 않음** — `.infrastructure({ database: false })`로 끈 구성 요소를 health 상세 응답이 `disabled`로 보고하고 전체 상태를 낮추지 않는다. 그 전에는 의도적으로 없는 DB가 `not_initialized`로 실패에 세어져, DB를 쓰지 않는 서버의 readiness probe가 영영 통과하지 못했다. `redis`도 같다.
  - 응답 문자열이 바뀐다: 껐을 때 `not_initialized` → `disabled`. health 페이로드를 문자열로 판정하는 곳이 있으면 확인 필요.
- **내장 health 경로와 겹치는 앱 라우트를 부팅 시 경고** — 내장 health 엔드포인트는 앱 라우트보다 먼저 등록되므로 같은 경로의 앱 라우트는 실행되지 않는다. 이제 라우트 이름과 경로를 지목해 경고한다. 조용히 가려지는 탓에 examples 01·02·03이 실행되지 않는 `/health` 라우트를 배포하고 있었다(제거함).
- `ServerConfig.infrastructure`의 `@default true if DATABASE_URL exists` 주석이 실제 동작과 달랐다. 자격증명을 살피지 않고 항상 초기화하므로 DB를 쓰지 않는 서버는 `false`를 선언해야 한다(issue #119).
- **프로덕션 서버가 앱의 `server.config`를 실제로 읽는다** — `spfn build`가 만드는 컴파일 결과의 확장자는 tsup이 앱 `package.json`을 보고 정한다. `"type": "module"`이면 `.js`, 아니면 `.mjs`다. 찾는 목록에 `.mjs`만 있어서, 그 필드를 선언한 앱은 프로덕션에서 **설정 전체를 잃었다** — 미들웨어·라우트·인프라 스위치가 모두 사라지고 기본값으로 떴다. 원본 `src/server/server.config.ts`가 마지막 후보로 남아 있었지만 순수 node는 TypeScript도 `@/` 별칭도 해석하지 못해 대신할 수 없었다. 이제 두 확장자를 모두 찾는다.
- **설정을 못 읽었으면 경고한다** — `src/server/server.config.ts`가 있는데 아무 설정도 로드되지 않았다면 warn으로 알린다. 그 전에는 debug 레벨이라 프로덕션에서 보이지 않았고, 서버는 조용히 뜬 뒤 없는 미들웨어·없는 라우트로 동작했다.

#### spfn (CLI)

- **스캐폴드가 만들던 `/health` 라우트 제거** — 내장 health 엔드포인트가 앱 라우트보다 먼저 등록되므로 이 라우트는 처음부터 실행된 적이 없었다. 새 앱은 이제 부팅 시 가려짐 경고 없이 뜨고, `GET /health`는 DB·Redis·마이그레이션 상태까지 담은 내장 응답이 답한다. Dockerfile의 HEALTHCHECK와 root 응답의 `/health` 안내는 그대로 유효하다.
- **프로덕션 엔트리가 앱이 정한 포트를 따른다** — `.spfn/prod-server.mjs`가 포트를 `env.SPFN_PORT`에서 읽었는데 core의 env 스키마에 그 키가 없어 **항상 undefined**였다. 결과적으로 모든 프로덕션 서버가 하드코딩된 8790에 붙었다. `examples/03-auth`는 자기 설정에 8890을 적어두고도 8890을 받은 적이 없다. 이제 `process.env`에서 읽고, 주입된 값이 없으면 앱의 `server.config`가 결정한다. `SPFN_HOST`도 같다.
  - `spfn start`의 `-p`·`-h`에 있던 commander 기본값(`8790`·`0.0.0.0`)도 걷어냈다. 기본값은 운영자가 입력한 값과 구분되지 않은 채 그대로 `SPFN_PORT`로 전달돼, 플래그를 쓰지 않아도 앱 설정을 덮었다. 이제 플래그를 준 경우에만 전달한다. Dockerfile의 `CMD ["pnpm", "run", "spfn:start"]`가 지나는 경로가 바로 여기다.
  - 주소를 알리던 `spfn start`의 로그 두 줄을 걷어냈다. 플래그가 없으면 이 프로세스는 어느 주소에 붙을지 모른다. 실제 주소는 서버가 자기 배너로 알린다.
  - 동작 변화: `server.config`에 `.port()`를 적지 않은 앱은 이제 8790이 아니라 core 기본값을 쓴다. 스캐폴드 템플릿과 모든 예제는 포트를 명시하므로 영향이 없다.
- **`spfn build`가 확장자를 고정한다** — tsup `outExtension`을 `.mjs`로 지정해 앱 `package.json`의 암묵적 규칙에 기대지 않는다.
- 프로덕션 엔트리가 넘기던 `routesPath` 제거 — `@spfn/core`가 읽지 않는 죽은 옵션이라, 엔트리가 라우트를 연결하는 것처럼 보이게 했다. 라우트는 앱의 `server.config`가 등록한다.
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
