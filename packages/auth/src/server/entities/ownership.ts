/**
 * @spfn/auth - Who owns a piece of the role model
 *
 * Roles and role→permission mappings each record their owner in a `source`
 * column:
 *
 * - `config` — the app's configuration declares it (`initializeAuth`, with the
 *   built-ins). Every boot makes what the configuration declares equal to it;
 *   the admin API cannot change or remove it (409).
 * - `admin` — an operator created it at runtime. Boot leaves it alone, unless
 *   the configuration comes to declare it, which makes it the configuration's.
 *
 * The stored value `admin` names an operator, not the `admin` role.
 */

/** Every owner a `source` column may store. */
export const AUTHORITY_SOURCES = ['config', 'admin'] as const;

export type AuthoritySource = typeof AUTHORITY_SOURCES[number];

/** Declared by the configuration: every boot makes it equal to it. */
export const CONFIG_OWNED = 'config' as const satisfies AuthoritySource;

/** Created by an operator at runtime: boot leaves it alone. */
export const OPERATOR_OWNED = 'admin' as const satisfies AuthoritySource;
