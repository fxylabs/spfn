/**
 * Ops Token Service
 *
 * Issuance and verification for the CLI-first ops surface. The secret is
 * `spfn_ops_<64 hex>`; only its SHA-256 hash is stored, so issuance is the
 * one moment the secret exists in the clear.
 *
 * Verification answers with the same null for an unknown, revoked, or
 * expired token — the refusal reveals nothing about whether a presented
 * secret ever existed (the non-disclosure rule the client-proof surface
 * keeps).
 */

import { createHash, randomBytes } from 'node:crypto';
import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import { InsufficientPermissionsError } from '@spfn/auth/errors';
import { opsTokensRepository } from '../repositories/ops-tokens.repository';
import { usersRepository } from '../repositories/users.repository';
import { keysRepository } from '../repositories/keys.repository';
import type { OpsToken } from '../entities/ops-tokens';
import { opsTokenIssuedEvent, opsTokenRevokedEvent, type OpsTokenIssuedPayload } from '../events';
import { BUILTIN_PERMISSIONS } from '../rbac/builtin';
import { authLogger } from '../logger';
import { resolveAuthority } from './permission.service';
import { assertStepUp } from './mfa.service';
import { sessionCredentialOf, type PrincipalCredential } from './admission.service';
import { assertPasskeyProven, type PasskeyProof } from '../lib/passkey-proof';

/**
 * The permission that issues an ops token, and that its issuer has to keep
 * holding for the token to keep working.
 */
export const OPS_TOKEN_ISSUE_PERMISSION = BUILTIN_PERMISSIONS.OPS_TOKEN_ISSUE.name;

/**
 * The shape every ops-token secret carries.
 *
 * Exported because an application that admits both an ops token and a user
 * session on one route has to tell the two apart before either is verified,
 * and a literal copied into application code drifts silently when this
 * package changes the shape.
 */
export const OPS_TOKEN_PREFIX = 'spfn_ops_';

/**
 * Whether a presented bearer credential has the ops-token shape.
 *
 * Shape only — a token of this shape may still be unknown, revoked, or
 * expired; `verifyOpsTokenService` decides that. Callers read a raw header,
 * so a missing or non-string argument answers false rather than throwing.
 */
export function isOpsToken(bearer: string): boolean
{
    return typeof bearer === 'string' && bearer.startsWith(OPS_TOKEN_PREFIX);
}

/** What a verified token authorizes — the principal ops middleware exposes. */
export interface VerifiedOpsToken
{
    tokenId: number;
    name: string;
    scopes: string[];
}

export interface IssuedOpsToken
{
    /** The secret, shown exactly once. Never stored, never logged. */
    token: string;
    record: OpsToken;
}

function hashOpsToken(token: string): string
{
    return createHash('sha256').update(token).digest('hex');
}

/** Who issues a token, and the credential their request presented — its step-up is that credential's. */
export interface OpsTokenIssuer
{
    userId: number;
    credential: PrincipalCredential;
    /** The passkey proof for `opsTokenIssue` (`checkPasskeyProof`), asked of an account with session binding on. */
    passkeyProof?: PasskeyProof | null;
}

/**
 * Issue a new ops token.
 *
 * An ops token is a credential issued under the issuer's account, so issuance
 * takes that account's lock (`usersRepository.lockAccount`) first and reads
 * under it what entitles the issuer: an active account holding
 * `ops:token:issue` (`resolveAuthority`), a step-up on this device when the
 * account has a second factor (`assertStepUp`), and the passkey proof when the
 * account has session binding on (`assertPasskeyProven`): a token outlives
 * every key, so a copied bound session must not mint one. A suspension, demotion or
 * step-up lapse that commits before the lock is seen here and leaves no token;
 * one that commits after it waits for this insert and stops the token through
 * `verifyOpsTokenService`. The token borrows the issuer's authority from then on.
 *
 * `auth.ops_token.issued` is announced after the transaction commits — after the
 * caller's, when this runs inside one — so a refused issuance and a rolled-back
 * one announce nothing.
 *
 * @param name - Operator-facing label
 * @param scopes - Permission strings the token grants ('*' grants all)
 * @param expiresAt - null for a non-expiring token
 * @param issuer - The administrator issuing it, and their request's device key
 * @throws InsufficientPermissionsError (403) when the issuer is not active or lacks `ops:token:issue`
 * @throws StepUpRequiredError (403) when the issuer has a second factor and this device has not stepped up recently
 * @throws PasskeyProofRequiredError (403) when the issuer has session binding on and no proof for `opsTokenIssue` holds
 */
