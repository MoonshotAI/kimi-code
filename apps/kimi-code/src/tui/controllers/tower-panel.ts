import { TuiAltScreen } from '@moonshot-ai/pi-tui';
import type { Session, TowerProjection, Unsubscribe } from '@moonshot-ai/kimi-code-sdk';

import { TOWER_PANEL_MIN_COLUMNS } from '#/tui/constant/rendering';
import type { TUIState } from '#/tui/tui-state';

export interface TowerPanelVisibility {
  readonly fullscreen: boolean;
  readonly towerMode: boolean;
  readonly hasContent: boolean;
  readonly columns: number;
}

export function isTowerPanelVisible(input: TowerPanelVisibility): boolean {
  return (
    input.fullscreen &&
    input.towerMode &&
    input.hasContent &&
    input.columns >= TOWER_PANEL_MIN_COLUMNS
  );
}

export interface TowerPanelHost {
  readonly state: TUIState;
  session: Session | undefined;
}

export class TowerPanelController {
  private projection: TowerProjection | undefined;
  private unsubscribe: Unsubscribe | undefined;
  private watchingSessionId: string | undefined;

  constructor(private readonly host: TowerPanelHost) {
    host.state.towerPanelVisible = () => this.isVisible();
    if (host.state.ui instanceof TuiAltScreen) {
      const ui = host.state.ui;
      let lastColumns = ui.terminal.columns;
      ui.addLayoutEffect(() => {
        const columns = ui.terminal.columns;
        if (columns === lastColumns) return;
        lastColumns = columns;
        this.sync();
      });
    }
  }

  isVisible(): boolean {
    return isTowerPanelVisible({
      fullscreen: this.host.state.ui instanceof TuiAltScreen,
      towerMode: this.host.state.appState.towerMode,
      hasContent: this.projection?.hasContent === true,
      columns: this.host.state.ui.terminal.columns,
    });
  }

  /** Start watching when tower mode is on in fullscreen, stop and clear otherwise. */
  sync(): void {
    const session = this.host.session;
    if (
      !(this.host.state.ui instanceof TuiAltScreen) ||
      !this.host.state.appState.towerMode ||
      session === undefined
    ) {
      this.stop();
      return;
    }
    if (this.watchingSessionId === session.id) return;
    this.stop();
    const sessionId = session.id;
    this.watchingSessionId = sessionId;
    void session
      .watchTowerProjection((projection) => {
        if (this.watchingSessionId !== sessionId) return;
        this.projection = projection;
        this.host.state.towerPane.setProjection(projection);
        this.host.state.ui.requestRender();
      })
      .then((unsubscribe) => {
        if (this.watchingSessionId !== sessionId) {
          unsubscribe();
          return;
        }
        this.unsubscribe = unsubscribe;
      })
      .catch(() => {
        if (this.watchingSessionId === sessionId) this.watchingSessionId = undefined;
      });
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.watchingSessionId === undefined && this.projection === undefined) return;
    this.watchingSessionId = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.projection = undefined;
    this.host.state.towerPane.setProjection(undefined);
    this.host.state.ui.requestRender();
  }
}
