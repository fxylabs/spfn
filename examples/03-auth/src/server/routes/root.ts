/**
 * Root Route: GET /
 *
 * Welcome page for SPFN API
 */

import { route } from '@spfn/core/route';

export const getRoot = route.get('/')
    .handler(async (c) =>
    {
        return {
            name: 'SPFN API',
            version: '1.0.0',
            status: 'running',
            endpoints: {
                health: '/health',
                examples: '/examples',
            },
            message: 'Welcome to SPFN! Visit /examples for usage examples.',
        };
    });
