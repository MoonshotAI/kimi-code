import type { Component } from 'vue';
import type { PanelTabType } from '@moonshot-ai/app-client/panel';
import {
  AgentPanel,
  DiffView,
  FilePreviewPanel,
  FilesPanel,
  InspectorPane,
  SideChatPanel,
  ThinkingPanel,
  TurnDiffPanel,
} from '@moonshot-ai/app-components';
import ContextPanel from '../../inspector/ContextPanel.vue';

export const panelComponents: Partial<Record<PanelTabType, Component>> = {
  file: FilePreviewPanel,
  files: FilesPanel,
  diff: DiffView,
  'turn-diff': TurnDiffPanel,
  compaction: ThinkingPanel,
  agent: AgentPanel,
  btw: SideChatPanel,
  inspector: InspectorPane,
  context: ContextPanel,
};
