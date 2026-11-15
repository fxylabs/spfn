---
title: "Next.js authentication after sign-in: who handles the rest?"
description: Signing a user in is the easy half. This compares building the rest yourself, having an agent write it, wiring Better Auth, and installing @spfn/auth.
order: 2
---

## The question

Every comparison of Next.js authentication libraries answers the same question: how do I
get a user signed in. That question has been settled for years and almost anything on the
list will do it.

The question that decides what your next six months look like is the one after it.
**Who handles everything that follows sign-in?**

Because sign-in is not the feature. The feature is: every API request carries a credential
that means something, a user who asks to leave actually leaves, and someone who is signed
in still cannot do what they are not allowed to do.

**SPFN is ours** — we build it, and `@spfn/auth` is one of the four answers below. The
other three are compared on their own terms, and one of them is better than ours for most
readers.

## Four answers

| Answer | What you pay | What you are left holding |
|---|---|---|
| Build it yourself | design, argument, decision, tests, measurement | all of it, forever |
| Have an agent write it | tokens, and review time | the same decisions, now unasked |
| Wire a library | learning and integration | whatever the library does not cover |
| Install a slice | nothing, then move on | a narrower set of choices |

The second row is the one this page exists to talk about, because it is new and because
it is where the reasoning usually goes wrong.

## What "after sign-in" actually contains

Three things, and none of them is exotic.

**A credential on every request.** Something travels with each API call and the server
decides whether to trust it. That is a design decision with consequences, not a checkbox.

**Account deletion.** Apple and Google both require an app that lets people create an
account to let them delete it from inside the app. Accepting the request and never
processing it is the common failure, and it is worse than not shipping the button —
now there is a promise on the screen and a row in a table that nothing consumes.

**Authorization.** Sign-in answers who someone is. It says nothing about what they may
do, and a product runs on the second answer.

## Answer one: build it yourself

This is the honest baseline and sometimes the right call. You will make a series of
decisions, each small and each with a wrong version:

- Does a stolen session credential let the thief act as the user, and for how long?
- When someone signs in on a second device, does the first one get signed out?
- What happens to a deletion request while the grace period runs — can they still log in?
- Does a purge that runs while the user is cancelling destroy the account anyway?
- Does the audit record of the deletion survive the deletion?

None of these is hard once stated. Stating them is the work.

## Answer two: have an agent write it

This is now the default, and it deserves a straight answer rather than a sneer.

An agent will write you a deletion endpoint. It will be a good deletion endpoint. It will
match what you asked for.

It will not tell you that the app stores require the button, that a grace period is what
turns a deletion into a recoverable mistake, that sessions have to be revoked at request
time rather than at purge time, that a concurrent cancel can race the sweep, or that the
audit row should outlive the user row it points at. **An agent answers the question you
asked. The expensive part was knowing which question to ask.**

The cost here is real but it is not the token bill. It is that you now own a system whose
design decisions were made implicitly, by whoever phrased the prompt, and you will
discover which ones were wrong in production.

## Answer three: wire a library — Better Auth

Better Auth describes itself as a framework-agnostic, universal authentication and
authorization framework for TypeScript, and it is the strongest general answer available.
Email and password, sessions, rate limiting, automatic database handling and migrations,
social providers, organisations and access control, two-factor auth, and a plugin
ecosystem covering passkeys, multi-tenancy, multi-session and enterprise SSO.

If you are choosing an auth library for a Next.js app today, this is the one to choose,
and the rest of this page does not change that.

Two places where it hands work back, both from its own documentation.

**Non-browser clients get a bearer token.** The Bearer plugin puts the session token in an
`Authorization` header, and its documentation attaches an explicit caution that improper
implementation can easily lead to vulnerabilities. Request signing, per-device keys, nonce
and replay protection are not part of it. In a browser this is a non-issue — the default
is an httpOnly cookie and that design is fine. It matters on the API path, which is where
a product ends up.

**Deletion is a hard delete.** It is off by default, and when enabled it removes the user
immediately. There are verification options and `beforeDelete` / `afterDelete` hooks to
hang cleanup on. What is not there is the part that takes time to get right: a grace
period, a recovery path, what a pending account is allowed to do, and a sweep that cannot
be raced.

## Answer four: install a slice — @spfn/auth

`@spfn/auth` is not a library you wire. It is a vertical slice you mount, arriving with
its routes, its typed client, its tables and its migrations:

