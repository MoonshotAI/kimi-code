/**
 * Source parser interface for importing sessions from external AI coding tools.
 *
 * Each source tool (Claude Code, Codex, Cursor, etc.) implements this interface
 * to convert its native session format into a unified {@link HandoffContext}.
 */

/** Structured context extracted from a foreign AI coding session. */
export interface HandoffContext {
  /** Source tool identifier (e.g. 'claude-code', 'codex'). */
  source: string;
  /** Original session ID in the source tool. */
  sourceSessionId: string;
  /** Model used in the source session, if known. */
  model?: string;
  /** When the source session was created. */
  createdAt?: string;
  /** Working directory of the source session. */
  workingDirectory?: string;
  /** Aggregated token usage from the source session. */
  tokenUsage?: HandoffTokenUsage;
  /** Short summary (first user message or title). */
  summary?: string;
  /** Key decisions and architectural choices discovered during the session. */
  keyDecisions: string[];
  /** Files that were modified, with descriptions. */
  filesModified: FileChangeRecord[];
  /** Recent conversation turns (most recent first, up to a limit). */
  recentConversation: ConversationTurn[];
  /** Pending work items that were not completed. */
  pendingWork: string[];
  /** Raw handoff document in Markdown format. */
  markdown: string;
}

export interface HandoffTokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface FileChangeRecord {
  path: string;
  description: string;
}

export type ConversationTurn =
  | UserTurn
  | AssistantTurn
  | ToolCallTurn
  | ToolResultTurn;

export interface UserTurn {
  kind: 'user';
  text: string;
}

export interface AssistantTurn {
  kind: 'assistant';
  text?: string;
  thinking?: string;
}

export interface ToolCallTurn {
  kind: 'tool-call';
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultTurn {
  kind: 'tool-result';
  toolName: string;
  summary: string;
}

/** Summary of a discoverable source session. */
export interface SourceSessionSummary {
  /** Source tool identifier. */
  source: string;
  /** Session ID in the source tool. */
  sessionId: string;
  /** Display title or summary. */
  title?: string;
  /** Working directory. */
  workingDirectory?: string;
  /** When the session was created. */
  createdAt?: string;
  /** When the session was last updated. */
  updatedAt?: string;
  /** Model used. */
  model?: string;
  /** Approximate token count. */
  tokenCount?: number;
}

/** Interface that each source-tool parser must implement. */
export interface SourceParser {
  /** Unique identifier for this source (e.g. 'claude-code'). */
  readonly sourceId: string;
  /** Human-readable label for this source. */
  readonly label: string;
  /** Discover available sessions from this source tool. */
  listSessions(): Promise<SourceSessionSummary[]>;
  /** Parse a specific session into a handoff context. */
  parseSession(sessionId: string): Promise<HandoffContext>;
}
