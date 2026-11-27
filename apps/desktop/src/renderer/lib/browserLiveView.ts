import type { BrowserLiveView } from '@moonshot-ai/app-components';
import type { usePanelTabs } from '@moonshot-ai/app-client/composables';
import type { BrowserTabPayload } from '@moonshot-ai/app-client/panel';

type LivePanel = Pick<ReturnType<typeof usePanelTabs>, 'panelVisible' | 'activeTab' | 'sessionBrowserTabs' | 'activateTab'>;

function controlledTab(panel: LivePanel, sessionId: string) {
  return panel.sessionBrowserTabs(sessionId).find((tab) => (tab.payload as BrowserTabPayload | undefined)?.controlled?.status === 'running');
}

export function createBrowserLiveView(panel: LivePanel, activeSessionId: () => string | null): BrowserLiveView {
  return {
    state(sessionId) {
      if (sessionId !== activeSessionId()) return null;
      const tab = controlledTab(panel, sessionId);
      if (tab === undefined) return null;
      return { visible: panel.panelVisible.value && panel.activeTab.value?.id === tab.id, tabId: tab.id };
    },
    show(sessionId) {
      if (sessionId !== activeSessionId()) return;
      const tab = controlledTab(panel, sessionId);
      if (tab !== undefined) panel.activateTab(tab.id);
    },
  };
}

export function browserControlOutOfView(panel: LivePanel, activeSessionId: string | null): boolean {
  return activeSessionId !== null && !panel.panelVisible.value && controlledTab(panel, activeSessionId) !== undefined;
}