export async function issueOpsTokenService(
    name: string,
    scopes: string[],
    expiresAt: Date | null,
    issuer: OpsTokenIssuer,
): Promise<IssuedOpsToken>
{
    if (scopes.length === 0)
    {
        throw new Error('An ops token needs at least one scope (\'*\' grants all).');
    }

    return runInTransaction(async () =>
    {
        const account = await usersRepository.lockAccount(issuer.userId);
        await assertMayIssue(issuer);
        await assertPasskeyProven(account, issuer.passkeyProof ?? null, 'opsTokenIssue');

        const token = OPS_TOKEN_PREFIX + randomBytes(32).toString('hex');
        const record = await opsTokensRepository.create({
            name,
            tokenHash: hashOpsToken(token),
            scopes,
            expiresAt,
            issuedBy: issuer.userId,
        });
        const via = await viaOf(issuer.credential);

        onAfterCommit(() => opsTokenIssuedEvent.emit({
            userId: String(issuer.userId),
            tokenId: record.id,
            name: record.name,
            scopes: record.scopes,
            expiresAtMillis: record.expiresAt?.getTime(),
            createdAtMillis: record.createdAt.getTime(),
            via,
        }));

        return { token, record };
    }, { context: 'auth:ops-token-issue' });
}

/**
 * The credential an act was asked through, as the ops-token events name it:
 * the one answer `sessionCredentialOf` gives every reader of a session. A grant
 * is no session and names nothing. A device key held to a reach — a terminal
 * let in by a narrowed link — is named with its reach, read off its row, so a
 * token minted from a terminal is told apart from one minted in a browser.
 */
async function viaOf(credential: PrincipalCredential): Promise<OpsTokenIssuedPayload['via']>
{
    const session = sessionCredentialOf(credential);

    if (session?.kind === 'appProfile')
    {
        return { keyId: session.keyId, profile: session.profile };
    }

    if (!session)
    {
        return { keyId: undefined };
    }

    const key = await keysRepository.findByKeyIdOnPrimary(session.keyId);

    return { keyId: session.keyId, ...(key?.reach ? { reach: key.reach } : {}) };
}

/** Under the issuer's account lock: their status and permission, then their step-up. */
async function assertMayIssue(issuer: OpsTokenIssuer): Promise<void>
{
    const { permissions } = await resolveAuthority(issuer.userId);

    if (!permissions.some(permission => permission.name === OPS_TOKEN_ISSUE_PERMISSION))
    {
        throw new InsufficientPermissionsError({ requiredPermissions: [OPS_TOKEN_ISSUE_PERMISSION] });
    }

    await assertStepUp(issuer);
}

/**
 * Verify a presented token. Null for unknown, revoked, and expired alike —
 * and for a token whose issuer could no longer issue it: one whose account is
 * not active (suspended, inactive, pending deletion, deleted), or who no longer
 * holds `ops:token:issue` (demoted, or the role deactivated). The issuer's
 * authority is read as it is now, on every verification, so the token stops
 * with it and comes back if it is restored. A token issued before issuers
 * were recorded has none, and is refused.
 */
export async function verifyOpsTokenService(token: string): Promise<VerifiedOpsToken | null>
{
    if (!isOpsToken(token))
    {
        return null;
    }

    const record = await opsTokensRepository.findByTokenHash(hashOpsToken(token));
    if (!record || !isLiveOpsToken(record) || !await issuerStillAuthorizes(record))
    {
        return null;
    }

    opsTokensRepository.updateLastUsedById(record.id)
        .catch((err: unknown) => authLogger.service.error('Failed to update ops token lastUsedAt', err));

    return {
        tokenId: record.id,
        name: record.name,
        scopes: record.scopes,
    };
}

function isLiveOpsToken(record: OpsToken): boolean
{
    return record.revokedAt === null && (record.expiresAt === null || new Date() <= record.expiresAt);
}

async function issuerStillAuthorizes(record: OpsToken): Promise<boolean>
{
    if (record.issuedBy === null)
    {
        return false;
    }

    const { permissions } = await resolveAuthority(record.issuedBy);

    return permissions.some(permission => permission.name === OPS_TOKEN_ISSUE_PERMISSION);
}

/** Who revokes a token, and the credential their request presented. */
export interface OpsTokenRevoker
{
    userId: number;
    credential: PrincipalCredential;
}

/**
 * Revoke an active token. Null when the id is unknown or already revoked.
 *
 * `auth.ops_token.revoked` is announced after commit — the caller's, when this
 * runs inside a transaction; otherwise the revocation is one statement, already
 * committed — naming the revoker when one is given: any administrator may revoke
 * any token, so the issuer learns of it there. Nothing is announced for a null
 * answer or a rolled-back revocation.
 *
 * @param id - The token's id
 * @param revoker - The administrator revoking it, and their request's credential;
 *     omitted when the application revokes a token itself
 */
export async function revokeOpsTokenService(id: number, revoker?: OpsTokenRevoker): Promise<OpsToken | null>
{
    const record = await opsTokensRepository.revokeById(id);

    if (record)
    {
        const via = revoker ? await viaOf(revoker.credential) : undefined;

        onAfterCommit(() => opsTokenRevokedEvent.emit({
            userId: revoker ? String(revoker.userId) : undefined,
            tokenId: record.id,
            name: record.name,
            issuedBy: record.issuedBy === null ? undefined : String(record.issuedBy),
            revokedAtMillis: record.revokedAt!.getTime(),
            via,
        }));
    }

    return record;
}

export async function listOpsTokensService(): Promise<OpsToken[]>
{
    return await opsTokensRepository.list();
}
