/**
 * @spfn/cms - The CMS routers under a router-level skipper (spfn/spfn#165)
 *
 * Every CMS route authenticates itself: the admin routes `.use([authenticate,
 * requireRole(...)])`, and `getLabelCache` is public (`.skip(['auth'])`). So
 * neither router states a `packageName`, and a skipper above them removes only
 * the inherited `auth` — each admin route runs its own in its place. If an admin
 * route ever lost its own `authenticate`, it would rely on the inherited one,
 * and the router would have to state `packageName`.
 */

import { describe, it, expect } from 'vitest';
import { defineMiddleware, defineRouter, resolveRouteMiddlewares } from '@spfn/core/route';
import { authenticate } from '@spfn/auth/server';
import { cmsAdminRouter, cmsAppRouter } from '../server/routes';

const SERVER = [{ name: 'auth', handler: authenticate.handler }];
const skipper = defineMiddleware('skipper', async (_c, next) => next(), { skips: ['auth'] });

/** The named middlewares of each route of `router` mounted as a plain entry under the skipper, by route name. */
function chainsUnderSkipper(router: typeof cmsAppRouter | typeof cmsAdminRouter): Record<string, string[]>
{
    return Object.fromEntries(resolveRouteMiddlewares(defineRouter({ cms: router }).use([skipper]), SERVER)
        .map(route => [route.name, route.middlewares.filter(mw => mw.name).map(mw => `${mw.source}:${mw.name}`)]));
}

describe('the CMS routers under a router-level skipper', () =>
{
    it('state no package name: their routes do not rely on the inherited auth', () =>
    {
        expect(cmsAppRouter._packageName).toBeNull();
        expect(cmsAdminRouter._packageName).toBeNull();
    });

    it('register as a plain entry under a skipper, and every admin route still runs its own auth', () =>
    {
        const admin = ['router:skipper', 'route:auth'];

        expect(chainsUnderSkipper(cmsAdminRouter)).toEqual({
            getSectionLabels: admin,
            saveSectionDraft: admin,
            publishSection: admin,
            resetSectionDraft: admin,
        });
        expect(chainsUnderSkipper(cmsAppRouter)).toEqual({
            getLabelCache: ['router:skipper'],
            getSectionLabels: admin,
            saveSectionDraft: admin,
            publishSection: admin,
            resetSectionDraft: admin,
        });
    });
});
