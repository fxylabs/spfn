/**
 * @spfn/auth ↔ @spfn/mcp wiring (design #93 v2, case table 8e, last row)
 *
 * Two lines connect the authorization server to an MCP endpoint, and both of
 * them live in someone else's application:
 *
 * ```typescript
 * import { verifyAccessToken } from '@spfn/auth/server';
 * createMcpRoute({ validateToken: verifyAccessToken, ... });
 * ```
 *
 * Nothing in either package's own suite compiles that line, so it is compiled
 * here — `verifyAccessToken`'s signature and `@spfn/mcp`'s `validateToken` type
 * are declared in different repositories' worth of code, and a return type that
 * drifted (a `null` the adapter would not accept, an `expiresAt` in the wrong
 * unit) would be found by an adopter and not by us.
 *
 * `@spfn/mcp` is a **devDependency of this package and nothing more**. An
 * application that does not serve MCP must not acquire it, so the import below
 * exists only under `src/__tests__` — and the dependency points one way, which
 * is what keeps the workspace graph acyclic.
 *
 * No server is started and no token is verified: what is under test is that the
 * call type-checks and constructs.
 */

import { describe, it, expect } from 'vitest';

import { createMcpRoute } from '@spfn/mcp/server';

import { verifyAccessToken, type VerifiedOAuth2AccessToken } from '../../server/services/oauth2-access-token.service';

/** The application's own context, resolved from the principal the token names. */
interface AppContext
{
    userId: number;
}

describe('createMcpRoute({ validateToken: verifyAccessToken })', () =>
{
    it('type-checks and constructs with verifyAccessToken as the token validator', () =>
    {
        const router = createMcpRoute<VerifiedOAuth2AccessToken, AppContext>({
            appUrl: 'https://api.example.com',
            serverInfo: { name: 'example-app', version: '1.0.0' },
            scopesSupported: ['mcp:read', 'mcp:write'],
            validateToken: verifyAccessToken,
            resolveContext: async auth => ({ userId: Number(auth.userId) }),
            listTools: () => [],
        });

        expect(router).toBeDefined();
    });

    it('accepts verifyAccessToken with the Auth type inferred from it', () =>
    {
        // No type argument: the adapter infers `Auth` from `validateToken`, which
        // is how an adopter writes it and the shape a drift would break first.
        const router = createMcpRoute({
            appUrl: 'https://api.example.com',
            serverInfo: { name: 'example-app', version: '1.0.0' },
            validateToken: verifyAccessToken,
            resolveContext: async auth => ({ clientId: auth.clientId, scopes: auth.scopes }),
            listTools: () => [],
        });

        expect(router).toBeDefined();
    });
});
