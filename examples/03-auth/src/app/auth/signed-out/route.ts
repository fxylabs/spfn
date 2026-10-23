/**
 * /auth/signed-out — empties the session jar, then sends the browser to /login
 *
 * The landing for "the API refused your session": the next request arrives
 * anonymous instead of carrying a cookie the API keeps refusing.
 *
 * It is also the example's one route handler that imports
 * `@spfn/auth/nextjs/server`, so `next build` proves that entry bundles into a
 * route handler — the build broke there when the entry spelled
 * `next/navigation.js` (#151).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { clearSessionCookies } from '@spfn/auth/nextjs/server';

export function GET(request: NextRequest): NextResponse
{
    return clearSessionCookies(NextResponse.redirect(new URL('/login', request.url)), request);
}
