/**
 * `knowledge` domain (L4) — IAgentKnowledgeService implementation.
 *
 * Calls the napi-exported knowledge functions from kimi-native-tools.
 * Manages project-level and user-level databases.
 * Registered at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentScopeContext } from '#/agent/agentScopeContext';

import {
  IAgentKnowledgeService,
  type KnowledgeAddInput,
  type KnowledgeEntry,
  type KnowledgeSearchResult,
  type KnowledgeStats,
} from './knowledge';

// Import napi bindings — these are the Rust functions compiled into the native addon.
// At runtime, the native module is loaded by the host (kimi-code CLI).
let nativeKnowledge: {
  knowledgeOpen(dbPath: string): void;
  knowledgeAdd(title: string, category: string, content: string, tags: string, scope: string | null | undefined, source: string, confidence: number): string;
  knowledgeSearch(query: string, scopePath: string | null | undefined, tags: string | null | undefined, limit: number, minConfidence: number): string;
  knowledgeRemove(id: string): boolean;
  knowledgeConfirm(id: string): boolean;
  knowledgeStats(): string;
  knowledgeImport(markdown: string): string;
} | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativeKnowledge = require('@moonshot-ai/kimi-native-tools');
} catch {
  // Native module not available — knowledge features disabled
}

export class AgentKnowledgeService extends Disposable implements IAgentKnowledgeService {
  declare readonly _serviceBrand: undefined;

  private initialized = false;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    super();
    this.initDatabase();
  }

  private initDatabase(): void {
    if (!nativeKnowledge || this.initialized) return;
    try {
      // Use project-level DB (cwd/.kimi-code/knowledge.db)
      const projectDb = `${this.scopeContext.cwd}/.kimi-code/knowledge.db`;
      nativeKnowledge.knowledgeOpen(projectDb);
      this.initialized = true;
    } catch {
      try {
        // Fallback to user-level DB
        const userDb = `${this.bootstrap.homeDir}/knowledge.db`;
        nativeKnowledge!.knowledgeOpen(userDb);
        this.initialized = true;
      } catch { /* Knowledge DB unavailable */ }
    }
  }

  open(projectDbPath: string, _userDbPath: string): void {
    if (!nativeKnowledge) return;
    try {
      nativeKnowledge.knowledgeOpen(projectDbPath);
      this.initialized = true;
    } catch { /* ignore */ }
  }

  search(query: string, scopePath?: string, tags?: string[], limit = 5): KnowledgeSearchResult[] {
    if (!nativeKnowledge || !this.initialized) return [];
    try {
      const tagsStr = tags?.join(',') ?? null;
      const json = nativeKnowledge.knowledgeSearch(query, scopePath ?? null, tagsStr, limit, 0.5);
      return JSON.parse(json);
    } catch {
      return [];
    }
  }

  add(input: KnowledgeAddInput): KnowledgeEntry | null {
    if (!nativeKnowledge || !this.initialized) return null;
    try {
      const json = nativeKnowledge.knowledgeAdd(
        input.title,
        input.category,
        input.content,
        input.tags?.join(',') ?? '',
        input.scope ?? null,
        input.source ?? 'ai-learned',
        input.confidence ?? 0.7,
      );
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  confirm(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try { return nativeKnowledge.knowledgeConfirm(id); } catch { return false; }
  }

  remove(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try { return nativeKnowledge.knowledgeRemove(id); } catch { return false; }
  }

  stats(): KnowledgeStats {
    if (!nativeKnowledge || !this.initialized) return { total: 0, by_category: {}, by_source: {}, avg_confidence: 0 };
    try { return JSON.parse(nativeKnowledge.knowledgeStats()); } catch { return { total: 0, by_category: {}, by_source: {}, avg_confidence: 0 }; }
  }

  importMarkdown(markdown: string): KnowledgeEntry[] {
    if (!nativeKnowledge || !this.initialized) return [];
    try { return JSON.parse(nativeKnowledge.knowledgeImport(markdown)); } catch { return []; }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentKnowledgeService,
  AgentKnowledgeService,
  InstantiationType.Eager,
  'knowledge',
);
