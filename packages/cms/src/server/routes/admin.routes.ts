/**
 * CMS Admin Routes
 *
 * 관리자용 라벨 관리 API
 */

import { Type } from '@sinclair/typebox';
import { defineRouter, route } from '@spfn/core/route';
import { authenticate, requireRole } from '@spfn/auth/server';
import {
    getSectionLabels,
    saveSectionDraft,
    publishSection,
    resetSectionDraft,
} from '../services/publish.service';

// These routes rewrite/publish site-wide CMS content, so they must be gated.
// Authenticate AND require an admin-tier role at the package level — do NOT rely on
// the consumer's global auth for authorization (fail closed). requireRole is an
// exact match, so both admin tiers are listed explicitly.
const ADMIN_GUARD = [authenticate, requireRole('admin', 'superadmin')];

/**
 * 섹션의 모든 라벨 조회 (테이블 뷰용)
 *
 * GET /_cms/admin/sections/:section/labels?locales=en,ko
 */
export const getSectionLabelsRoute = route.get('/_cms/admin/sections/:section/labels')
    .input({
        params: Type.Object({
            section: Type.String(),
        }),
        query: Type.Object({
            locales: Type.Optional(Type.String()), // comma-separated: "en,ko"
        }),
    })
    .use(ADMIN_GUARD)
    .handler(async (c) =>
    {
        const { params, query } = await c.data();
        const { section } = params;
        const locales = query.locales?.split(',') || ['en'];

        return getSectionLabels(section, locales);
    });

/**
 * 섹션 라벨 일괄 Draft 저장
 *
 * PUT /_cms/admin/sections/:section/draft
 */
export const saveSectionDraftRoute = route.put('/_cms/admin/sections/:section/draft')
    .input({
        params: Type.Object({
            section: Type.String(),
        }),
        body: Type.Object({
            labels: Type.Array(
                Type.Object({
                    id: Type.Number(),
                    values: Type.Record(Type.String(), Type.String()),
                }),
            ),
        }),
    })
    .use(ADMIN_GUARD)
    .handler(async (c) =>
    {
        const { params, body } = await c.data();
        const { section } = params;
        const { labels } = body;

        const result = await saveSectionDraft(section, labels);

        return { success: true, ...result };
    });

/**
 * 섹션 전체 발행
 *
 * POST /_cms/admin/sections/:section/publish
 */
export const publishSectionRoute = route.post('/_cms/admin/sections/:section/publish')
    .input({
        params: Type.Object({
            section: Type.String(),
        }),
        body: Type.Object({
            locales: Type.Array(Type.String()),
        }),
    })
    .use(ADMIN_GUARD)
    .handler(async (c) =>
    {
        const { params, body } = await c.data();
        const { section } = params;
        const { locales } = body;

        const result = await publishSection(section, locales);

        return { success: true, ...result };
    });

/**
 * 섹션 Draft 초기화
 *
 * DELETE /_cms/admin/sections/:section/draft
 */
export const resetSectionDraftRoute = route.delete('/_cms/admin/sections/:section/draft')
    .input({
        params: Type.Object({
            section: Type.String(),
        }),
    })
    .use(ADMIN_GUARD)
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const { section } = params;

        const result = await resetSectionDraft(section);

        return { success: true, ...result };
    });

/**
 * Admin Router
 */
export const cmsAdminRouter = defineRouter({
    getSectionLabels: getSectionLabelsRoute,
    saveSectionDraft: saveSectionDraftRoute,
    publishSection: publishSectionRoute,
    resetSectionDraft: resetSectionDraftRoute,
});

export type CmsAdminRouter = typeof cmsAdminRouter;
