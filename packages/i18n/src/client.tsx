import {
    createContext,
    useContext,
    useMemo,
    type ReactNode,
} from 'react';
// The client entry is bundled separately, so this import must survive into
// dist/client.d.ts as an import from the package root. Inlined copies of
// I18nTypeRegistry would be a different declaration, and an application's
// `declare module '@spfn/i18n'` would then never reach useT.
import {
    createQualifiedTranslator,
    createTranslator,
    type MessageKey,
    type Namespace,
    type NamespacedMessages,
    type QualifiedKey,
    type Translator,
} from './index.js';

export interface I18nProviderProps
{
    locale: string;
    messages: NamespacedMessages;
    children: ReactNode;

    /** Reports a key the provided messages do not answer. */
    onMissingKey?: (key: string) => void;
}

interface I18nContextValue
{
    locale: string;
    messages: NamespacedMessages;
    onMissingKey?: (key: string) => void;
}

const defaultContext: I18nContextValue = {
    locale: 'en',
    messages: {},
};

const I18nContext = createContext<I18nContextValue>(defaultContext);

/** Makes a resolved locale and its namespaced messages available to hooks. */
export function I18nProvider({ locale, messages, children, onMissingKey }: I18nProviderProps)
{
    const value = useMemo(
        () => ({ locale, messages, onMissingKey }),
        [locale, messages, onMissingKey],
    );

    return (
        <I18nContext.Provider value={value}>
            {children}
        </I18nContext.Provider>
    );
}

/**
 * Returns a memoized translator over qualified keys (`namespace.key`). Only
 * the namespaces given to the provider are found.
 */
export function useT(): Translator<QualifiedKey>;

/** Returns a memoized translator for one namespace. */
export function useT<N extends Namespace>(namespace: N): Translator<MessageKey<N>>;

export function useT(namespace?: string): Translator
{
    const { messages, onMissingKey } = useContext(I18nContext);

    return useMemo(
        () => namespace === undefined
            ? createQualifiedTranslator(messages, undefined, { onMissingKey })
            : createTranslator(messages[namespace] ?? {}, undefined, { onMissingKey }),
        [messages, namespace, onMissingKey],
    );
}

/** Returns the locale supplied by the closest provider. */
export function useLocale(): string
{
    return useContext(I18nContext).locale;
}
