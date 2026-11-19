import { onUnmounted, ref, type Ref } from 'vue';
import { panelTabDropIndex, panelTabInsertLeft } from '@moonshot-ai/app-client/lib';

export interface TerminalTabDropTarget {
  hover: (x: number, y: number) => number | null;
  clear: () => void;
}

function createDropTargets() {
  const targets = new Set<TerminalTabDropTarget>();
  return {
    register(target: TerminalTabDropTarget): () => void {
      targets.add(target);
      return () => targets.delete(target);
    },
    hover(x: number, y: number): number | null {
      let index: number | null = null;
      for (const target of targets) index = target.hover(x, y) ?? index;
      return index;
    },
    clear(): void {
      for (const target of targets) target.clear();
    },
  };
}

export const rightPanelDropTargets = createDropTargets();
export const bottomPanelDropTargets = createDropTargets();

export function pointInsideElement(element: HTMLElement | null, x: number, y: number): boolean {
  const rect = element?.getBoundingClientRect();
  return rect !== undefined && rect.width > 0 && rect.height > 0
    && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function useTabBarDropTarget(
  targets: ReturnType<typeof createDropTargets>,
  bar: Ref<HTMLElement | null>,
  tabs: Ref<HTMLElement | null>,
  enabled: () => boolean,
): Ref<number | null> {
  const left = ref<number | null>(null);
  function hover(x: number, y: number): number | null {
    const container = tabs.value;
    if (!enabled() || !container || !pointInsideElement(bar.value, x, y)) {
      left.value = null;
      return null;
    }
    const origin = container.getBoundingClientRect().left - container.scrollLeft;
    const slots = [...container.querySelectorAll<HTMLElement>('[data-panel-tab-id]')].map(element => {
      const bounds = element.getBoundingClientRect();
      return { id: element.dataset['panelTabId']!, start: bounds.left - origin, size: bounds.width };
    });
    const index = panelTabDropIndex(slots, '', x - origin);
    const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
    left.value = panelTabInsertLeft(slots, index, gap);
    return index;
  }
  onUnmounted(targets.register({ hover, clear: () => { left.value = null; } }));
  return left;
}
