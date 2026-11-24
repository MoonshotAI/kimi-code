import { onScopeDispose, ref, type Ref } from 'vue';
import { TABLE_WIDE_CLASS, tableWidthTransitionMs } from '@moonshot-ai/app-markdown/lib/tableWide';

export interface WideTableToc {
  tocHidden: Ref<boolean>;
  syncWideTable: (root: ParentNode | null | undefined) => void;
}

export const WIDE_TABLE_MIN_WIDTH = 760;

export function isWideTableLayoutActive(expanded: boolean, containerWidth: number): boolean {
  return expanded && containerWidth >= WIDE_TABLE_MIN_WIDTH;
}

export function useWideTableToc(): WideTableToc {
  const tocHidden = ref(false);
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelRestore(): void {
    if (restoreTimer === undefined) return;
    clearTimeout(restoreTimer);
    restoreTimer = undefined;
  }

  function syncWideTable(root: ParentNode | null | undefined): void {
    if (root?.querySelector(`.${TABLE_WIDE_CLASS}`)) {
      cancelRestore();
      tocHidden.value = true;
      return;
    }
    if (!tocHidden.value || restoreTimer !== undefined) return;
    restoreTimer = setTimeout(() => {
      restoreTimer = undefined;
      tocHidden.value = false;
    }, tableWidthTransitionMs());
  }

  onScopeDispose(cancelRestore);

  return { tocHidden, syncWideTable };
}
