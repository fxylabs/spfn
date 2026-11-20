/**
 * CMS App Router
 *
 * 모든 CMS 라우트를 통합하는 메인 라우터
 */

import { Type } from '@sinclair/typebox';
import { defineRouter, route } from '@spfn/core/route';
import { cmsPublishedCacheRepository } from '../repositories';
import {
    getSectionLabelsRoute,
    saveSectionDraftRoute,
    publishSectionRoute,
    resetSectionDraftRoute,
} from './admin.routes';

export const getLabelCache = route.get('/_cms/labels/cache')
    .skip(['auth'])
    .input({
        query: Type.Object({
            sections: Type.Array(Type.String()),
            locale: Type.Optional(Type.String()),
        }),
    })
    .handler(async (c) =>
    {
        const { query } = await c.data();
        const { sections, locale = 'en' } = query;

        // 단일 쿼리로 모든 섹션 조회 (N+1 방지)
        const results = await cmsPublishedCacheRepository.findBySections(sections, locale);

        // Record<section, content> 형태로 변환
        return results.reduce((acc, item) => 
        {
            acc[item.section] = item.content;

            return acc;
        }, {} as Record<string, any>);
    });

/**
 * `defineRouter`, because a client addresses these routes by name: this package
 * calls `api.getLabelCache.call(...)` itself, from `src/index.ts`. The name is
 * resolved in the app's route map, which carries the routes of every package
 * router the app mounts with `.packages()` — so `defineRouter` is what puts
 * these there, and what makes an app route of the same name a collision the
 * app's build refuses instead of a call that silently reaches the app's route.
 */
export const cmsAppRouter = defineRouter({
    getLabelCache,
    // Admin routes
    getSectionLabels: getSectionLabelsRoute,
    saveSectionDraft: saveSectionDraftRoute,
    publishSection: publishSectionRoute,
    resetSectionDraft: resetSectionDraftRoute,
});

export type AppRouter = typeof cmsAppRouter;

// Re-export admin router for standalone use
export { cmsAdminRouter } from './admin.routes';
export type { CmsAdminRouter } from './admin.routes';
