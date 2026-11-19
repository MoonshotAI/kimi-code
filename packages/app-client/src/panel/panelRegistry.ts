
import type { Translator } from '@moonshot-ai/app-core/contracts';
import type { FilePreviewRequest, TurnFileChange } from '@moonshot-ai/app-core/client';

export type PanelTabType =
  | 'file'
  | 'files'
  | 'diff'
  | 'turn-diff'
  | 'compaction'
  | 'agent'
  | 'btw'
  | 'term'
  | 'browser'
  | 'inspector'
  | 'context';

export type PanelTabPolicy = 'singleton' | 'keyed' | 'always';

export interface PanelTabDef {
  type: PanelTabType;
  policy: PanelTabPolicy;
  keyOf?: (payload: unknown) => string;
  title: (payload: unknown, t: Translator) => string;
  icon: string;
  i18nKey: string;
  restorable: boolean;
  expandable?: boolean;
}

export type PanelLauncherType = 'diff' | 'browser' | 'term' | 'files' | 'btw' | 'inspector';

export const panelLauncherOrder: readonly PanelLauncherType[] = ['diff', 'browser', 'term', 'files', 'btw', 'inspector'];

export interface DiffTabPayload {
  root?: string;
}

export type FileTabPayload = FilePreviewRequest;

export interface AgentTabPayload {
  sessionId: string;
  subagentId: string;
  shellTask?: boolean;
}

export interface TurnDiffTabPayload {
  turnId: string;
  daemonTurnId?: number;
  sessionId?: string;
  cwd?: string;
  change: TurnFileChange;
}

export interface CompactionTabPayload {
  turnId: string;
  text?: string;
}

export interface BtwTabPayload {
  parentId: string;
  agentId: string;
  seq: number;
}

export interface TermTabPayload {
  cwd?: string;
  ptyId?: string;
  title?: string;
  error?: string;
}

export interface BrowserTabController {
  run: { agentId: string; generation: number; turnId: number };
  profile?: string;
  description?: string;
}

export interface BrowserTabPayload {
  browserId: string;
  customTitle?: string;
  controlled?: { leaseId: string; turnId: string; status: 'running' | 'paused' | 'unknown'; controller?: BrowserTabController };
  title?: string;
  favicon?: string;
  loading?: boolean;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export const panelRegistry: Record<PanelTabType, PanelTabDef> = {
  diff: {
    type: 'diff',
    policy: 'singleton',
    title: (_payload, t) => t('panel.tabs.diff'),
    icon: 'file-diff',
    i18nKey: 'panel.tabs.diff',
    restorable: true,
  },
  file: {
    type: 'file',
    policy: 'keyed',
    keyOf: (payload) => (payload as FileTabPayload).path,
    title: (payload) => baseName((payload as FileTabPayload).path),
    icon: 'file-text',
    i18nKey: 'panel.tabs.file',
    restorable: true,
  },
  files: {
    type: 'files',
    policy: 'singleton',
    title: (_payload, t) => t('panel.tabs.files'),
    icon: 'folder-closed',
    i18nKey: 'panel.tabs.files',
    restorable: true,
  },
  agent: {
    type: 'agent',
    policy: 'keyed',
    keyOf: (payload) => (payload as AgentTabPayload).subagentId,
    title: (_payload, t) => t('panel.tabs.agent'),
    icon: 'robot',
    i18nKey: 'panel.tabs.agent',
    restorable: true,
  },
  'turn-diff': {
    type: 'turn-diff',
    policy: 'singleton',
    title: (_payload, t) => t('panel.tabs.turnDiff'),
    icon: 'file-edit',
    i18nKey: 'panel.tabs.turnDiff',
    restorable: true,
  },
  compaction: {
    type: 'compaction',
    policy: 'keyed',
    keyOf: (payload) => (payload as CompactionTabPayload).turnId,
    title: (_payload, t) => t('panel.tabs.compaction'),
    icon: 'list',
    i18nKey: 'panel.tabs.compaction',
    restorable: true,
  },
  btw: {
    type: 'btw',
    policy: 'always',
    title: (payload, t) => {
      const seq = (payload as BtwTabPayload).seq;
      return seq === 1 ? t('sideChat.title') : `${t('sideChat.title')} ${seq}`;
    },
    icon: 'message',
    i18nKey: 'sideChat.title',
    restorable: true,
  },
  term: {
    type: 'term',
    policy: 'always',
    title: (payload, t) => {
      const binary = (payload as TermTabPayload | undefined)?.title;
      return binary ?? t('panel.tabs.term');
    },
    icon: 'terminal',
    i18nKey: 'panel.tabs.term',
    restorable: true,
  },
  browser: {
    type: 'browser',
    policy: 'always',
    title: (payload, t) =>
      (payload as BrowserTabPayload | undefined)?.customTitle || (payload as BrowserTabPayload | undefined)?.title || t('panel.tabs.browser'),
    icon: 'browser',
    i18nKey: 'panel.tabs.browser',



    restorable: true,
  },
  inspector: {
    type: 'inspector',
    policy: 'singleton',
    title: (_payload, t) => t('panel.tabs.inspector'),
    icon: 'microscope',
    i18nKey: 'panel.tabs.inspector',
    restorable: true,
  },
  context: {
    type: 'context',
    policy: 'singleton',
    title: (_payload, t) => t('inspector.title'),
    icon: 'list-numbers',
    i18nKey: 'inspector.title',
    restorable: true,
    expandable: true,
  },
};