```ts
export const appRouter = defineRouter({ /* your routes */ })
    .packages([authRouter])   // mounts /_auth/* and exposes them on the typed authApi
    .use([authenticate]);     // auth applies globally; routes opt out per-route
```

### The credential is asymmetric, so the server holds nothing worth stealing

The client generates an ES256/RS256 keypair, sends only the public half at register or
login, and signs each request itself. The server verifies against the stored public key
and holds no private key for any user.

The consequence is one sentence: **a stolen bearer token is usable by whoever stole it,
and a stolen public key is not.**

Keys are per-device and accumulate on purpose, so signing in on a new phone does not sign
out the laptop. They expire after 90 days and `rotateKey` renews one. `listKeys` shows the
owner what accumulated, `revokeKey` cuts one off, `revokeAllKeys` cuts off everything
else. Expiry is computed at request time rather than stored, because a list that showed an
expired key as active would report something the server does not act on. Sessions default
to seven days.

### Deletion is a state machine, not a DELETE

```
none ──request (step-up, recent auth)──> pending ──grace elapses──> anonymised or removed
  ^                                         │
  └──cancel (password or one-time code)─────┘
```

- **Deletion is not a status.** Where the account is in its deletion is its own column,
  apart from whether an operator lets it in, so a suspended account stays suspended
  through a deletion request and its cancellation.
- **Request** passes the gates every sensitive change does: the second factor re-proved
  on this device for an account that has one, and a recent sign-in or the password. Every
  active session key is revoked at that moment, an audit row is written, and the user is
  told the scheduled purge date.
- **Login is refused while pending**, with a dedicated error carrying the purge date, so
  the client can offer recovery instead of showing a generic failure.
- **Cancel is public**, because the sessions were already revoked and there is no token
  left to authenticate with. The password, or a single-use code sent to the account's
  e-mail or phone, cancels it — a forgotten password does not lock the owner out.
- **The sweep runs daily** once registered with `.jobs(authJobRouter)`, and it is
  deliberately not automatic — a purge job that appears without you asking is worse than
  one you had to type.
- **Purge strategy is a choice**: `anonymize` scrubs the PII and keeps the row, or
  `hard-delete` removes it and cascades the children.
- **The audit row outlives the user row.** Its foreign key is `set null`, not cascade, so
  who requested what and when survives the deletion.
- **A concurrent cancel cannot be raced.** The sweep re-verifies the account is still
  pending on the write primary, inside the same transaction as the destructive statement,
  and claims the request with a conditional update that matches zero rows if a cancel got
  there first.
- **Admin and GDPR entry points are exported** as services; your app owns the route and
  its authorization.

Two things this does not do, stated because you would find out anyway: a purged account's
email becomes immediately reusable, and data-subject-request intake and response workflows
are yours.

### Authorization comes with it

Roles and permissions, a global `authenticate` middleware that individual routes opt out
of, and `hasPermission` and `getUserRole` exported so the app can gate its own surfaces
with the same source of truth.

## Where Better Auth wins

- **It works anywhere.** `@spfn/auth` only runs inside an SPFN app. For most readers the
  comparison ends on that line, and it should.
- **It is the recommended default** for new self-hosted Next.js projects, and it earned
  that position.
- **Its plugin range is wider today** — passkeys, multi-tenancy, enterprise SSO,
  multi-session.
- **Its ecosystem is larger** in every measurable way, which means more answers already
  written to the question you are about to have.

## The summary

| | Build it | Agent writes it | Better Auth | @spfn/auth |
|---|---|---|---|---|
| Sign-in | you | you review | yes | yes |
| Non-browser credential | you decide | you decide, silently | bearer token | client-signed, per-device |
| Server holds a usable secret | your choice | your choice | session token | no |
| Deletion | you build | you build | immediate hard delete | grace, recovery, sweep |
| Authorization | you build | you build | yes | yes |
| Runs outside its framework | yes | yes | yes | no |

If the app is not an SPFN app, use Better Auth. If it is, the argument for `@spfn/auth` is
not that it does something no one else can. It is that the decisions in the middle column
have already been made, argued, tested and measured, and you get to skip to the next
thing.

- [Full-stack TypeScript frameworks compared](./fullstack-typescript-frameworks.md) — the
  framework-level version of this question
- [@spfn/auth documentation](../docs/packages/auth.md)
