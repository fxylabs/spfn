/**
 * GitHub #113: templates with content per locale. One test per row of the
 * approved case table (L1-L10), on the resolver the channels render with.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerTemplate, clearTemplates, renderTemplateChannel } from '../registry';
import type { TemplateDefinition } from '../types';

const email = (subject: string) => ({ subject, text: subject });
const sms = (message: string) => ({ message });

function template(overrides: Partial<TemplateDefinition>): string
{
    registerTemplate({ name: 't', channels: ['email', 'sms'], ...overrides });

    return 't';
}

const subjectOf = (r: ReturnType<typeof renderTemplateChannel<'email'>>) => ('content' in r ? r.content?.subject : undefined);

beforeEach(() => clearTemplates());

describe('#113 locale resolution', () =>
{
    it('L1 exact locale', () =>
    {
        template({ locales: { ko: { email: email('안녕') }, en: { email: email('Hi') } }, defaultLocale: 'en' });

        const r = renderTemplateChannel('t', {}, 'email', 'ko');
        expect(subjectOf(r)).toBe('안녕');
        expect(r).toMatchObject({ locale: 'ko' });
    });

    it('L2 region tag falls back to its base language, not to the default', () =>
    {
        template({ locales: { ko: { email: email('안녕') }, en: { email: email('Hi') } }, defaultLocale: 'en' });

        expect(renderTemplateChannel('t', {}, 'email', 'ko-KR')).toMatchObject({ locale: 'ko' });
    });

    it('L3 region tag present: used before the base language', () =>
    {
        template({ locales: { 'ko-KR': { email: email('KR') }, ko: { email: email('ko') } } });

        expect(renderTemplateChannel('t', {}, 'email', 'ko-KR')).toMatchObject({ locale: 'ko-KR' });
    });

    it('L4 missing locale uses the default', () =>
    {
        template({ locales: { ko: { email: email('안녕') }, en: { email: email('Hi') } }, defaultLocale: 'en' });

        const r = renderTemplateChannel('t', {}, 'email', 'fr');
        expect(subjectOf(r)).toBe('Hi');
        expect(r).toMatchObject({ locale: 'en' });
    });

    it('L5 no default: unlocalised content, locale undefined', () =>
    {
        template({ locales: { ko: { email: email('안녕') } }, email: email('Plain') });

        const r = renderTemplateChannel('t', {}, 'email', 'fr');
        expect(subjectOf(r)).toBe('Plain');
        expect((r as { locale?: string }).locale).toBeUndefined();
    });

    it('L6 nothing to fall back to: an error, not an empty send', () =>
    {
        template({ locales: { ko: { email: email('안녕') } } });

        expect(renderTemplateChannel('t', {}, 'email', 'fr')).toEqual({ error: 'Template t has no email content for locale fr' });
    });

    it('L7 a locale without the channel falls through to one that has it', () =>
    {
        template({ locales: { ko: { email: email('안녕') }, en: { email: email('Hi'), sms: sms('Hi sms') } }, defaultLocale: 'en' });

        const r = renderTemplateChannel('t', {}, 'sms', 'ko');
        expect(r).toMatchObject({ content: { message: 'Hi sms' }, locale: 'en' });
    });

    it('L8 no locales, no locale requested: unlocalised content', () =>
    {
        template({ email: email('Plain') });

        expect(subjectOf(renderTemplateChannel('t', {}, 'email'))).toBe('Plain');
    });

    it('L9 no locale requested: the default', () =>
    {
        template({ locales: { ko: { email: email('안녕') }, en: { email: email('Hi') } }, defaultLocale: 'en' });

        expect(renderTemplateChannel('t', {}, 'email')).toMatchObject({ locale: 'en' });
    });

    it('L10 tags match case-insensitively and report the declared tag', () =>
    {
        template({ locales: { 'ko-KR': { email: email('KR') } } });

        expect(renderTemplateChannel('t', {}, 'email', 'KO-kr')).toMatchObject({ locale: 'ko-KR' });
    });

    it('a template without locales that lacks the channel keeps the caller params (no error)', () =>
    {
        template({ email: email('Plain') });

        expect(renderTemplateChannel('t', {}, 'sms', 'ko')).toEqual({});
    });

    it('variables and html escaping still apply to localised content', () =>
    {
        template({ locales: { ko: { email: { subject: '{{name}}님', html: '<p>{{name}}</p>' } } } });

        const r = renderTemplateChannel('t', { name: '<b>' }, 'email', 'ko');
        expect(r).toMatchObject({ content: { subject: '<b>님', html: '<p>&lt;b&gt;</p>' } });
    });

    it('an unknown template is an error', () =>
    {
        expect(renderTemplateChannel('nope', {}, 'email')).toEqual({ error: 'Template not found: nope' });
    });
});
