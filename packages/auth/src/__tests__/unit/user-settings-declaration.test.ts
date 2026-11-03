/**
 * @spfn/auth - defineUserSettings and the declaration registry (fxylabs/spfn#161)
 *
 * Rows S7 and S8 of the design's case table: a bad declaration throws when it
 * is declared, and a declaration installs once, before boot completes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineUserSettings } from '@/server/lib/user-settings';
import {
    __resetUserSettingsForTests,
    findUserSettingEntry,
    installUserSettings,
    isIanaTimeZone,
    sealUserSettings,
} from '@/server/lib/user-settings/registry';

const DIGEST = {
    key: 'unitDecl.digest',
    schema: Type.Union([Type.Literal('daily'), Type.Literal('off')]),
    default: 'daily',
} as const;

describe('defineUserSettings', () =>
{
    it('S7: a key declared twice throws at declaration', () =>
    {
        expect(() => defineUserSettings([DIGEST, DIGEST])).toThrow(/declared twice/);
    });

    it('S7: a default failing its own schema throws at declaration', () =>
    {
        expect(() => defineUserSettings([{ ...DIGEST, default: 'hourly' as never }])).toThrow(/does not pass its own schema/);
    });

    it.each(['locale', 'timezone'])('S7: redeclaring the built-in key %s throws at declaration', (key) =>
    {
        expect(() => defineUserSettings([{ key, schema: Type.String(), default: 'x' }])).toThrow(/built-in/);
    });

    it.each(['Digest', '1digest', 'a..b', 'a.', 'a-b', 'a_b', '.a', '', `a${'b'.repeat(120)}`])(
        'S7: the malformed key %j throws at declaration',
        (key) =>
        {
            expect(() => defineUserSettings([{ key, schema: Type.String(), default: 'x' }])).toThrow(/must match/);
        },
    );

    it('accepts dotted camelCase keys up to 120 characters', () =>
    {
        const key = `a${'b'.repeat(119)}`;

        expect(defineUserSettings([{ key, schema: Type.String(), default: 'x' }]).keys).toEqual([key]);
        expect(defineUserSettings([{ ...DIGEST, key: 'editor.lastTemplate2' }]).keys).toEqual(['editor.lastTemplate2']);
    });

    it('returns a frozen declaration listing its keys in order', () =>
    {
        const declaration = defineUserSettings([DIGEST, { key: 'unitDecl.other', schema: Type.Number(), default: 0 }]);

        expect(Object.isFrozen(declaration)).toBe(true);
        expect(declaration.keys).toEqual(['unitDecl.digest', 'unitDecl.other']);
    });
});

describe('the declaration registry', () =>
{
    afterEach(() =>
    {
        __resetUserSettingsForTests();
    });

    it('S8: a second install throws', () =>
    {
        installUserSettings(defineUserSettings([DIGEST]));

        expect(() => installUserSettings(defineUserSettings([DIGEST]))).toThrow(/already installed/);
    });

    it('S8: an install after boot completed throws', () =>
    {
        sealUserSettings();

        expect(() => installUserSettings(defineUserSettings([DIGEST]))).toThrow(/already initialized/);
    });

    it('without an install only the built-in keys resolve', () =>
    {
        expect(findUserSettingEntry('locale')?.default).toBeNull();
        expect(findUserSettingEntry('timezone')?.default).toBe('UTC');
        expect(findUserSettingEntry(DIGEST.key)).toBeUndefined();
    });

    it('an installed key resolves beside the built-ins', () =>
    {
        installUserSettings(defineUserSettings([DIGEST]));

        expect(findUserSettingEntry(DIGEST.key)?.default).toBe('daily');
    });
});

describe('isIanaTimeZone (D5)', () =>
{
    it.each(['UTC', 'Etc/UTC', 'Asia/Seoul', 'America/New_York', 'Asia/Kolkata', 'Asia/Calcutta'])('%s is accepted', (zone) =>
    {
        expect(isIanaTimeZone(zone)).toBe(true);
    });

    it.each(['Mars/Olympus', 'Not a zone', '+09:00', '', 42, null])('%j is refused', (zone) =>
    {
        expect(isIanaTimeZone(zone)).toBe(false);
    });
});
