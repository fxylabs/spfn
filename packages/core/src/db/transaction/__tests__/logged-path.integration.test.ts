/**
 * The transaction context names a declared path prefix redacted (spfn/spfn#164)
 *
 * `Transactional()` names its transaction `<method> <path>`, and the runner
 * writes that context into every line it logs for it — started, committed,
 * rolled back, slow. The context is built from `loggedPath(c)`, the copy in
 * the built `@spfn/core/middleware` that `createServer` publishes the
 * declaration into, so the row declares it there.
 *
 * | #  | situation                                          | goes unnoticed without the row                                       |
 * | -- | -------------------------------------------------- | -------------------------------------------------------------------- |
 * | T4 | a `Transactional()` route under the prefix throws  | the rollback lines carrying the token through `db/transaction/middleware.ts` |
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@spfn/core/logger';
import { ErrorHandler, setRedactPaths } from '@spfn/core/middleware';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';
import { captureLoggerClass } from '../../../logger/__tests__/helpers/leak-probe';
import { Transactional } from '../middleware';

const SECRET = 'capability-token-1f3a9c';

describe('the transaction context under a redacted prefix', () =>
{
    const dbFixture = createDbTestFixture();

    beforeAll(async () =>
    {
        await dbFixture.setup();
    });

    afterAll(async () =>
    {
        await dbFixture.teardown();
    });

    afterEach(() =>
    {
        setRedactPaths(undefined);
        vi.restoreAllMocks();
    });

    it('T4: a route that throws inside Transactional() logs its rollback with the redacted path', async (ctx) =>
    {
        ctx.skip(!dbFixture.isAvailable, 'no database');
        setRedactPaths(['/api/import']);
        const { lines, output } = captureLoggerClass(Logger);

        const app = new Hono();
        app.onError(ErrorHandler({ includeStack: false }));
        app.get('/api/import/:token', Transactional({ slowThreshold: 0 }), () =>
        {
            throw new Error('import failed');
        });

        expect((await app.request(`/api/import/${SECRET}`)).status).toBe(500);

        const transactionLines = lines.filter(line => /^(Transaction|Slow transaction)/.test(line.message));
        expect(transactionLines.map(line => [line.level, line.message, line.context?.context])).toEqual([
            ['debug', 'Transaction started', 'GET /api/import/[redacted]'],
            ['warn', 'Slow transaction rolled back', 'GET /api/import/[redacted]'],
        ]);
        expect(output()).not.toContain(SECRET);
    });
});
