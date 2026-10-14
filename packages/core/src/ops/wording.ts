import type { SurfaceWording } from '../surface/wording';

/** The ops surface's refusals keep the words they had before surfaces existed. */
export const OPS_WORDING: SurfaceWording = {
    noun: 'ops',
    builder: '`opsRoute`',
    factory: 'createOpsRouter',
};
