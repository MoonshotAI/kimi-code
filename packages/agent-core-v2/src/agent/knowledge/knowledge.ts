/**
 * `knowledge` domain (L4) — IAgentKnowledgeService interface.
 *
 * Provides structured access to the local coding standards knowledge base.
 * The knowledge base stores project/user-level coding standards, pitfalls,
 * architecture decisions, and workflow rules that the agent consults before
 * writing code.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface KnowledgeEntry {
  id: string;
  category: 'coding-style' | 'pitfall' | 'architecture' | 'workflow';
  title: string;
  content: string;
  tags: string[];
  scope: string | null;
  confidence: number;
  source: 'human' | 'ai-learned' | 'ai-confirmed';
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry;
  relevance: number;
  match_source: string[];
}

export interface KnowledgeAddInput {
  title: string;
  category: 'coding-style' | 'pitfall' | 'architecture' | 'workflow';
  content: string;
  tags?: string[];
  scope?: string;
  source?: 'human' | 'ai-learned';
  confidence?: number;
}

export interface KnowledgeStats {
  total: number;
  by_category: Record<string, number>;
  by_source: Record<string, number>;
  avg_confidence: number;
}

export interface IAgentKnowledgeService {
  readonly _serviceBrand: undefined;

  /** Initialize the database (called once at agent start) */
  open(projectDbPath: string, userDbPath: string): void;

  /** Search for relevant standards given context */
  search(query: string, scopePath?: string, tags?: string[], limit?: number): KnowledgeSearchResult[];

  /** Add a new knowledge entry */
  add(input: KnowledgeAddInput): KnowledgeEntry | null;

  /** Confirm an AI-learned entry (sets confidence to 1.0) */
  confirm(id: string): boolean;

  /** Reject/remove an entry */
  remove(id: string): boolean;

  /** Get statistics */
  stats(): KnowledgeStats;

  /** Import from markdown string */
  importMarkdown(markdown: string): KnowledgeEntry[];
}

export const IAgentKnowledgeService: ServiceIdentifier<IAgentKnowledgeService> =
  createDecorator<IAgentKnowledgeService>('agentKnowledgeService');
