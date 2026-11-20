import { describe, expect, it } from 'vitest';

import { functionMigrationsTable } from '../migration-status.js';

describe('functionMigrationsTable', () =>
{
    it('matches the per-package table naming of the migration runner', () =>
    {
        expect(functionMigrationsTable('@spfn/cms')).toBe('__spfn_fn_cms_migrations');
    });
});
