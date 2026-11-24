/**
 * The shape a refusal's `code` must have: 1 to 64 characters, each a letter,
 * a digit, `_`, `-` or `.` — `ACCOUNT_LOCKED`, `temporary-password-expired`,
 * `policy.locked`. It reaches the client as `details.code`, a constant to
 * branch on: never a message, and never data interpolated into one.
 *
 * The module imports nothing: the OAuth callback readers in the client bundle
 * hold a `code` off their URL to the same shape (#489).
 */
export const SIGN_IN_REFUSAL_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
