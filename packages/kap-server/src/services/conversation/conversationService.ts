import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Error2,
  ErrorCodes,
  IAgentLifecycleService,
  IBootstrapService,
  ISessionIndex,
  ISessionManager,
  MAIN_AGENT_ID,
  agentContextOf,
  flattenChain,
  getLiveSessionById,
  getOrRestoreAgent,
  resumeSessionById,
  sessionDirOf,
  workspacePersistenceScope,
  type AgentContext,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  AGENT_WIRE_RECORD_KEY,
  assertWireRecordsReaderVersion,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2/wire/record';

import type { ConversationTurn } from '../../protocol/conversation';
import { ensureMainAgent } from '../../transport/mainAgent';
import { ConversationFeed } from './conversationFeed';
import { applyConversationRecord, createConversationState } from './conversationFold';

export interface ConversationFeedCreated {
  readonly sessionId: string;
  readonly agentId: string;
  readonly feed: ConversationFeed;
}

interface SessionFeeds {
  readonly session: ISessionScopeHandle;
  readonly feeds: Map<string, { readonly context: AgentContext; readonly feed: ConversationFeed }>;
  readonly watches: IDisposable[];
}

export class ConversationService implements IDisposable {
  private readonly sessions = new Map<string, SessionFeeds>();
  private readonly listeners = new Set<(created: ConversationFeedCreated) => void>();
  private readonly creations: IDisposable | undefined;

  constructor(private readonly core: Scope) {
    const manager = core.accessor.get(ISessionManager);
    this.creations = manager.onWillCreateSession?.((event) => {
      let created: ISessionScopeHandle | undefined;
      event.onDidCreateScope((session) => {
        created = session;
        this.watch(event.sessionId, session);
      });
      event.onSessionDispose(() => {
        if (created !== undefined) this.drop(event.sessionId, created);
      });
    });
    for (const session of manager.list()) this.watch(session.id, session);
  }

  async feed(sessionId: string, agentId: string): Promise<ConversationFeed> {
    const session = await resumeSessionById(this.core.accessor, sessionId);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session not found: ${sessionId}`);
    }
    const handle = agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : await getOrRestoreAgent(session, agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent not found: ${agentId}`);
    }
    return this.attach(sessionId, this.watch(sessionId, session), handle).ready;
  }

  async turnsWithoutLoading(sessionId: string, agentId: string): Promise<readonly ConversationTurn[] | undefined> {
    const session = getLiveSessionById(this.core.accessor, sessionId);
    const handle = session?.accessor.get(IAgentLifecycleService).handleOf(agentId);
    if (session !== undefined && handle !== undefined) {
      return (await this.attach(sessionId, this.watch(sessionId, session), handle).ready).turns();
    }
    const summary = await this.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    const bootstrap = this.core.accessor.get(IBootstrapService);
    const sessionDir = sessionDirOf(
      bootstrap.homeDir,
      workspacePersistenceScope(bootstrap.scope('sessions'), summary.workspaceId),
      sessionId,
    );
    const wirePath = join(sessionDir, 'agents', agentId, AGENT_WIRE_RECORD_KEY);
    let text: string;
    try {
      text = await readFile(wirePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = parseWireRecords(text, wirePath);
    assertWireRecordsReaderVersion(records);
    const state = createConversationState();
    for (const record of flattenChain(records)) applyConversationRecord(state, record);
    return state.turns;
  }

  onDidCreateFeed(listener: (created: ConversationFeedCreated) => void): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  dispose(): void {
    this.creations?.dispose();
    for (const [sessionId, entry] of this.sessions) this.drop(sessionId, entry.session);
    this.listeners.clear();
  }

  private watch(sessionId: string, session: ISessionScopeHandle): SessionFeeds {
    const existing = this.sessions.get(sessionId);
    if (existing?.session === session) return existing;
    if (existing !== undefined) this.drop(sessionId, existing.session);
    const agents = session.accessor.get(IAgentLifecycleService);
    const entry: SessionFeeds = { session, feeds: new Map(), watches: [] };
    this.sessions.set(sessionId, entry);
    entry.watches.push(
      agents.onDidCreateScope(({ handle }) => {
        this.attach(sessionId, entry, handle);
      }),
      agents.onDidClose((agent) => {
        const closed = entry.feeds.get(agent.agentId);
        if (closed?.context !== agent) return;
        entry.feeds.delete(agent.agentId);
        closed.feed.dispose();
      }),
    );
    for (const agent of agents.list()) {
      const handle = agents.handleOf(agent.agentId);
      if (handle !== undefined) this.attach(sessionId, entry, handle);
    }
    return entry;
  }

  private attach(sessionId: string, entry: SessionFeeds, handle: IAgentScopeHandle): ConversationFeed {
    const context = agentContextOf(handle);
    const previous = entry.feeds.get(handle.id);
    if (previous?.context === context) return previous.feed;
    previous?.feed.dispose();
    const feed = new ConversationFeed(handle);
    entry.feeds.set(handle.id, { context, feed });
    feed.ready.catch(() => {
      if (entry.feeds.get(handle.id)?.feed === feed) entry.feeds.delete(handle.id);
    });
    for (const listener of this.listeners) listener({ sessionId, agentId: handle.id, feed });
    return feed;
  }

  private drop(sessionId: string, session: ISessionScopeHandle): void {
    const entry = this.sessions.get(sessionId);
    if (entry?.session !== session) return;
    this.sessions.delete(sessionId);
    for (const watch of entry.watches) watch.dispose();
    for (const { feed } of entry.feeds.values()) feed.dispose();
  }
}

export function parseWireRecords(text: string, wirePath: string): WireRecord[] {
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';
  const records = lines.flatMap((line, index): WireRecord[] => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line) as WireRecord];
    } catch (error) {
      throw new Error(`wire.jsonl: corrupted line ${index + 1} in ${wirePath}`, { cause: error });
    }
  });
  try {
    if (tail.trim().length > 0) records.push(JSON.parse(tail) as WireRecord);
  } catch {
  }
  return records;
}
