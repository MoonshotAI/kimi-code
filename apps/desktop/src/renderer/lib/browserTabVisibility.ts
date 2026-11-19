import { createBrowserId } from '../../shared/browser';
import type { usePanelTabs } from '@moonshot-ai/app-client/composables';

type BrowserPanel = Pick<ReturnType<typeof usePanelTabs>, 'activeTab' | 'sessionBrowserTabs' | 'activateTab'>;

export function showBrowserTab(panel: BrowserPanel, sessionId: string, viewedSessionId: string | null, tabId?: string): void {
  if (sessionId !== viewedSessionId) throw new Error('This session is not being viewed.');
  const tabs = panel.sessionBrowserTabs(sessionId);
  const target = tabId === undefined
    ? tabs.find((tab) => tab.id === panel.activeTab.value?.id) ?? tabs.at(-1)
    : tabs.find((tab) => tab.id === tabId);
  if (target === undefined) throw new Error(tabId === undefined ? 'No Browser tab is open.' : `Browser tab "${tabId}" does not exist.`);
  panel.activateTab(target.id);
}

export async function openBrowserLinkTab(
  panel: Pick<ReturnType<typeof usePanelTabs>, 'panelTabs' | 'browserTabOwner' | 'addSessionBrowserTab' | 'activateTab'>,
  sourceId: string,
  url: string,
  navigate: (browserId: string, url: string) => Promise<unknown>,
  background = false,
): Promise<boolean> {
  const owner = panel.browserTabOwner(sourceId);
  if (!owner) return false;
  const current = panel.panelTabs.value.some(tab => tab.id === owner.tabId);
  const browserId = createBrowserId();
  const tab = panel.addSessionBrowserTab(owner.sessionId, { browserId }, owner.tabId);
  if (current && !background) panel.activateTab(tab.id);
  await navigate(browserId, url);
  return true;
}
