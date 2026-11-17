import type { Session } from '@moonshot-ai/kimi-code-sdk';
import type { ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import {
  ArtexBrowserApp,
  type ArtexBrowserTab,
} from '../components/dialogs/artex-browser';
import type { Theme } from '#/tui/theme';
import type { CustomEditor } from '../components/editor/custom-editor';
import { beginScreenTakeover, endScreenTakeover, type ScreenTakeover } from '../utils/screen-takeover';

export interface ArtexBrowserHost {
  readonly session: Session | undefined;
  readonly state: {
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    artexBrowser?: ArtexBrowserState | undefined;
  };
  showError(msg: string): void;
  setArtexBrowser(value: ArtexBrowserState | undefined): void;
}

export type ArtexBrowserState = {
  component: ArtexBrowserApp;
  takeover: ScreenTakeover;
  tab: ArtexBrowserTab;
  pollTimer: NodeJS.Timeout | undefined;
};

export class ArtexBrowserController {
  constructor(private readonly host: ArtexBrowserHost) {}

  async show(): Promise<void> {
    const session = this.host.session;
    if (session === undefined) {
      this.host.showError('No active session.');
      return;
    }
    if (this.host.state.artexBrowser !== undefined) return;

    const component = new ArtexBrowserApp(
      {
        tab: 'graph',
        summary: '',
        detail: '',
        statusLine: 'Loading…',
        onTab: (tab) => void this.selectTab(tab),
        onClose: () => this.close(),
        onRefresh: () => void this.refresh(),
      },
      this.host.state.terminal,
    );
    const takeover = beginScreenTakeover(this.host.state.ui, component);
    this.host.state.ui.setFocus(component);
    this.host.state.ui.requestRender(true);
    const state: ArtexBrowserState = {
      component,
      takeover,
      tab: 'graph',
      pollTimer: setInterval(() => void this.refresh(), 1000),
    };
    this.host.setArtexBrowser(state);
    await this.refresh();
  }

  close(): void {
    const state = this.host.state.artexBrowser;
    if (state === undefined) return;
    if (state.pollTimer !== undefined) clearInterval(state.pollTimer);
    endScreenTakeover(this.host.state.ui, state.takeover);
    this.host.setArtexBrowser(undefined);
  }

  repaint(): void {
    void this.refresh();
  }

  private async selectTab(tab: ArtexBrowserTab): Promise<void> {
    const state = this.host.state.artexBrowser;
    if (state === undefined) return;
    state.tab = tab;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const state = this.host.state.artexBrowser;
    const session = this.host.session;
    if (state === undefined || session === undefined) return;
    try {
      const status = await session.getArtexStatus();
      let summary = '';
      let detail = '';
      switch (state.tab) {
        case 'graph':
          summary = 'Exploration graph';
          detail = JSON.stringify(await session.getArtexGraph(), null, 2);
          break;
        case 'findings':
          summary = 'Findings';
          detail = JSON.stringify(await session.listArtexFindings(), null, 2);
          break;
        case 'assets':
        case 'coverage':
          summary = state.tab;
          detail = JSON.stringify(status, null, 2);
          break;
        case 'traffic':
          summary = 'Traffic (summary from status)';
          detail = JSON.stringify(status, null, 2);
          break;
      }
      state.component.setProps({
        tab: state.tab,
        summary,
        detail,
        statusLine: `ARTEX ${status['active'] === true ? 'active' : 'idle'}`,
        onTab: (tab) => void this.selectTab(tab),
        onClose: () => this.close(),
        onRefresh: () => void this.refresh(),
      });
      state.component.invalidate();
    } catch (error) {
      this.host.showError(error instanceof Error ? error.message : String(error));
    }
  }
}