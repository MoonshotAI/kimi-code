import type { InjectionKey } from 'vue';
import type { ShortcutActionId } from '../../shared/action-ids';

export const OpenShortcutSettingsKey: InjectionKey<(action: ShortcutActionId) => void> = Symbol('open-shortcut-settings');
