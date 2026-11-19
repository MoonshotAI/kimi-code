import type { ConfirmOptions } from '../composables/useConfirmDialog';
import type { BtwTabPayload } from './panelRegistry';

type Translator = (key: string, params?: Record<string, unknown>) => string;

export interface ClosingPanelTabCandidate {
  id: string;
  type: string;
  payload?: unknown;
}

export function createSideChatCloseGuard(options: {
  hasActivity: (agentId: string) => boolean;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  t: Translator;
}) {
  let pending = false;
  return async (tabs: readonly ClosingPanelTabCandidate[]): Promise<boolean> => {
    if (pending) return false;
    const activeBtw = tabs.filter((tab) => {
      if (tab.type !== 'btw' || tab.payload === undefined) return false;
      const agentId = (tab.payload as Partial<BtwTabPayload>).agentId;
      return typeof agentId === 'string' && agentId.length > 0 && options.hasActivity(agentId);
    });
    if (activeBtw.length === 0) return true;
    pending = true;
    try {
      const message =
        activeBtw.length > 1
          ? options.t('sideChat.closeConfirmMultipleMessage', { count: activeBtw.length })
          : options.t('sideChat.closeConfirmMessage');
      return await options.confirm({
        title: options.t('sideChat.closeConfirmTitle'),
        message,
        confirmLabel: options.t('sideChat.closeConfirmAction'),
        cancelLabel: options.t('common.cancel'),
        variant: 'danger',
      });
    } finally {
      pending = false;
    }
  };
}
