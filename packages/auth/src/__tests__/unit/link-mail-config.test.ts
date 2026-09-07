/**
 * Link mail delivery mode (case table D, config rows).
 *
 * `SPFN_AUTH_LINK_MAIL_DELIVERY` decides whether the two link flows send their
 * mail from the request or from the `auth.link-mail` worker. A typo in it would
 * otherwise be read as "not queued" and quietly put every link back on the
 * request path, so it is declared as an enum and refused at the config layer —
 * row D6.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { envSchema } from '@spfn/auth/config';
import { getLinkMailDelivery } from '@/server/lib/link-mail-delivery';

const KEY = 'SPFN_AUTH_LINK_MAIL_DELIVERY';

describe('link mail delivery mode (case table D)', () =>
{
    afterEach(() =>
    {
        delete process.env[KEY];
    });

    it('row D6: an unknown value is refused rather than read as a default', () =>
    {
        process.env[KEY] = 'queue';

        expect(() => getLinkMailDelivery()).toThrow('Environment validation failed');
    });

    it('row D6: the refusal names the three values it accepts', () =>
    {
        expect(() => envSchema.SPFN_AUTH_LINK_MAIL_DELIVERY.validator!('queue'))
            .toThrow('Must be one of: auto, inline, queued');
    });

    it('unset is auto — an app that sets nothing keeps deciding by whether pg-boss is up', () =>
    {
        expect(getLinkMailDelivery()).toBe('auto');
    });

    it.each(['auto', 'inline', 'queued'])('%s is a valid mode', (mode) =>
    {
        process.env[KEY] = mode;

        expect(getLinkMailDelivery()).toBe(mode);
    });
});
