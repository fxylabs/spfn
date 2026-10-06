/**
 * The gate
 *
 * Puts the pieces together: read the newest released snapshot, compare this
 * build's contract against it, and decide removals against what released
 * clients still call or subscribe to.
 *
 * Nothing released yet is a pass — with a warning. "This is the first contract"
 * and "the release that should have written a snapshot didn't" produce the same
 * empty directory, and only a person can tell them apart.
 */

import { compareDocuments } from './compare';
import { newestSnapshot, readSnapshot, usageDir } from './snapshot';
import { callersOf, readUsageRecords, subscribersOf, type UsageRecord } from './usage';
import type { ContractDocument, ContractViolation } from './types';

export interface ContractCheckResult
{
    /** Version compared against, absent when nothing is released yet. */
    baselineVersion?: string;

    violations: ContractViolation[];

    /** Things a person should look at that do not stop the build. */
    warnings: string[];
}

export function checkContract(contractsDir: string, current: ContractDocument): ContractCheckResult
{
    const baseline = newestSnapshot(contractsDir);

    if (!baseline)
    {
        return {
            violations: [],
            warnings: [
                'No released contract snapshot found, so nothing was compared. '
                + 'This is expected for a first contract, and a mistake if a release forgot to write one.',
            ],
        };
    }

    let previous: ContractDocument;

    try
    {
        previous = readSnapshot(baseline.file).document;
    }
    catch (error)
    {
        return {
            baselineVersion: baseline.version,
            warnings: [],
            violations: [{
                kind: 'snapshot.digest-mismatch',
                detail: error instanceof Error ? error.message : String(error),
            }],
        };
    }

    const { violations, removedOperations, removedEvents } = compareDocuments(previous, current);

    return {
        baselineVersion: baseline.version,
        warnings: [],
        violations: [...violations, ...judgeRemovals(contractsDir, removedOperations, removedEvents)],
    };
}

/**
 * Decide whether removed operations and events may go.
 *
 * Only reached when something was actually removed — an app that removes
 * nothing never needs a usage file to exist. A removed event is judged exactly
 * as a removed operation, against the usage file's `events` list.
 */
function judgeRemovals(contractsDir: string, removedOperations: string[], removedEvents: string[]): ContractViolation[]
{
    const removed = [...removedOperations, ...removedEvents];

    if (removed.length === 0)
    {
        return [];
    }

    const usage = readUsageRecords(usageDir(contractsDir));

    if (!usage.decidable)
    {
        return [{
            kind: 'usage.undecidable',
            detail:
                `${removed.join(', ')} would be removed, but no released client's usage list could be read `
                + `(${usage.reason}). Not knowing who uses it is not the same as knowing nobody does.`,
        }];
    }

    return [
        ...removedOperations.flatMap(operation => stillUsed(
            { kind: 'usage.still-called', operation },
            'still called by',
            callersOf(operation, usage.records),
        )),
        ...removedEvents.flatMap(event => stillUsed(
            { kind: 'usage.still-subscribed', event },
            'still subscribed to by',
            subscribersOf(event, usage.records),
        )),
    ];
}

/** One violation naming every released client still using a removed name, or none. */
function stillUsed(
    subject: Pick<ContractViolation, 'kind' | 'operation' | 'event'>,
    verb: string,
    users: UsageRecord[],
): ContractViolation[]
{
    if (users.length === 0)
    {
        return [];
    }

    return [{
        ...subject,
        detail: `${verb} ${users.map(user => `${user.platform} ${user.appVersion}`).join(', ')}`,
    }];
}

/** Render violations as the message a failing build prints. */
export function formatViolations(violations: ContractViolation[]): string
{
    return violations
        .map((violation) =>
        {
            const where = [violation.operation ?? violation.event, violation.location].filter(Boolean).join(' ');

            return `  - [${violation.kind}]${where ? ` ${where}` : ''}: ${violation.detail}`;
        })
        .join('\n');
}
