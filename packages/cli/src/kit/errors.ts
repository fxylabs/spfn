/**
 * The machine-readable failure vocabulary of `spfn kit` (unit 06 section 8.3).
 *
 * A Kit command never fails with a stack trace and a number: it fails with a
 * stable code an agent can branch on, and an exit code that says what class of
 * thing went wrong. The two tables below are the whole contract — the code list
 * is closed, and every code maps to exactly one exit code.
 *
 * The codes are the CLI surface of the frozen `kit-error-vocabulary` contract.
 * Adding one here without adding it there would give an agent a code no other
 * repository can read, so the list is asserted against the design in
 * `test/kit/errors.test.ts`.
 */

/** Exit codes, unit 06 section 8.3. */
export const KIT_EXIT = {
    /** Completed, or an idempotent no-op. */
    OK: 0,
    /** Waiting for human input or an exact plan approval. */
    INPUT_REQUIRED: 2,
    /** Recoverable operation failure — `spfn kit resume` can continue it. */
    RESUMABLE: 3,
    /** Refused before any write: drift, compatibility or entitlement. */
    REFUSED: 4,
    /** An external provider or the control plane is unavailable. */
    UNAVAILABLE: 5,
    /** CLI and manifest speak different protocol versions. */
    INCOMPATIBLE: 10,
} as const;

export type KitExitCode = (typeof KIT_EXIT)[keyof typeof KIT_EXIT];

/** Every failure code a `spfn kit` command may return, and its exit code. */
export const KIT_ERROR_EXIT = {
    KIT_SETUP_URL_INVALID: KIT_EXIT.REFUSED,
    KIT_MANIFEST_INVALID: KIT_EXIT.REFUSED,
    KIT_CLI_INCOMPATIBLE: KIT_EXIT.INCOMPATIBLE,
    KIT_LICENSE_REQUIRED: KIT_EXIT.INPUT_REQUIRED,
    KIT_CREDENTIAL_MISSING: KIT_EXIT.REFUSED,
    KIT_CREDENTIAL_STALE: KIT_EXIT.REFUSED,
    KIT_ENTITLEMENT_EXPIRED: KIT_EXIT.REFUSED,
    KIT_PROJECT_LIMIT: KIT_EXIT.REFUSED,
    KIT_TARGET_NOT_EMPTY: KIT_EXIT.REFUSED,
    KIT_WORKTREE_DIRTY: KIT_EXIT.REFUSED,
    KIT_LOCK_INVALID: KIT_EXIT.REFUSED,
    KIT_MANAGED_DRIFT: KIT_EXIT.REFUSED,
    KIT_UNSUPPORTED_RESOLUTION: KIT_EXIT.REFUSED,
    KIT_UNSUPPORTED_IMPORT: KIT_EXIT.REFUSED,
    KIT_UPDATE_EDGE_MISSING: KIT_EXIT.REFUSED,
    KIT_OPERATION_ACTIVE: KIT_EXIT.REFUSED,
    KIT_RESUME_MISMATCH: KIT_EXIT.RESUMABLE,
    KIT_GUIDE_UNAVAILABLE: KIT_EXIT.UNAVAILABLE,
    KIT_GUIDE_INCOMPATIBLE: KIT_EXIT.REFUSED,
    KIT_GATE_FAILED: KIT_EXIT.RESUMABLE,
    KIT_MIGRATION_FAILED: KIT_EXIT.RESUMABLE,
    KIT_DEPLOY_FAILED: KIT_EXIT.RESUMABLE,
} as const;

export type KitErrorCode = keyof typeof KIT_ERROR_EXIT;

/**
 * Codes this build may emit that are *not* Kit failures.
 *
 * `CLI_` names sit outside the frozen `KIT_` vocabulary on purpose: that
 * vocabulary is closed and shared across three repositories, so a condition it
 * has no code for gets a name that cannot be mistaken for one. This table is
 * where such a condition goes; adding to `KIT_ERROR_EXIT` instead would be a
 * contract change, and is not something this repository may make.
 */
