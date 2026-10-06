/**
 * Route contracts
 *
 * A contract is what a route promises to clients that are compiled and
 * deployed separately from the server. This module collects those promises from
 * a loaded router, writes them to `contracts/current.json`, and refuses a build
 * whose changes would break an already-released client.
 */

export { collectContractDocument, ContractCollectionError } from './collect';
export { compareDocuments, compareOperation } from './compare';
export type { DocumentComparison } from './compare';
export { checkContract, formatViolations } from './check';
export type { ContractCheckResult } from './check';
export {
    canonicalize,
    stableDigest,
    stableStringify,
    stableStringifyPretty,
} from './stable-json';
export {
    compareVersions,
    ContractSnapshotError,
    currentPath,
    CURRENT_FILENAME,
    listSnapshots,
    newestSnapshot,
    readCurrentDocument,
    readSnapshot,
    releasedDir,
    RELEASED_DIRNAME,
    usageDir,
    USAGE_DIRNAME,
    writeCurrentDocument,
    writeSnapshot,
} from './snapshot';
export type { SnapshotFile } from './snapshot';
export { callersOf, readUsageRecords, subscribersOf } from './usage';
export type { UsageReadResult, UsageRecord } from './usage';
export type {
    CompatibilityPolicy,
    ContractDocument,
    ContractEvent,
    ContractEvents,
    ContractOperation,
    ContractRequest,
    ContractSnapshot,
    ContractViolation,
    ContractViolationKind,
    JsonSchema,
} from './types';
