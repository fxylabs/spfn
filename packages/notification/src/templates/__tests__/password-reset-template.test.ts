/**
 * password-reset template (row N1)
 *
 * The mail @spfn/auth's reset flow sends. It has to be registered under the name
 * the service asks for, render all three parts from `appName`, `confirmUrl` and
 * `expiresInMinutes`, and say plainly that ignoring it changes nothing — the
 * only reassurance available to someone who did not ask for it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { passwordResetTemplate } from '../builtin';
import { getTemplate, getTemplateNames, renderTemplate } from '../index';
import { registerBuiltinTemplates } from '../index';

const DATA = {
    appName: 'Acme',
    confirmUrl: 'https://app.example.com/password/reset?token=abc',
    expiresInMinutes: 30,
};

describe('password-reset template', () =>
{
    beforeAll(() =>
    {
        registerBuiltinTemplates();
    });

    it('row N1: is listed in the builtin index and the registry', () =>
    {
        expect(passwordResetTemplate.name).toBe('password-reset');
        expect(passwordResetTemplate.channels).toEqual(['email']);
        expect(getTemplateNames()).toContain('password-reset');
        expect(getTemplate('password-reset')).toBe(passwordResetTemplate);
    });

    it('row N1: renders subject, html and text from its three variables', () =>
    {
        const { email } = renderTemplate('password-reset', DATA);

        expect(email!.subject).toBe('[Acme] Choose a new password');

        for (const part of [email!.html!, email!.text!])
        {
            expect(part).toContain(DATA.confirmUrl);
            expect(part).toContain('30 minutes');
            expect(part).toContain('Choose a new password');
            expect(part).toContain('your password has not changed');
        }
    });

    it('row N1: leaves no placeholder unfilled', () =>
    {
        const { email } = renderTemplate('password-reset', DATA);

        expect(email!.subject).not.toMatch(/\{\{/);
        expect(email!.html).not.toMatch(/\{\{/);
        expect(email!.text).not.toMatch(/\{\{/);
    });
});
