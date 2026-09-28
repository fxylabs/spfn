/**
 * @spfn/notification - Template Registry
 */

import type {
    TemplateDefinition,
    TemplateData,
    RenderedTemplate,
    EmailTemplateContent,
    SmsTemplateContent,
    SlackTemplateContent,
    LocaleTemplateContent,
} from './types';
import type { NotificationChannel } from '../channels/types';
import { render } from './renderer';
import { getAppName } from '../config';

/**
 * Template registry storage
 */
const templates = new Map<string, TemplateDefinition>();

/**
 * Register a template
 */
export function registerTemplate(template: TemplateDefinition): void
{
    templates.set(template.name, template);
}

/**
 * Get template by name
 */
export function getTemplate(name: string): TemplateDefinition | undefined
{
    return templates.get(name);
}

/**
 * Check if template exists
 */
export function hasTemplate(name: string): boolean
{
    return templates.has(name);
}

/**
 * Check if template supports a channel
 */
export function templateSupportsChannel(name: string, channel: NotificationChannel): boolean
{
    const template = templates.get(name);
    if (!template) return false;

    return template.channels.includes(channel);
}

/**
 * Render template with data
 */
export function renderTemplate(
    name: string,
    data: TemplateData,
    channel?: NotificationChannel,
    locale?: string,
): RenderedTemplate
{
    const template = templates.get(name);
    if (!template)
    {
        throw new Error(`Template not found: ${name}`);
    }

    // Add default data
    const fullData: TemplateData = {
        appName: getAppName(),
        ...data,
    };

    const result: RenderedTemplate = {};

    // Render email if requested or no specific channel
    const email = (!channel || channel === 'email') ? resolveTemplateContent(template, 'email', locale).content : undefined;

    if (email)
    {
        result.email = renderEmailTemplate(email, fullData);
    }

    // Render SMS if requested or no specific channel
    const sms = (!channel || channel === 'sms') ? resolveTemplateContent(template, 'sms', locale).content : undefined;

    if (sms)
    {
        result.sms = renderSmsTemplate(sms, fullData);
    }

    // Render Slack if requested or no specific channel
    const slack = (!channel || channel === 'slack') ? resolveTemplateContent(template, 'slack', locale).content : undefined;

    if (slack)
    {
        result.slack = renderSlackTemplate(slack, fullData);
    }

    return result;
}

type ContentChannel = keyof LocaleTemplateContent;

/**
 * Locale tags to try, most specific first: `ko-KR` → `ko` → the template's
 * default.
 */
function localeCandidates(template: TemplateDefinition, locale?: string): string[]
{
    const candidates: string[] = [];

    if (locale)
    {
        candidates.push(locale);

        const base = locale.split('-')[0];

        if (base !== locale)
        {
            candidates.push(base);
        }
    }

    if (template.defaultLocale)
    {
        candidates.push(template.defaultLocale);
    }

    return candidates;
}

function findLocaleKey(template: TemplateDefinition, tag: string): string | undefined
{
    const wanted = tag.toLowerCase();

    return Object.keys(template.locales ?? {}).find(key => key.toLowerCase() === wanted);
}

/**
 * The content a template has for one channel in the requested locale, and
 * the locale it came from (undefined for the template's unlocalised content).
 */
export function resolveTemplateContent<C extends ContentChannel>(
    template: TemplateDefinition,
    channel: C,
    locale?: string,
): { content?: LocaleTemplateContent[C]; locale?: string }
{
    for (const candidate of localeCandidates(template, locale))
    {
        const key = findLocaleKey(template, candidate);
        const content = key ? template.locales![key][channel] : undefined;

        if (content)
        {
            return { content, locale: key };
        }
    }

    return { content: template[channel] };
}

/**
 * Render one channel of a template in a locale.
 *
 * `content` is undefined when a template without `locales` has no content
 * for the channel: the caller keeps its own params, as before locales
 * existed. A template with `locales` that has nothing for the channel in any
 * candidate locale is an error rather than an empty send.
 */
export function renderTemplateChannel<C extends ContentChannel>(
    name: string,
    data: TemplateData,
    channel: C,
    locale?: string,
): { content?: LocaleTemplateContent[C]; locale?: string } | { error: string }
{
    const template = templates.get(name);

    if (!template)
    {
        return { error: `Template not found: ${name}` };
    }

    const resolved = resolveTemplateContent(template, channel, locale);

    if (!resolved.content)
    {
        return template.locales
            ? { error: `Template ${name} has no ${channel} content for locale ${locale ?? '(none)'}` }
            : {};
    }

    const fullData: TemplateData = { appName: getAppName(), ...data };
    const renderers = {
        email: renderEmailTemplate,
        sms: renderSmsTemplate,
        slack: renderSlackTemplate,
    } as Record<ContentChannel, (content: never, data: TemplateData) => unknown>;

    return {
        content: renderers[channel](resolved.content as never, fullData) as LocaleTemplateContent[C],
        locale: resolved.locale,
    };
}

/**
 * Render email template
 */
function renderEmailTemplate(
    template: EmailTemplateContent,
    data: TemplateData,
): EmailTemplateContent
{
    return {
        subject: render(template.subject, data),
        // Escape interpolated values on the HTML path (caller data → markup injection).
        html: template.html ? render(template.html, data, { escape: true }) : undefined,
        text: template.text ? render(template.text, data) : undefined,
    };
}

/**
 * Render SMS template
 */
function renderSmsTemplate(
    template: SmsTemplateContent,
    data: TemplateData,
): SmsTemplateContent
{
    return {
        message: render(template.message, data),
    };
}

/**
 * Render Slack template
 */
function renderSlackTemplate(
    template: SlackTemplateContent,
    data: TemplateData,
): SlackTemplateContent
{
    return {
        text: template.text ? render(template.text, data) : undefined,
        blocks: template.blocks, // Blocks are not rendered (complex structure)
    };
}

/**
 * Get all registered template names
 */
export function getTemplateNames(): string[]
{
    return Array.from(templates.keys());
}

/**
 * Clear all templates (for testing)
 */
export function clearTemplates(): void
{
    templates.clear();
}
