/**
 * Ops Routes: the CLI-first operations surface
 *
 * Operations are developed exactly like features — as routes — built with
 * `opsRoute`, which applies the /_ops namespace so each definition carries
 * only the path this app owns. createOpsRouter injects opsTokenAuth into
 * every route and serves GET /_ops/_manifest for the `spfn ops` CLI to
 * discover commands from.
 *
 * Try it against a running server:
 *
 *   spfn ops token issue --name demo --scopes 'example:read'
 *   spfn ops list --app http://localhost:8790 --token <token>
 *   spfn ops call countExamples --app http://localhost:8790 --token <token>
 */

import { createOpsRouter, opsRoute } from '@spfn/core/ops';
import { opsTokenAuth, requireOpsScope } from '@spfn/auth/server';
import { Type } from '@sinclair/typebox';
import { ExampleRepository } from '../repositories/example.repository';

const exampleRepo = new ExampleRepository();

/**
 * GET /_ops/examples/count - how many examples exist
 */
const countExamples = opsRoute.get('/examples/count')
    .use([requireOpsScope('example:read')])
    .handler(async () =>
    {
        return { count: await exampleRepo.countAll() };
    });

/**
 * GET /_ops/examples - recent examples, ops view
 */
const listRecentExamples = opsRoute.get('/examples')
    .use([requireOpsScope('example:read')])
    .input({
        query: Type.Object({
            limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        }),
    })
    .handler(async (c) =>
    {
        const { query } = await c.data();

        return { items: await exampleRepo.findAll(query.limit ?? 10, 0) };
    });

export const opsRouter = createOpsRouter({
    countExamples,
    listRecentExamples,
}, { auth: opsTokenAuth });
