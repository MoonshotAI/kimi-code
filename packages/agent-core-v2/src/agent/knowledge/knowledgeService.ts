/**
 * `knowledge` domain (L4) — IAgentKnowledgeService implementation.
 *
 * Calls the napi-exported knowledge functions from kimi-native-tools.
 * Manages project-level and user-level databases.
 * Registered at Agent scope.
 *
 * The service also owns the KnowledgeLearner (auto-learning from user
 * corrections) and KnowledgeInjection (context injection) sub-components,
 * following the same pattern as GoalService ↔ GoalInjection.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';

import {
  IAgentKnowledgeService,
  type KnowledgeAddInput,
  type KnowledgeEntry,
  type KnowledgeSearchResult,
  type KnowledgeStats,
} from './knowledge';
import { KnowledgeInjection } from './knowledgeInjection';
import { KnowledgeLearner } from './knowledgeLearner';

// Import napi bindings — these are the Rust functions compiled into the native addon.
// At runtime, the native module is loaded by the host (kimi-code CLI).
// `require` is used (rather than dynamic `import`) because the DI system
// requires synchronous construction, and `require` of a native addon is
// already synchronous.
let nativeKnowledge:
  | {
      knowledgeOpen(dbPath: string): void;
      knowledgeClose(dbPath?: string | null): void;
      knowledgeAdd(
        title: string,
        category: string,
        content: string,
        tags: string,
        scope: string | null | undefined,
        source: string,
        confidence: number,
        status: string,
      ): string;
      knowledgeSearch(
        query: string,
        scopePath: string | null | undefined,
        tags: string | null | undefined,
        limit: number,
        minConfidence: number,
      ): string;
      knowledgeRemove(id: string): boolean;
      knowledgeConfirm(id: string): boolean;
      knowledgeReject(id: string): boolean;
      knowledgeStats(): string;
      knowledgeImport(markdown: string): string;
    }
  | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativeKnowledge = require('@moonshot-ai/kimi-native-tools');
} catch (error) {
  // Native module not available — knowledge features disabled.
  // We log this at construction time via the injected logger (see constructor).
  void error;
}

export class AgentKnowledgeService extends Disposable implements IAgentKnowledgeService {
  declare readonly _serviceBrand: undefined;

  private initialized = false;
  private currentDbPath: string | null = null;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService contextMemory: IAgentContextMemoryService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    if (!nativeKnowledge) {
      this.log.warn('Knowledge native module not available — knowledge features disabled');
    }
    this.initDatabase();
    // Only the main agent runs auto-learning and context injection.
    // Sub-agents (swarm workers, etc.) share the knowledge base but do not
    // write to it automatically or inject into their own context.
    if (this.scopeContext.agentId === 'main') {
      this._register(new KnowledgeLearner(this, eventBus, contextMemory));
      this._register(new KnowledgeInjection(this, dynamicInjector, contextMemory));
    }
  }

  private initDatabase(): void {
    if (!nativeKnowledge || this.initialized) return;
    const projectDb = `${this.bootstrap.cwd}/.kimi-code/knowledge.db`;
    try {
      nativeKnowledge.knowledgeOpen(projectDb);
      this.initialized = true;
      this.currentDbPath = projectDb;
    } catch (error) {
      // M2: log the failure rather than silently falling back.
      this.log.warn('Failed to open project knowledge DB, falling back to user DB', {
        error: error,
        projectDb,
      });
      try {
        const userDb = `${this.bootstrap.homeDir}/knowledge.db`;
        nativeKnowledge.knowledgeOpen(userDb);
        this.initialized = true;
        this.currentDbPath = userDb;
      } catch (error) {
        this.log.error('Failed to open user knowledge DB — knowledge features disabled', error);
      }
    }
  }

  // M1: open() now respects userDbPath (no longer ignored) and resets
  // `initialized` so callers can explicitly switch DBs.
  open(projectDbPath: string, userDbPath: string): void {
    if (!nativeKnowledge) return;
    try {
      // Close the currently-active DB first to release file handles (M11).
      if (this.currentDbPath !== null) {
        try {
          nativeKnowledge.knowledgeClose(this.currentDbPath);
        } catch {
          /* best-effort */
        }
      }
      nativeKnowledge.knowledgeOpen(projectDbPath);
      this.initialized = true;
      this.currentDbPath = projectDbPath;
    } catch (error) {
      this.log.warn('open(projectDbPath) failed, trying userDbPath', { error: error, projectDbPath });
      try {
        nativeKnowledge.knowledgeOpen(userDbPath);
        this.initialized = true;
        this.currentDbPath = userDbPath;
      } catch (error) {
        this.initialized = false;
        this.log.error('open() failed for both project and user DB paths', error);
      }
    }
  }

  search(query: string, scopePath?: string, tags?: string[], limit = 5): KnowledgeSearchResult[] {
    if (!nativeKnowledge || !this.initialized) return [];
    try {
      const tagsStr = tags?.join(',') ?? null;
      // Only confirmed entries participate in search/injection.
      // minConfidence=0.5 keeps backward compat with human/ai-confirmed entries.
      const json = nativeKnowledge.knowledgeSearch(query, scopePath ?? null, tagsStr, limit, 0.5);
      const results: KnowledgeSearchResult[] = JSON.parse(json);
      // Filter out pending entries (they should not appear in search results).
      return results.filter((r) => r.entry.status !== 'pending');
    } catch (error) {
      this.log.error('knowledge.search failed', { error: error, query });
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
        input.status ?? (input.source === 'human' ? 'confirmed' : 'pending'),
      );
      return JSON.parse(json);
    } catch (error) {
      // Duplicate inserts return an error from Rust; log at debug since this
      // is an expected control-flow signal, not a true failure.
      this.log.warn('knowledge.add failed (may be a duplicate)', { error: error, title: input.title });
      return null;
    }
  }

  confirm(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try {
      return nativeKnowledge.knowledgeConfirm(id);
    } catch (error) {
      this.log.error('knowledge.confirm failed', { error: error, id });
      return false;
    }
  }

  reject(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try {
      return nativeKnowledge.knowledgeReject(id);
    } catch (error) {
      this.log.error('knowledge.reject failed', { error: error, id });
      return false;
    }
  }

  remove(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try {
      return nativeKnowledge.knowledgeRemove(id);
    } catch (error) {
      this.log.error('knowledge.remove failed', { error: error, id });
      return false;
    }
  }

  stats(): KnowledgeStats {
    if (!nativeKnowledge || !this.initialized)
      return { total: 0, by_category: {}, by_source: {}, by_status: {}, avg_confidence: 0 };
    try {
      return JSON.parse(nativeKnowledge.knowledgeStats());
    } catch (error) {
      this.log.error('knowledge.stats failed', error);
      return { total: 0, by_category: {}, by_source: {}, by_status: {}, avg_confidence: 0 };
    }
  }

  importMarkdown(markdown: string): KnowledgeEntry[] {
    if (!nativeKnowledge || !this.initialized) return [];
    try {
      const json = nativeKnowledge.knowledgeImport(markdown);
      // M8: the Rust side now returns { entries, skipped }. Extract entries
      // and log skipped reasons so failures are observable.
      const parsed = JSON.parse(json) as
        | { entries: KnowledgeEntry[]; skipped: string[] }
        | KnowledgeEntry[];
      if (Array.isArray(parsed)) return parsed; // backward compat with old native module
      if (parsed.skipped && parsed.skipped.length > 0) {
        this.log.warn('knowledge.importMarkdown skipped some entries', { skipped: parsed.skipped });
      }
      return parsed.entries ?? [];
    } catch (error) {
      this.log.error('knowledge.importMarkdown failed', error);
      return [];
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentKnowledgeService,
  AgentKnowledgeService,
  InstantiationType.Eager,
  'knowledge',
);
