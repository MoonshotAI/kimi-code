export interface BrowserPanelSession {
  sessionId: string;
  tabs: { browserId: string; title?: string; customTitle?: string }[];
  activeBrowserId: string | null;
  visible: boolean;
}
