import { computed, ref, type Ref } from 'vue';
import type { PanelCloseAction } from '@moonshot-ai/app-client/panel';
import { registerBrowserOverlayMenu } from './browserOverlayMenu';

export interface PanelTabContextItem {
  id: string;
  icon: string;
  label: string;
  disabled?: boolean;
}

interface PanelContextMenuHandle {
  show: (x: number, y: number, trigger: HTMLElement | undefined, keyboard: boolean) => Promise<void>;
  close: () => void;
}

export function panelTabContextItems(
  t: (key: string) => string,
  options: { index: number; count: number; move?: 'right' | 'bottom' },
): PanelTabContextItem[] {
  const items: PanelTabContextItem[] = [
    { id: 'close', icon: 'close', label: t('panel.closeTab') },
    { id: 'close-others', icon: 'tab-close-others', label: t('panel.closeOthers'), disabled: options.count <= 1 },
    { id: 'close-to-right', icon: 'tab-close-right', label: t('panel.closeToRight'), disabled: options.index < 0 || options.index === options.count - 1 },
    { id: 'close-all', icon: 'tabs-close-all', label: t('panel.closeAll') },
  ];
  if (options.move === 'right') items.push({ id: 'move', icon: 'arrow-right', label: t('terminal.moveToRightPanel') });
  if (options.move === 'bottom') items.push({ id: 'move', icon: 'arrow-down', label: t('terminal.moveToBottomPanel') });
  return items;
}

const closeActions: Record<string, PanelCloseAction> = {
  'close': 'close',
  'close-others': 'others',
  'close-to-right': 'right',
  'close-all': 'all',
};

export function panelTabCloseAction(action: string): PanelCloseAction | undefined {
  return closeActions[action];
}

export function usePanelTabContextMenu(options: {
  id: string;
  items: (tabId: string | null) => PanelTabContextItem[];
  select: (action: string, tabId: string) => void;
  trigger: (tabId: string) => HTMLElement | undefined;
}): {
  menuRef: Ref<PanelContextMenuHandle | null>;
  items: Ref<PanelTabContextItem[]>;
  select: (action: string) => void;
  show: (tabId: string, x: number, y: number, keyboard?: boolean) => void;
  close: () => void;
} {
  const menuRef = ref<PanelContextMenuHandle | null>(null);
  const tabId = ref<string | null>(null);
  const items = computed(() => options.items(tabId.value));
  function select(action: string): void {
    if (tabId.value !== null) options.select(action, tabId.value);
  }
  const overlay = registerBrowserOverlayMenu({
    id: options.id, placement: 'bottom-start', offset: 0,
    items: () => items.value.map(item => ({ kind: 'item', ...item })),
    onSelect: select,
  });
  function show(id: string, x: number, y: number, keyboard = false): void {
    tabId.value = id;
    const trigger = options.trigger(id);
    if (overlay.available) {
      overlay.showAt({ x: Math.max(0, x), y: Math.max(0, y), width: 0, height: 0 }, {
        initialFocus: keyboard ? 'first-item' : 'none', focusReturn: trigger,
      });
      return;
    }
    void menuRef.value?.show(x, y, trigger, keyboard);
  }
  function close(): void {
    menuRef.value?.close();
    overlay.close();
  }
  return { menuRef, items, select, show, close };
}
