
import type {
  AppConfig,
  AppSession,
  GitStatusEntry,
  KimiClientState,
  ThinkingLevel,
} from '@moonshot-ai/app-core/api';
import type { ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';

export type { GitStatusEntry } from '@moonshot-ai/app-core/api';

export type PromptAttachment = {
  clientId?: string;
  fileId: string;
  kind: 'image' | 'video' | 'file';
  sessionId?: string;
  name?: string;
  mediaType?: string;
  size?: number;
  mediaOrdinal?: number;
};

export type PromptSkillActivation = {
  name: string;
  path?: string;
  args?: string;
};

export interface SideChatTurnError {
  code?: string;
  message?: string;
  statusCode?: number;
  requestId?: string;
  endReason?: string;
}

export interface PromptEnvelope {
  text: string;
  snapshot?: ComposerDocumentSnapshot;
  attachments: PromptAttachment[];
  skills: PromptSkillActivation[];
}

export interface PromptEnvelopeContent {
  text: string;
  snapshot?: ComposerDocumentSnapshot;
  attachments?: PromptAttachment[];
  skills?: PromptSkillActivation[];
}

export interface QueuedPrompt extends PromptEnvelope {
  id?: string;
  editText?: string;
  kind?: 'prompt' | 'compact';
  instruction?: string;
  enqueuedAt?: number;
  compactRetries?: number;
}

export type ManagedMembership = 'member' | 'free' | null;

export interface ExtendedState extends KimiClientState {
  sessionStatusSettledBySession: Record<string, true>;
  serverVersion: string;
  dangerousBypassAuth: boolean;
  backend: 'v1' | 'v2';
  experimentalFlags: Record<string, boolean>;
  webTitle: string;
  workspaceName: string;
  thinking: ThinkingLevel | undefined;
  draftThinkingExplicit: boolean;
  thinkingBySession: Record<string, ThinkingLevel>;
  pendingThinkingBySession: Record<string, number>;
  planModeBySession: Record<string, boolean>;
  planArmedBySession: Record<string, boolean>;
  pendingPlanBySession: Record<string, number>;
  swarmModeBySession: Record<string, boolean>;
  pendingSwarmBySession: Record<string, number>;
  towerModeBySession: Record<string, boolean>;
  pendingTowerBySession: Record<string, number>;
  goalModeBySession: Record<string, boolean>;
  loading: boolean;
  sessionLoading: boolean;
  gitStatusBySession: Record<string, GitStatusEntry>;
  availableOpenInApps: string[];
  config: AppConfig | null;
  sessionsFullyLoaded: boolean;
  flatSessionsNextPageToken: string | null;
  flatSessionsHasMore: boolean;
  flatSessionsLoading: boolean;
  flatSessionsLoadingMore: boolean;
  flatSessionsSeeded: boolean;
  doneSessions: AppSession[];
  doneSessionsNextPageToken: string | null;
  doneSessionsHasMore: boolean;
  doneSessionsLoading: boolean;
  doneSessionsLoadingMore: boolean;
  doneSessionsSeeded: boolean;
  mainView: 'chat' | 'sessionAdmin';
}
