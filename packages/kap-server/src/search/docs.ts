export const MAX_DOC_TEXT_CHARS = 20_000;

export interface MessageDoc {
  readonly kind: 'message';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly time: number;
  readonly turn?: number;
  readonly stepId?: string;
}

export interface TitleDoc {
  readonly kind: 'title';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: '';
  readonly role: 'title';
  readonly text: string;
  readonly time: number;
}

export interface TurnOpener {
  readonly turn: number;
  readonly anchor: boolean;
}

export interface TurnCounterState {
  readonly next: number;
  readonly hasTurn: boolean;
  readonly openers: readonly TurnOpener[];
}

export interface StepTrackerState {
  readonly byUuid: Record<string, number>;
  readonly begins: number;
}

export interface FileMetaDoc {
  readonly kind: 'fileMeta';
  readonly sessionId: string;
  readonly agentId: string;
  readonly source: 'root' | 'agents';
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
  readonly turnState?: TurnCounterState;
  readonly stepState?: StepTrackerState;
}

export interface SessionMetaDoc {
  readonly kind: 'sessionMeta';
}

export interface StatsDoc {
  readonly kind: 'stats';
  readonly sessions: number;
  readonly documents: number;
  readonly lastIndexedAt: number;
}

export type SearchDoc = MessageDoc | TitleDoc | FileMetaDoc | SessionMetaDoc | StatsDoc;
