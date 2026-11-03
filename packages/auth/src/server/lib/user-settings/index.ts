/**
 * @spfn/auth - Per-person settings declared in code (fxylabs/spfn#161)
 */

export { defineUserSettings, type UserSettingsDeclaration } from './define';
export {
    isIanaTimeZone,
    type UserSettingEntry,
    type UserSettingView,
    type SetUserSettingOptions,
} from './registry';
