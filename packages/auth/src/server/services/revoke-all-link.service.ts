/**
 * @spfn/auth - Signed Sign-Out-Everywhere Link
 *
 * A link an app mails to an account's proven address, which signs every device
 * of that account out without a session. It exists for the case the rest of the
 * key surface cannot serve: the owner suspects a device they do not recognise,
 * and the device they would have to sign in on to do something about it is the
 * one they no longer trust.
 *
 * Three calls, and each is deliberately not the other two. `createRevokeAllLink`
 * mints the capability and hands the app a URL. `describeRevokeAllLink` says
 * whether that URL still works and changes nothing, so a mail scanner opening
 * the page costs nothing. `consumeRevokeAllLink` is the only one that revokes,
 * and it takes the owner pressing the button.
 *
 * The caller's obligation, which this package cannot enforce: the URL
 * `createRevokeAllLink` returns carries the plaintext token, because the package
 * sends no mail here. Do not log it, do not persist it, do not put it in a job
 * payload — hand it to the mail template and let it go. Every other link in this
 * package is minted inside the worker that sends it precisely so that no caller
 * ever holds one; this one cannot be, and the obligation moves to the app.
 */

import { env } from '@spfn/auth/config';
import { NotFoundError, ValidationError } from '@spfn/core/errors';
import { RevokeAllLinkError } from '@spfn/auth/errors';

import { authLogger } from '../logger';
import { buildConfirmUrl, hashCredential, mintCredential } from '../lib/link-credentials';
import { keyRevokeAllTokensRepository, keysRepository, usersRepository } from '../repositories';
import { revokeAllKeysService } from './key.service';

/** Default TTL when neither the caller nor the environment names one. */
const DEFAULT_LINK_TTL_MINUTES = 30;

/** How long an expired row is kept before the sweep takes it. */
const EXPIRED_RETENTION_DAYS = 7;

/** How long a spent or superseded row is kept before the sweep takes it. */
const SETTLED_RETENTION_DAYS = 1;

export interface CreateRevokeAllLinkOptions
{
    /**
     * Minutes the link stays valid. Defaults to
     * `SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES`, itself 30.
     */
    ttlMinutes?: number;
}

export interface RevokeAllLink
{
    /** Absolute URL of the app page, token in its query string. Never log it. */
    url: string;
    expiresAt: Date;
}

/** What the describe call tells the page, so it can say what pressing the button does. */
export interface RevokeAllLinkDescription
{
    expiresAt: Date;
    activeKeyCount: number;
}

/**
 * Mint a sign-out-everywhere link for an account.
 *
 * Issuing supersedes every live link the account already has, the rule the
 * password-reset flow follows: an owner who asks twice must not leave the first
 * capability working in their mailbox after using the second.
 *
 * The row records the account's key generation, so the link dies the moment any
 * other path signs every device out — a password reset, a password change, a
 * deletion request, or the ordinary revoke-all route.
 *
 * Send it beside a password reset link. It ends the sessions; it does not change
 * the password that let them start.
 *
 * @param userId - The account to issue for
 * @throws ValidationError `ttlMinutes` that is not a positive integer — no row is written
 * @throws NotFoundError no such account, rather than a foreign-key failure at the insert
 */
export async function createRevokeAllLink(
    userId: string | number,
    options: CreateRevokeAllLinkOptions = {},
): Promise<RevokeAllLink>
{
    const ttlMinutes = options.ttlMinutes ?? env.SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES ?? DEFAULT_LINK_TTL_MINUTES;

    if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0)
    {
        throw new ValidationError({ message: 'ttlMinutes must be a positive whole number of minutes' });
    }

    // Refused here rather than at the insert: an unknown id is the caller's
    // mistake and reads as one, where the foreign key would surface as a 500
    // naming a constraint.
    const user = await usersRepository.findById(Number(userId));

    if (!user)
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    await keyRevokeAllTokensRepository.supersedeAllLiveByUserId(user.id);

    const { secret, hash } = mintCredential();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    await keyRevokeAllTokensRepository.create({
        userId: user.id,
        tokenHash: hash,
        keyEpoch: user.keyEpoch,
        expiresAt,
    });

    return {
        url: buildConfirmUrl(env.SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH || '/account/revoke-all', secret),
        expiresAt,
    };
}

/**
 * Say whether a presented link still works, and what pressing the button would
 * do. Changes nothing — a mail scanner that opens the page has done nothing.
 *
 * @throws RevokeAllLinkError every refusal, in one shape
 */
export async function describeRevokeAllLink(token: string): Promise<RevokeAllLinkDescription>
{
    const live = await keyRevokeAllTokensRepository.findLiveByTokenHash(hashCredential(token));

    if (!live)
    {
        authLogger.service.warn('Revoke-all link refused', { reason: 'not live', step: 'confirm' });

        throw new RevokeAllLinkError();
    }

    const active = await keysRepository.findActiveByUserId(live.userId);

    return { expiresAt: live.expiresAt, activeKeyCount: active.length };
}

/**
 * Spend a link and sign every device of the account out.
 *
 * The claim is one statement, so of two requests carrying the same token exactly
 * one revokes and the other is refused as if the token were unknown — which by
 * then it is. `includeCurrent` is true because there is no current device here:
 * the caller holds a mailbox, not a session, and sparing something would mean
 * sparing whatever the owner is trying to cut off.
 *
 * @returns how many device keys were revoked; zero is a success, not a refusal
 * @throws RevokeAllLinkError every refusal, in the same shape `describe` uses
 */
export async function consumeRevokeAllLink(token: string): Promise<{ revokedCount: number }>
{
    const userId = await keyRevokeAllTokensRepository.consume(hashCredential(token));

    if (userId === null)
    {
        authLogger.service.warn('Revoke-all link refused', { reason: 'not live', step: 'consume' });

        throw new RevokeAllLinkError();
    }

    const { revokedCount } = await revokeAllKeysService({
        userId,
        includeCurrent: true,
        reason: 'revoke-all-link',
    });

    return { revokedCount };
}

/**
 * Delete link rows that can no longer answer anything.
 *
 * @returns number of rows deleted
 */
export async function purgeRevokeAllTokensService(): Promise<{ deleted: number }>
{
    const now = Date.now();
    const deleted = await keyRevokeAllTokensRepository.purge(
        new Date(now - EXPIRED_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        new Date(now - SETTLED_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );

    return { deleted };
}
