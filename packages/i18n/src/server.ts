import {
    createQualifiedTranslator,
    createTranslator,
    type LocaleCatalogs,
    type MessageKey,
    type Messages,
    type Namespace,
    type NamespacedMessages,
    type QualifiedKey,
    type Translator,
} from './index';

export interface I18nConfiguration
{
    catalogs: LocaleCatalogs;
    fallbackLocale?: string;

    /** Reports a key that neither the locale nor the fallback locale answers. */
    onMissingKey?: (key: string) => void;
}

let catalogs: LocaleCatalogs = {};
let fallbackLocale = 'en';
let onMissingKey: ((key: string) => void) | undefined;

/**
 * Configures the process-wide catalog registry used by the server helpers.
 * Applications typically call this once during startup.
 */
export function configureI18n(configuration: I18nConfiguration): void
{
    catalogs = configuration.catalogs;
    fallbackLocale = configuration.fallbackLocale ?? 'en';
    onMissingKey = configuration.onMissingKey;
}

function resolveLocale(locale: string): {
    primary: NamespacedMessages;
    fallback?: NamespacedMessages;
}
{
    const primary = catalogs[locale] ?? {};
    const fallback = locale === fallbackLocale
        ? undefined
        : catalogs[fallbackLocale];

    return { primary, fallback };
}

function resolveNamespace(locale: string, namespace: string): {
    primary: Messages;
    fallback?: Messages;
}
{
    const { primary, fallback } = resolveLocale(locale);

    return { primary: primary[namespace] ?? {}, fallback: fallback?.[namespace] };
}

/** Creates a translator over qualified keys (`namespace.key`) for server components and handlers. */
export function getT(locale: string): Translator<QualifiedKey>;

/** Creates a namespace-scoped translator for server components and handlers. */
export function getT<N extends Namespace>(namespace: N, locale: string): Translator<MessageKey<N>>;

export function getT(namespaceOrLocale: string, locale?: string): Translator
{
    if (locale === undefined)
    {
        const { primary, fallback } = resolveLocale(namespaceOrLocale);

        return createQualifiedTranslator(primary, fallback, { onMissingKey });
    }

    const { primary, fallback } = resolveNamespace(locale, namespaceOrLocale);

    return createTranslator(primary, fallback, { onMissingKey });
}

/**
 * Returns serializable messages for client hydration. Fallback messages are
 * merged first so locale-specific messages take precedence.
 */
export function getClientMessages(locale: string, namespaces: string[]): NamespacedMessages
{
    const messages: NamespacedMessages = {};

    for (const namespace of namespaces)
    {
        const { primary, fallback } = resolveNamespace(locale, namespace);
        messages[namespace] = { ...fallback, ...primary };
    }

    return messages;
}
