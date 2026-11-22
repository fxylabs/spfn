/**
 * The second half of `pnpm db:generate`: write `migrations/privileges.json`,
 * the app privileges of every @spfn/monitor table, from the entities'
 * `appPrivileges()` declarations. A generated file, never hand-edited;
 * src/__tests__/privileges-manifest.test.ts fails while it differs from the entities.
 */

import { join } from 'node:path';
import { writeAppPrivilegesManifest } from '@spfn/core/db';
import * as entities from '../src/server/entities';

writeAppPrivilegesManifest(join(import.meta.dirname, '..', 'migrations'), Object.values(entities));
