export type SessionSource = 'claude-code' | 'codex';

export interface SessionCandidate {
  source: SessionSource;
  path: string;
  sourceId: string;
  cwd: string;
  modifiedAt: number;
  subagentPaths?: string[];
  stateDatabasePath?: string;
}

export interface FindSessionsOptions {
  claudeHome: string;
  codexHome: string;
  since: number;
}

export type StepKind = 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'user_event' | 'event' | 'error' | 'source_context';

export interface HistoryStep {
  kind: StepKind;
  text: string;
  name?: string;
  callId?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  beforeUser?: boolean;
}

export interface HistoryTurn {
  id: string;
  user: string;
  steps: HistoryStep[];
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageReference {
  kind: 'embedded' | 'path' | 'url';
  path?: string;
  url?: string;
  sha256?: string;
  bytes?: number;
  mimeType?: string;
  sourceLine?: number;
  location: string;
  metadataOnly: boolean;
  text: string;
  unresolved?: boolean;
}

export interface EffectiveHistory {
  source: SessionSource;
  sourcePath: string;
  sourceId: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  metadata: Record<string, unknown>;
  summary?: string;
  turns: HistoryTurn[];
  stats: Record<string, unknown>;
  imageReferences: ImageReference[];
  imageReferenceIndexPath?: string;
}

export interface SourceCopy {
  directory: string;
  folder: boolean;
  subagentRollouts: number;
}

export interface ReadOptions {
  imageDirectory: string;
  stateDatabasePath?: string;
}

export interface ImportMessage {
  role: 'user';
  content: Array<{ type: 'text'; text: string }>;
}

export interface ConversionIssue {
  code: string;
  stage: 'source' | 'context' | 'attachment';
  message: string;
  count?: number;
}

export interface ConversionOptions {
  source: SessionSource;
  sourcePath: string;
  attachmentDirectory: string;
  contextWindow: number;
  tokenBudget?: number;
  stateDatabasePath?: string;
  subagentPaths?: string[];
}

export interface ConversionStats {
  tokenBudget: number;
  estimatedTokens: number;
  sourceTurns: number;
  includedTurns: number;
  omittedTurns: number;
  truncatedCharacters: number;
}

export type ConversionResult = {
  status: 'complete' | 'partial';
  source: SessionSource;
  sourceId: string;
  title?: string;
  cwd?: string;
  lastPrompt?: string;
  messages: ImportMessage[];
  historyPath: string;
  sourceCopyDirectory: string;
  imageReferenceIndexPath?: string;
  imageReferences: ImageReference[];
  stats: ConversionStats;
  issues: ConversionIssue[];
} | {
  status: 'unreliable';
  issues: ConversionIssue[];
  error: { code: string; message: string };
};
