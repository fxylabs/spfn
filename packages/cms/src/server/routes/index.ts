/**
 * CMS App Router
 *
 * 모든 CMS 라우트를 통합하는 메인 라우터
 */

import { Type } from '@sinclair/typebox';
import { defineUnmappedRouter, route } from '@spfn/core/route';
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
 * `defineUnmappedRouter`, not `defineRouter`: this package publishes no route
 * map — its `.spfnrc.ts` runs the router generator only, and nothing here is
 * exported as one — so an app that mounts it with `.packages()` merges nothing
 * over its own map and cannot lose a name to it.
 */
export const cmsAppRouter = defineUnmappedRouter({
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
