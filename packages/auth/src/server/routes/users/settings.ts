/**
 * @spfn/auth - Per-person settings routes (fxylabs/spfn#161)
 *
 * Self-only: the person is always the authenticated caller, never a path
 * segment, so no request can name somebody else's settings.
 */

import { Type } from '@sinclair/typebox';
import { defineRouter, route } from '@spfn/core/route';
import { getAuth } from '../../helpers';
import { authenticate } from '../../middleware';
import { getUserSetting, listUserSettings, resetUserSetting, setUserSetting } from '../../services';

const SettingKeyParams = Type.Object({
    key: Type.String({ minLength: 1, maxLength: 120, description: 'A declared setting key, e.g. locale or notifications.digest' }),
});

/**
 * GET /_auth/users/settings
 * Every declared setting of the caller, built-ins included, with whether each
 * is still its default
 */
export const listSettings = route.get('/_auth/users/settings')
    .use([authenticate])
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);

        return { settings: await listUserSettings(userId) };
    });

/**
 * GET /_auth/users/settings/:key
 * One setting of the caller; the default when they never set it
 *
 * @throws UserSettingNotDeclaredError (404) when the key is not declared
 */
export const getSetting = route.get('/_auth/users/settings/:key')
    .input({ params: SettingKeyParams })
    .use([authenticate])
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);
        const { params } = await c.data();

        return { key: params.key, value: await getUserSetting(userId, params.key) };
    });

/**
 * PUT /_auth/users/settings/:key
 * Write one setting of the caller; the default deletes the stored row
 *
 * @throws UserSettingNotDeclaredError (404) when the key is not declared
 * @throws ValidationError (400) when the value fails the key's schema
 */
export const setSetting = route.put('/_auth/users/settings/:key')
    .input({
        params: SettingKeyParams,
        body: Type.Object({
            value: Type.Unknown({ description: 'The new value; checked against the key\'s declared schema' }),
        }),
    })
    .use([authenticate])
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);
        const { params, body } = await c.data();

        return { key: params.key, value: await setUserSetting(userId, params.key, body.value, { by: userId }) };
    });

/**
 * DELETE /_auth/users/settings/:key
 * Return one setting of the caller to its default
 *
 * @throws UserSettingNotDeclaredError (404) when the key is not declared
 */
export const resetSetting = route.delete('/_auth/users/settings/:key')
    .input({ params: SettingKeyParams })
    .use([authenticate])
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);
        const { params } = await c.data();

        await resetUserSetting(userId, params.key);

        return c.noContent();
    });

export const userSettingsRouter = defineRouter({
    listSettings,
    getSetting,
    setSetting,
    resetSetting,
});
