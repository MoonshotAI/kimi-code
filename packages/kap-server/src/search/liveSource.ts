import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  followSessionLifecycles,
  getLiveSessionById,
  IAgentLifecycleService,
  ISessionIndex,
  IWireService,
  MAIN_AGENT_ID,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type {
  LiveTranscriptSource,
  LiveTranscriptView,
  LiveWireDoc,
} from './searchService';
import { collectWireDocs, initialWireDocCounters, type WireDocCounters } from './wireExtract';

export interface LocalLiveTranscriptSourceDeps {
  readonly homeDir: string;
  readonly core: Scope;
}

interface LiveEntry {
  readonly view: LocalLiveView;
  readonly ready: Promise<void>;
}

class LocalLiveView implements LiveTranscriptView {
  roster: readonly { agentId: string }[] = [];
  readonly byAgent = new Map<string, readonly LiveWireDoc[]>();

  agents(): readonly { agentId: string }[] {
    return this.roster;
  }

  docs(agentId: string): readonly LiveWireDoc[] | undefined {
    return this.byAgent.get(agentId);
  }
}

export class LocalLiveTranscriptSource implements LiveTranscriptSource {
  private readonly live = new Map<string, LiveEntry>();

  constructor(private readonly deps: LocalLiveTranscriptSourceDeps) {
    followSessionLifecycles(deps.core.accessor, (service) => {
      const d1 = service.onDidCloseSession(({ sessionId }) => this.live.delete(sessionId));
      const d2 = service.onDidArchiveSession(({ sessionId }) => this.live.delete(sessionId));
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
      };
    });
  }

  forSessionLive(sessionId: string): LiveTranscriptView | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) {
      if (getLiveSessionById(this.deps.core.accessor, sessionId) !== undefined) {
        return existing.view;
      }
      this.live.delete(sessionId);
      return undefined;
    }
    if (getLiveSessionById(this.deps.core.accessor, sessionId) === undefined) return undefined;
    const view = new LocalLiveView();
    const entry: LiveEntry = { view, ready: this.loadRoster(sessionId, view) };
    this.live.set(sessionId, entry);
    return view;
  }

  async whenReady(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.ready;
  }

  async ensureAgentHistory(sessionId: string, agentId: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    await entry.ready;
    const docs = await this.readAgentDocs(sessionId, agentId);
    if (this.live.get(sessionId) !== entry) return;
    entry.view.byAgent.set(agentId, docs);
    if (!entry.view.roster.some((agent) => agent.agentId === agentId)) {
      entry.view.roster = [...entry.view.roster, { agentId }];
    }
  }

  private async loadRoster(sessionId: string, view: LocalLiveView): Promise<void> {
    const dir = await this.sessionDir(sessionId);
    const roster: { agentId: string }[] = [{ agentId: MAIN_AGENT_ID }];
    if (dir !== undefined) {
      const agentsDir = join(dir, 'agents');
      try {
        const entries = await readdir(agentsDir, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || entry.name !== 'wire.jsonl') continue;
          const agentId = relative(agentsDir, entry.parentPath);
          if (agentId !== MAIN_AGENT_ID && !roster.some((agent) => agent.agentId === agentId)) {
            roster.push({ agentId });
          }
        }
      } catch {
      }
    }
    view.roster = roster;
  }

  private async readAgentDocs(sessionId: string, agentId: string): Promise<readonly LiveWireDoc[]> {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const handle = session?.accessor.get(IAgentLifecycleService).handleOf(agentId);
    if (handle !== undefined) await handle.accessor.get(IWireService).flush();
    const dir = await this.sessionDir(sessionId);
    if (dir === undefined) return [];
    let text: string;
    try {
      text = await readFile(join(dir, 'agents', agentId, 'wire.jsonl'), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let counters: WireDocCounters = initialWireDocCounters();
    const docs: LiveWireDoc[] = [];
    for (const line of text.split('\n')) {
      const out = collectWireDocs(counters, line);
      counters = out.counters;
      docs.push(...out.docs);
    }
    return docs;
  }

  private async sessionDir(sessionId: string): Promise<string | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    return join(this.deps.homeDir, 'sessions', summary.workspaceId, sessionId);
  }
}
