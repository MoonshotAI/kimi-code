import type { Component } from 'vue';
import type { PanelTabType } from '@moonshot-ai/app-client/panel';
import {
  AgentPanel,
  CompactionPanel,
  DiffView,
  FilePreviewPanel,
  FilesPanel,
  InspectorPane,
  SideChatPanel,
  TurnDiffPanel,
} from '@moonshot-ai/app-components';
import ContextPanel from '../../inspector/ContextPanel.vue';

export const panelComponents: Partial<Record<PanelTabType, Component>> = {
  file: FilePreviewPanel,
  files: FilesPanel,
  diff: DiffView,
  'turn-diff': TurnDiffPanel,
  compaction: CompactionPanel,
  agent: AgentPanel,
  btw: SideChatPanel,
  inspector: InspectorPane,
  context: ContextPanel,
};
