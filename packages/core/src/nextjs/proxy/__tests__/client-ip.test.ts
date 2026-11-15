/**
 * clientIpFromForwardedChain — hop-aware client IP extraction (S-I6)
 */

import { describe, it, expect } from 'vitest';
import { clientIpFromForwardedChain } from '../helpers';

describe('clientIpFromForwardedChain', () =>
{
    it('takes the rightmost entry for a single trusted hop', () =>
    {
        expect(clientIpFromForwardedChain('203.0.113.9', 1)).toBe('203.0.113.9');
        expect(clientIpFromForwardedChain('203.0.113.9, 10.0.0.2', 1)).toBe('10.0.0.2');
    });

    it('counts trusted hops from the right (LB + nginx = 2)', () =>
    {
        // client, lb, nginx-appended → real client is 2 from the right
        expect(clientIpFromForwardedChain('203.0.113.9, 10.0.0.1', 2)).toBe('203.0.113.9');
    });

    it('ignores a client-prepended spoof', () =>
    {
        // attacker prepends 1.2.3.4; real infra appends the rest → still resolves the client
        expect(clientIpFromForwardedChain('1.2.3.4, 203.0.113.9, 10.0.0.1', 2)).toBe('203.0.113.9');
    });

    it('names no client when the chain is shorter than the declared hops', () =>
    {
        expect(clientIpFromForwardedChain('203.0.113.9', 3)).toBeUndefined();
    });

    it('returns undefined for empty/missing', () =>
    {
        expect(clientIpFromForwardedChain(undefined, 1)).toBeUndefined();
        expect(clientIpFromForwardedChain('', 1)).toBeUndefined();
        expect(clientIpFromForwardedChain('  ', 1)).toBeUndefined();
    });
});
