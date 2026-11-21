/**
 * @spfn/monitor - Error Tracking Service
 *
 * Core service for tracking errors with fingerprint-based deduplication.
 * Uses DB state transitions (new/reopened) instead of in-memory throttling
 * to determine when Slack notifications should be sent.
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describeError } from '@spfn/core/logger';
import { chainOf, summarizeError, type Description } from '../../error-summary';
import { monitorLogger } from '../logger';
import { errorGroupsRepository } from '../repositories';
import { errorEventsRepository } from '../repositories';
import { notifyErrorToSlack } from '../notifiers/slack';
import type { ErrorGroup, ErrorGroupStatus } from '../entities';

const logger = monitorLogger.errorTracking;

/** How many of the stack's top frames name where a fault was raised */
const FAULT_FRAMES = 3;

/** A `file://` URL naming a Windows drive */
const WINDOWS_FILE_URL = /^file:\/\/\/[A-Za-z]:/;

/**
 * Context from the error handler middleware
 */
export interface ErrorTrackingContext
{
    statusCode: number;
    path: string;
    method: string;
    requestId?: string;
    userId?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    environment?: string;
}

/**
 * Generate a deterministic fingerprint for error deduplication (#382)
 *
 * SHA-256 of what identifies the fault, first 16 hex characters: the route
 * path, each link of the cause chain by its name, code, constraint and table,
 * and the top frames of the error's stack by the place in code they name (see
 * `codeFrame`). Never the message: a failed statement's message carries its
 * bound values, so one fault would open a group per value.
 */
export function generateFingerprint(description: Description, path: string): string
{
    const identity = [path, chainOf(description).map(identityOf), topFrames(description)];

    return crypto
        .createHash('sha256')
        .update(JSON.stringify(identity))
        .digest('hex')
        .slice(0, 16);
}

function identityOf(link: Description): unknown[]
{
    return link.kind === 'database'
        ? [link.name, link.code, link.constraint, link.table]
        : [link.name, link.code];
}

function topFrames(description: Description): string[]
{
    return (description.stack ?? '')
        .split('\n')
        .slice(0, FAULT_FRAMES)
        .map(codeFrame);
}

/**
 * A frame as the place in code it names, not the place on disk: no line and
 * column, and its file as `codeLocation` names it — so a deploy to a new
 * release directory or a dependency bump keeps every group (#382)
 */
function codeFrame(frame: string): string
{
    const line = frame.trim().replace(/:\d+:\d+(\)?)$/, '$1');
    const call = /^(.* \()(.+)\)$/.exec(line);

    if (call)
    {
        return `${call[1]}${codeLocation(call[2])})`;
    }

    const bare = /^(at (?:async )?)(.+)$/.exec(line);

    return bare ? `${bare[1]}${codeLocation(bare[2])}` : line;
}

/**
 * A dependency's file as its package names it — the path from the last
 * `node_modules/` on, with no `.pnpm/<name>@<version>_<hash>` directory and no
 * install location; app code relative to the working directory when inside it
 */
function codeLocation(location: string): string
{
    const path = filePath(location).replaceAll('\\', '/');
    const dependency = path.lastIndexOf('/node_modules/');

    if (dependency !== -1)
    {
        return path.slice(dependency + '/node_modules/'.length);
    }

    const root = workingDirectory();

    if (root === null)
    {
        return location;
    }

    // A working directory of `/` (or `C:/`) already ends in the separator
    const inside = root.endsWith('/') ? root : `${root}/`;

    return path.startsWith(inside) ? path.slice(inside.length) : location;
}

/**
 * A frame's location as a file path. An ESM frame names a `file://` URL:
 * percent-encoded, and on Windows `file:///C:/…`, so it is converted, not
 * stripped of its scheme. A drive letter marks a Windows path wherever this
 * runs. Anything else (`node:internal/…`, `<anonymous>`) is kept as it is.
 */
function filePath(location: string): string
{
    if (!location.startsWith('file:'))
    {
        return location;
    }

    try
    {
        return fileURLToPath(location, { windows: WINDOWS_FILE_URL.test(location) });
    }
    catch
    {
        return location;
    }
}

