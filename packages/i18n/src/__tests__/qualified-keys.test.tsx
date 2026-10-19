// @vitest-environment jsdom
/**
 * A translator over qualified keys — `getT(locale)` on the server, `useT()` in
 * a client component — whose keys carry their namespace up to the first dot.
 *
 * | #  | call                                          | catalog state                                       | expected                                                         |
 * |----|-----------------------------------------------|-----------------------------------------------------|------------------------------------------------------------------|
 * | 1  | `t('network.reconnecting')`, server and client | present in the requested locale                     | the requested locale's text                                      |
 * | 2  | same, server                                  | only in the fallback locale                         | the fallback locale's text                                       |
 * | 3  | same                                          | in neither                                          | returns `'network.reconnecting'`; `onMissingKey` called once with it |
 * | 4  | `t('workspace.session.ended.allow')`          | `workspace` holds key `session.ended.allow`         | that text                                                        |
 * | 5  | `t('reconnecting')` — no dot                  | any                                                 | as row 3                                                         |
 * | 6  | `t('billing.total')`                          | no `billing` namespace                              | as row 3                                                         |
 * | 7  | `t('cart.count', { n: 3 })`                   | present / absent                                    | variables interpolated into the text / into the returned key     |
 * | 8  | client `useT()`                               | the namespace was not given to the provider         | as row 3                                                         |
 * | 9  | server, requested locale equals the fallback  | absent                                              | no fallback lookup; as row 3                                     |
 * | 10 | client re-render                              | `messages` and `onMissingKey` identity unchanged    | the same translator function object                              |
 *
 * Rows T1–T5 (types) live in `types.test.ts`.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useT } from '../client';
import type { LocaleCatalogs, NamespacedMessages, Translator } from '../index';
import { configureI18n, getT } from '../server';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalogs: LocaleCatalogs = {
    en: {
        network: { reconnecting: 'Reconnecting…', offline: 'Offline' },
        cart: { count: '{n} items' },
    },
    ko: {
        network: { reconnecting: '다시 연결하는 중…' },
        workspace: { 'session.ended.allow': '세션을 끝낼 수 있습니다' },
    },
};

let onMissingKey: ReturnType<typeof vi.fn<(key: string) => void>>;

function expectMiss(t: Translator, key: string): void
{
    expect(t(key)).toBe(key);
    expect(onMissingKey).toHaveBeenCalledTimes(1);
    expect(onMissingKey).toHaveBeenCalledWith(key);
}

describe('getT(locale)', () =>
{
    beforeEach(() =>
    {
        onMissingKey = vi.fn();
        configureI18n({ catalogs, fallbackLocale: 'en', onMissingKey });
    });

    it('1 server: answers from the requested locale', () =>
    {
        expect(getT('ko')('network.reconnecting')).toBe('다시 연결하는 중…');
    });

    it('2 server: answers from the fallback locale when the requested one lacks the key', () =>
    {
        expect(getT('ko')('network.offline')).toBe('Offline');
        expect(onMissingKey).not.toHaveBeenCalled();
    });

    it('3 returns and reports the whole key neither locale answers', () =>
    {
        configureI18n({ catalogs: { en: {}, ko: {} }, fallbackLocale: 'en', onMissingKey });

        expectMiss(getT('ko'), 'network.reconnecting');
    });

    it('4 splits at the first dot, so the key in the namespace may hold dots', () =>
    {
        expect(getT('ko')('workspace.session.ended.allow')).toBe('세션을 끝낼 수 있습니다');
    });

    it('5 treats a key with no dot as a miss of the whole key', () =>
    {
        expectMiss(getT('ko'), 'reconnecting');
    });

    it('6 treats an unknown namespace as a miss of the whole key', () =>
    {
        expectMiss(getT('ko'), 'billing.total');
    });

    it('7 interpolates variables into the text, and into the returned key on a miss', () =>
    {
        expect(getT('ko')('cart.count', { n: 3 })).toBe('3 items');
        expect(getT('ko')('cart.{n}', { n: 3 })).toBe('cart.3');
    });

    it('9 skips the fallback lookup when the requested locale is the fallback locale', () =>
    {
        const reads: string[] = [];
        const counted = new Proxy(catalogs, {
            get: (target, locale: string) =>
            {
                reads.push(locale);

                return target[locale];
            },
        });

        configureI18n({ catalogs: counted, fallbackLocale: 'en', onMissingKey });

        expectMiss(getT('en'), 'network.missing');
        expect(reads).toEqual(['en']);
    });
});

function Banner({ messageKey, seen }: { messageKey: string; seen?: Translator[] })
{
    const t = useT();
    seen?.push(t);

    return <span>{t(messageKey)}</span>;
}

describe('useT()', () =>
{
    const messages: NamespacedMessages = { network: { reconnecting: '다시 연결하는 중…' } };

    beforeEach(() =>
    {
        onMissingKey = vi.fn();
    });

    function renderBanner(messageKey: string): string
    {
        return renderToStaticMarkup(
            <I18nProvider locale="ko" messages={messages} onMissingKey={onMissingKey}>
                <Banner messageKey={messageKey} />
            </I18nProvider>,
        );
    }

    it('1 client: answers from the provider\'s messages', () =>
    {
        expect(renderBanner('network.reconnecting')).toBe('<span>다시 연결하는 중…</span>');
        expect(onMissingKey).not.toHaveBeenCalled();
    });

    it('8 client: a namespace the provider was not given is a miss of the whole key', () =>
    {
        expect(renderBanner('workspace.title')).toBe('<span>workspace.title</span>');
        expect(onMissingKey).toHaveBeenCalledTimes(1);
        expect(onMissingKey).toHaveBeenCalledWith('workspace.title');
    });

    describe('re-rendered', () =>
    {
        let root: Root;

        beforeEach(() =>
        {
            root = createRoot(document.createElement('div'));
        });

        afterEach(() =>
        {
            act(() => root.unmount());
        });

        it('10 client: keeps the same translator while messages and onMissingKey keep their identity', async () =>
        {
            const seen: Translator[] = [];

            for (const messageKey of ['network.reconnecting', 'network.offline'])
            {
                await act(async () =>
                {
                    root.render(
                        <I18nProvider locale="ko" messages={messages} onMissingKey={onMissingKey}>
                            <Banner messageKey={messageKey} seen={seen} />
                        </I18nProvider>,
                    );
                });
            }

            expect(seen).toHaveLength(2);
            expect(seen[1]).toBe(seen[0]);
        });
    });
});
