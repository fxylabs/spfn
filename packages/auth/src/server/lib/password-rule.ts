/**
 * Password Rule
 *
 * The application's rule for a new password —
 * `createAuthLifecycle({ password: { validate } })`, set once and read at
 * request time, as `password-change-guard.ts` is.
 *
 * With nothing stated there is no rule (`passwordRule()` answers null), and a
 * new password is held to `PasswordSchema` alone, as it was.
 *
 * Where it is asked, and why there, is `services/password-rule.service.ts`.
 */

import { optionKeys, readOptions } from './stated-options';

/**
 * Which path is writing the password:
 *
 * - `register` — `POST /_auth/register`;
 * - `signup-link` — `POST /_auth/signup/password`, the verified-email signup;
 * - `invitation` — `POST /_auth/invitations/accept`;
 * - `change` — `PUT /_auth/password`, a first password included;
 * - `reset` — `POST /_auth/password/reset/complete`;
 * - `seed` — admin seeding from the environment, at boot;
 * - `operator` — the app's own code, through `hashNewPassword`.
 */
export type PasswordRuleChannel = 'register' | 'signup-link' | 'invitation' | 'change' | 'reset' | 'seed' | 'operator';

/**
 * Who the password is for, as far as the path knows it when the rule is asked.
 *
 * Identifiers only, never an account row: on `register`, `signup-link`,
 * `invitation` and `seed` no account exists yet, and on `reset` the rule is
 * asked before the account is read, so its answer is the same whether the
 * account is still there or not.
 */
export interface PasswordRuleSubject
{
    channel: PasswordRuleChannel;
    /** The existing account's id: on `change` and `reset`, and on `operator` when the app names one. Otherwise null. */
    userId: number | null;
    email: string | null;
    phone: string | null;
}

/** The rule's answer: nothing or `[]` to accept, the app's messages to refuse. */
export type PasswordRuleAnswer = string[] | void | undefined;

/** `createAuthLifecycle({ password })`. */
export interface PasswordRuleOptions
{
    /**
     * Judge a new password. Answer the messages to show beside the password
     * field to refuse it: 400 `ValidationError`, nothing hashed or written. A
     * throw is 500 `PasswordRuleFailedError`, never an acceptance.
     */
    validate: (password: string, subject: PasswordRuleSubject) => PasswordRuleAnswer | Promise<PasswordRuleAnswer>;
}

const OPTION_KEYS = optionKeys<PasswordRuleOptions>({ validate: true });

let rule: PasswordRuleOptions | null = null;

/** Why boot must be refused, once two calls stated different rules. */
let contradiction: string | null = null;

/**
 * Set the rule. Called synchronously from `createAuthLifecycle()`, so it is in
 * force before any handler — and admin seeding — can run.
 *
 * The rule `configurePasswordChange` follows: a call that states nothing
 * leaves the rule as it is, and a call that states another function than an
 * earlier call is a contradiction refused at boot by
 * `assertPasswordRuleConsistent`, the first statement staying in force.
 *
 * @throws Error on an unknown key, or a `validate` that is not a function
 */
export function configurePasswordRule(options: PasswordRuleOptions | undefined): void
{
    if (options === undefined)
    {
        return;
    }

    const read = readRule(options);

    if (rule === null)
    {
        rule = read;

        return;
    }

    if (rule.validate !== read.validate && contradiction === null)
    {
        contradiction = 'createAuthLifecycle() was given a different password.validate in two calls. '
            + 'State it once, or the same function in every call. Until then the first one stays in force.';
    }
}

/** `options` read once, by `readOptions`: the snapshot is what is checked, compared and kept (#477). */
function readRule(options: PasswordRuleOptions): PasswordRuleOptions
{
    const { validate } = readOptions<PasswordRuleOptions>('password', options, OPTION_KEYS);

    if (typeof validate !== 'function')
    {
        throw new Error(`password.validate must be a function, received ${String(validate)}.`);
    }

    return { validate };
}

/**
 * Refuse boot when two `createAuthLifecycle()` calls stated different rules.
 * Called from `afterInfrastructure`, beside `assertPasswordChangeGuardConsistent`.
 */
export function assertPasswordRuleConsistent(): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }
}

/** The rule the application stated, or null — and with null, nothing is asked. */
export function passwordRule(): PasswordRuleOptions | null
{
    return rule;
}

/** Test-only: no rule, no contradiction. */
export function resetPasswordRuleForTests(): void
{
    rule = null;
    contradiction = null;
}

declare const admittedPassword: unique symbol;
declare const admittedPasswordHash: unique symbol;

/**
 * A new password the rule has accepted (`admitNewPassword`). The only input
 * `hashAdmittedPassword` takes.
 */
export type AdmittedPassword = string & { readonly [admittedPassword]: true };

/**
 * The only hash `usersRepository` writes into `passwordHash`: made from an
 * `AdmittedPassword`, or re-encoded from the password a sign-in has just proven
 * (`reencodeProvenPassword`). A hash from `hashPassword` alone does not
 * type-check there, so a path that writes a password without asking the rule
 * does not compile.
 */
export type AdmittedPasswordHash = string & { readonly [admittedPasswordHash]: true };