/** The process's working directory; null once it is gone, as an old release directory can be */
function workingDirectory(): string | null
{
    try
    {
        return process.cwd().replaceAll('\\', '/');
    }
    catch
    {
        return null;
    }
}

/**
 * Track an error occurrence
 *
 * 1. Generate fingerprint
 * 2. Find or create error group
 * 3. Create error event
 * 4. Send Slack notification on new or reopened errors
 */
export async function trackError(
    err: Error,
    ctx: ErrorTrackingContext,
    metadata?: Record<string, unknown>,
): Promise<void>
{
    const description = describeError(err);
    const fingerprint = generateFingerprint(description, ctx.path);

    const existing = await errorGroupsRepository.findByFingerprint(fingerprint);
    const now = new Date();

    if (!existing)
    {
        // New error — create group + event + notify
        const group = await errorGroupsRepository.create({
            fingerprint,
            name: description.name,
            message: summarizeError(description),
            path: ctx.path,
            method: ctx.method,
            statusCode: ctx.statusCode,
            status: 'active',
            count: 1,
            firstSeenAt: now,
            lastSeenAt: now,
        });

        const event = await safeCreateEvent(group.id, description, ctx, metadata);

        logger.info('New error group tracked', { fingerprint, groupId: group.id });

        if (event)
        {
            notifyErrorToSlack(group, event, description, 'new', ctx.environment)
                .catch(error => logger.warn('Slack notification failed', { error }));
        }

        return;
    }

    if (existing.status === 'resolved')
    {
        // Reopened — back to active + increment + notify (single UPDATE)
        await errorGroupsRepository.reactivate(existing.id);

        const event = await safeCreateEvent(existing.id, description, ctx, metadata);

        logger.info('Error group reopened', { fingerprint, groupId: existing.id });

        if (event)
        {
            notifyErrorToSlack(
                { ...existing, status: 'active', count: existing.count + 1 },
                event,
                description,
                'reopened',
                ctx.environment,
            ).catch(error => logger.warn('Slack notification failed', { error }));
        }

        return;
    }

    // Active or ignored — just increment count + create event (no notification).
    // No data dependency between the two writes (the event insert is isolated),
    // so fire them together instead of serially.
    await Promise.all([
        errorGroupsRepository.incrementCount(existing.id),
        safeCreateEvent(existing.id, description, ctx, metadata),
    ]);
}

/**
 * Update error group status with validation
 */
export async function updateErrorGroupStatus(
    groupId: number,
    newStatus: ErrorGroupStatus,
): Promise<ErrorGroup>
{
    const group = await errorGroupsRepository.findById(groupId);
    if (!group)
    {
        throw new Error(`Error group ${groupId} not found`);
    }

    const updated = await errorGroupsRepository.updateStatus(groupId, newStatus);
    if (!updated)
    {
        throw new Error(`Failed to update error group ${groupId}`);
    }

    logger.info('Error group status updated', {
        groupId,
        from: group.status,
        to: newStatus,
    });

    return updated;
}

/**
 * Create an error event record (isolated — failure does not break group tracking)
 *
 * `stack_trace` holds the error's description as JSON — its frames, its cause
 * chain, and for a database error the code, constraint, table and SQL text —
 * never its message, stack header or bound values (#382).
 */
async function safeCreateEvent(
    groupId: number,
    description: Description,
    ctx: ErrorTrackingContext,
    metadata?: Record<string, unknown>,
)
{
    try
    {
        return await errorEventsRepository.create({
            groupId,
            requestId: ctx.requestId,
            userId: ctx.userId,
            statusCode: ctx.statusCode,
            headers: ctx.headers,
            query: ctx.query,
            stackTrace: JSON.stringify(description, null, 2),
            metadata,
        });
    }
    catch (e)
    {
        const cause = e instanceof Error && e.cause instanceof Error
            ? e.cause
            : e;
        logger.warn('Failed to create error event', cause as Error, { groupId });

        return null;
    }
}
