/**
 * Where a Kit project keeps its generated state (unit 06 section 5.1).
 *
 *   .spfn/license.json                   committed — public IDs and URLs only
 *   .spfn/kit-lock.json                  committed — the installed state, unsigned; names its signed manifest by digest
 *   .spfn/operations/active.json         ignored  — the running operation
 *   .spfn/operations/history/<id>.json   ignored  — bounded local history
 *   .spfn/operations/operation.lock/     ignored  — the process lock directory
 *
 * Two of these are committed and four are not, and the split is the point: what
 * a clean clone needs to restore an exact release is committed, and what is
 * true only of one machine's run is not.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const KIT_STATE_DIR = '.spfn';

/**
 * The ignore rule that keeps one machine's run out of everyone's history.
 *
 * It lives in `.spfn/.gitignore` rather than the project's root file, for two
 * reasons. The root file belongs to the customer, and a Kit that edits it has
 * started editing customer source. And the rule has to hold whatever the
 * release's scaffold happens to ship: a release that forgot it would otherwise
 * commit an operation journal and a lock naming this machine's hostname and
 * process id — noise in the history, and a small fact about someone's laptop
 * published to everyone who clones the repository.
 */
export const OPERATIONS_IGNORE = [
    '# Written by `spfn kit`. One machine\'s run is not part of the project.',
    'operations/',
    '',
].join('\n');

export interface KitPaths
{
    /** The project root — the directory holding `.spfn`. */
    root: string;
    stateDir: string;
    licenseFile: string;
    lockFile: string;
    operationsDir: string;
    activeJournal: string;
    historyDir: string;
    lockDir: string;
    lockOwnerFile: string;
}

export function kitPaths(root: string): KitPaths
{
    const stateDir = join(root, KIT_STATE_DIR);
    const operationsDir = join(stateDir, 'operations');
    const lockDir = join(operationsDir, 'operation.lock');

    return {
        root,
        stateDir,
        licenseFile: join(stateDir, 'license.json'),
        lockFile: join(stateDir, 'kit-lock.json'),
        operationsDir,
        activeJournal: join(operationsDir, 'active.json'),
        historyDir: join(operationsDir, 'history'),
        lockDir,
        lockOwnerFile: join(lockDir, 'owner.json'),
    };
}

/**
 * Create the operations directory, ignored from the moment it exists.
 *
 * The order matters: the ignore file is written before the directory it covers
 * has anything in it, so there is no window where a commit could pick up an
 * operation journal that was about to be ignored.
 */
export function ensureOperationsDir(root: string): string
{
    const paths = kitPaths(root);
    const ignoreFile = join(paths.stateDir, '.gitignore');

    mkdirSync(paths.stateDir, { recursive: true });

    if (!existsSync(ignoreFile))
    {
        writeFileSync(ignoreFile, OPERATIONS_IGNORE, 'utf8');
    }

    mkdirSync(paths.operationsDir, { recursive: true });

    return paths.operationsDir;
}
