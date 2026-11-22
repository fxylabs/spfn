/**
 * @spfn/cms - the committed migrations/privileges.json against the entities
 *
 * The manifest is what `spfn db migrate` will read for this package's app
 * privileges (#405): the published package ships the file, not the entities'
 * source. A table added, or an `appPrivileges()` declaration changed, without
 * `pnpm db:generate` afterwards would ship the old privileges unnoticed; this
 * file compares the bytes instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderAppPrivilegesManifest } from '@spfn/core/db';

import * as entities from '../server/entities';

describe('migrations/privileges.json (run `pnpm db:generate` when this fails)', () =>
{
    it('is what the entities generate', () =>
    {
        expect(readFileSync(join(__dirname, '../../migrations/privileges.json'), 'utf8'))
            .toBe(renderAppPrivilegesManifest(Object.values(entities)));
    });
});