export const CLI_ONLY_ERROR_EXIT = {
    /** The control-plane client is not in this build (arrives with I4c). */
    CLI_CONTROL_PLANE_CLIENT_ABSENT: KIT_EXIT.UNAVAILABLE,
    /** The control plane answered nothing usable. */
    CLI_CONTROL_PLANE_UNAVAILABLE: KIT_EXIT.UNAVAILABLE,
    /**
     * A package exports this Kit's tooling, and loading it threw.
     *
     * Refused rather than unavailable: nothing is unreachable and waiting will
     * not help. Something in the installed graph does not run on this Node, and
     * the fix is to that package or to the runtime — which is what exit 4 tells
     * an agent to go and do, where exit 5 would tell it to try again later.
     */
    CLI_TOOLING_LOAD_FAILED: KIT_EXIT.REFUSED,
    /**
     * The recovery challenge was not one this activation could use.
     *
     * Wrong, expired, already spent or superseded by a newer request — the
     * control plane deliberately does not distinguish them, and neither does
     * this. Refused rather than resumable: nothing partial happened, the old
     * credential is untouched, and the next step is a fresh `spfn kit recover`
     * rather than a resume of anything.
     */
    CLI_RECOVERY_INVALID: KIT_EXIT.REFUSED,
    /**
     * An operation that may not touch customer source did.
     *
     * Unit 05 §12 decision 7 makes zero customer writes an invariant of every
     * update and rollback, and unit 10 §11.2 makes the before/after digest the
     * evidence for it. This is what that evidence disagreeing looks like: the
     * operation stops without committing, so the checkout can be inspected as
     * it stands rather than with the change already in history.
     */
    CLI_CUSTOMER_SOURCE_CHANGED: KIT_EXIT.REFUSED,
    /**
     * The project's migration bookkeeping does not match its migrations folder.
     *
     * Refused rather than waiting: the database answered, and `spfn db migrate`
     * refuses it, so no amount of waiting or resuming changes anything until a
     * person restores the folder or corrects the bookkeeping row.
     */
    CLI_MIGRATION_BOOKKEEPING_MISMATCH: KIT_EXIT.REFUSED,
} as const;

export type CliOnlyErrorCode = keyof typeof CLI_ONLY_ERROR_EXIT;

export const CLI_CONTROL_PLANE_CLIENT_ABSENT = 'CLI_CONTROL_PLANE_CLIENT_ABSENT';

/** What the agent may safely run next, printed with the failure. */
export interface KitNextAction
{
    command: string;
    requiresHumanApproval: boolean;
    approvalDigest?: string;
}

export interface KitErrorInit
{
    /** Secret-free facts about the failure. Never a token, key or raw body. */
    evidence?: Record<string, string | number | boolean | null>;
    next?: KitNextAction;
    operationId?: string;
    phase?: string;
    cause?: unknown;
}

/**
 * A refusal with a code an agent can act on.
 *
 * `summary` is written for a person; `evidence` carries the machine-readable
 * facts. Neither ever holds a secret — the journal, the events and this error
 * all pass through the same rule.
 */
export class KitError extends Error
{
    readonly code: KitErrorCode | CliOnlyErrorCode;
    readonly exitCode: number;
    readonly evidence: Record<string, string | number | boolean | null>;
    readonly next?: KitNextAction;
    readonly operationId?: string;
    readonly phase?: string;

    constructor(
        code: KitErrorCode | CliOnlyErrorCode,
        summary: string,
        init: KitErrorInit = {},
    )
    {
        super(summary, init.cause === undefined ? undefined : { cause: init.cause });
        this.name = 'KitError';
        this.code = code;
        this.exitCode = code in CLI_ONLY_ERROR_EXIT
            ? CLI_ONLY_ERROR_EXIT[code as CliOnlyErrorCode]
            : KIT_ERROR_EXIT[code as KitErrorCode];
        this.evidence = init.evidence ?? {};
        this.next = init.next;
        this.operationId = init.operationId;
        this.phase = init.phase;
    }
}

export function isKitError(value: unknown): value is KitError
{
    return value instanceof KitError;
}
