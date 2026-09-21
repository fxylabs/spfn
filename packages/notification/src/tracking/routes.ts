/**
 * @spfn/notification - Tracking Routes
 *
 * HTTP endpoints for open pixel and click redirect.
 * These endpoints are accessed by email clients, so they skip auth.
 */

import { route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';
import { defineUnmappedRouter } from '@spfn/core/route';
import { verifyOpenToken, verifyClickToken, hashClickUrl } from './token';
import { recordOpenEvent, recordClickEvent } from './tracking.service';
import { logger } from '@spfn/core/logger';

const log = logger.child('@spfn/notification:tracking:routes');

/**
 * 1x1 transparent GIF pixel (minimal valid GIF89a)
 */
const TRANSPARENT_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
);

/**
 * Open tracking pixel endpoint
 *
 * Returns a 1x1 transparent GIF and records the open event.
 */
export const trackOpen = route.get('/_noti/t/o/:token')
    .input({
        params: Type.Object({
            token: Type.String(),
        }),
    })
    .skip(['auth'])
    .handler(async (c): Promise<Response> =>
    {
        const { params } = await c.data();
        const result = verifyOpenToken(params.token);

        if (result.valid && result.notificationId)
        {
            recordOpenEvent(result.notificationId, {
                ipAddress: c.raw.req.header('x-forwarded-for') ?? c.raw.req.header('x-real-ip'),
                userAgent: c.raw.req.header('user-agent'),
            });
        }
        else
        {
            log.warn('Invalid open tracking token');
        }

        // Always return the pixel (UX protection)
        return new Response(TRANSPARENT_GIF, {
            status: 200,
            headers: {
                'Content-Type': 'image/gif',
                'Content-Length': String(TRANSPARENT_GIF.length),
                'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
        });
    });

/**
 * Click tracking redirect endpoint
 *
 * Records the click event and redirects to the original URL.
 */
export const trackClick = route.get('/_noti/t/c/:token')
    .input({
        params: Type.Object({
            token: Type.String(),
        }),
        query: Type.Object({
            url: Type.String(),
        }),
    })
    .skip(['auth'])
    .handler(async (c): Promise<Response> =>
    {
        const { params, query } = await c.data();
        const targetUrl = query.url;
        const result = verifyClickToken(params.token);

        // Invalid token → do NOT redirect. The endpoint is .skip(['auth']), so
        // redirecting on an unverified token would make it an open redirect
        // (GET /_noti/t/c/<garbage>?url=https://evil.com).
        if (!result.valid || result.notificationId == null || result.linkIndex == null)
        {
            log.warn('Invalid click tracking token');

            return new Response('Not found', { status: 404 });
        }

        // Only http(s) destinations — block javascript:/data:/relative-protocol.
        let parsed: URL;
        try
        {
            parsed = new URL(targetUrl);
        }
        catch
        {
            return new Response('Not found', { status: 404 });
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        {
            return new Response('Not found', { status: 404 });
        }

        // New tokens bind the destination URL; reject a swapped target. Legacy
        // tokens (no urlHash) predate binding and are allowed through.
        if (result.urlHash && hashClickUrl(targetUrl) !== result.urlHash)
        {
            log.warn('Click URL does not match signed token');

            return new Response('Not found', { status: 404 });
        }

        recordClickEvent(result.notificationId, result.linkIndex, targetUrl, {
            ipAddress: c.raw.req.header('x-forwarded-for') ?? c.raw.req.header('x-real-ip'),
            userAgent: c.raw.req.header('user-agent'),
        });

        return new Response(null, {
            status: 302,
            headers: {
                'Location': targetUrl,
                'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
        });
    });

/**
 * Tracking router
 *
 * `defineUnmappedRouter`, not `defineRouter`: this package publishes no route
 * map — it has no codegen config and exports none — and these two endpoints are
 * reached by the URL baked into a sent email, never by name through the RPC
 * client. An app route sharing a name with one of them loses nothing to it.
 */
export const trackingRouter = defineUnmappedRouter({
    trackOpen,
    trackClick,
});
