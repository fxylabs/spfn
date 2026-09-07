/**
 * @spfn/notification - Template System
 */

export type {
    TemplateDefinition,
    TemplateData,
    RenderedTemplate,
    EmailTemplateContent,
    SmsTemplateContent,
    SlackTemplateContent,
} from './types';

export {
    registerTemplate,
    getTemplate,
    hasTemplate,
    templateSupportsChannel,
    renderTemplate,
    getTemplateNames,
    clearTemplates,
} from './registry';

export { render, registerFilter } from './renderer';

// Built-in templates
import { verificationCodeTemplate, welcomeTemplate, accountExistsTemplate, signupLinkTemplate, passwordResetTemplate } from './builtin';
import { registerTemplate } from './registry';

/**
 * Register all built-in templates
 */
export function registerBuiltinTemplates(): void
{
    registerTemplate(verificationCodeTemplate);
    registerTemplate(welcomeTemplate);
    registerTemplate(accountExistsTemplate);
    registerTemplate(signupLinkTemplate);
    registerTemplate(passwordResetTemplate);
}
