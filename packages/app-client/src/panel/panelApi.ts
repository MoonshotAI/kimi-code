
import type { InjectionKey } from 'vue';
import type { FilePreviewRequest, TurnFileChange } from '@moonshot-ai/app-core/client';
import type { PanelTabType } from './panelRegistry';

export interface PanelApi {
  openFile: (req: FilePreviewRequest) => void;
  openAgent: (id: string) => void;
  openContext?: () => void;
  openTurnDiff: (payload: {
    turnId: string;
    daemonTurnId?: number;
    sessionId?: string;
    cwd?: string;
    change: TurnFileChange;
  }) => void;
  openCompaction?: (target: { turnId: string }) => void;
  openDiff: () => void;
  openBtw: () => void;
  openTerm: () => void;
  isVisible: () => boolean;
  isExpanded: () => boolean;
  activeTabType: () => PanelTabType | null;
  activeTabPurePreview: () => boolean;
  pfcHost: () => HTMLElement | null;
  togglePanel: () => void;
}

export const panelApiKey: InjectionKey<PanelApi | undefined> = Symbol('panelApi');
