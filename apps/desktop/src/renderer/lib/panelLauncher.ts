
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { hasDesktopBridge } from '@moonshot-ai/app-core/lib';
import { panelLauncherOrder, panelRegistry, type PanelLauncherType } from '@moonshot-ai/app-client/panel';
import { resolvedBindingKeys } from '../composables/useShortcuts';
import { isTraceEnabled } from '@moonshot-ai/app-client/trace';

export function panelLauncherShortcutKeys(type: PanelLauncherType): string[] {
  switch (type) {
    case 'diff':
      return resolvedBindingKeys('openDiffTab');
    case 'browser':
      return ['mod', 't'];
    case 'term':
      return resolvedBindingKeys('toggleTerminal');
    case 'btw':
      return resolvedBindingKeys('toggleSideChat');
    case 'files':
      return resolvedBindingKeys('toggleFilesPanel');
    case 'inspector':
      return [];
  }
}

export interface PanelLauncherItem {
  type: PanelLauncherType;
  icon: string;
  label: string;
  keys: string[];
  disabled: boolean;
}

export function panelLauncherItems(
  canOpen: Record<Exclude<PanelLauncherType, 'inspector'>, boolean>,
  t: Translator,
): PanelLauncherItem[] {
  const desktop = hasDesktopBridge();
  const debug = isTraceEnabled();
  return panelLauncherOrder
    .filter((type) => desktop || (type !== 'browser' && type !== 'term'))
    .filter((type) => debug || type !== 'inspector')
    .map((type) => ({
      type,
      icon: panelRegistry[type].icon,
      label: t(panelRegistry[type].i18nKey),
      keys: desktop ? panelLauncherShortcutKeys(type) : [],
      disabled: type !== 'inspector' && !canOpen[type],
    }));
}
