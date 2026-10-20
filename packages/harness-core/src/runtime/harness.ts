import { createApp, type App } from '@moonshot-ai/agent-core/app/index';
import type { EffectScope } from '@moonshot-ai/agent-core/kernel/index';
import {
  MAIN_AGENT_ID,
  memorySessionSpace,
  type Agent,
  type Session,
  type SessionSpace,
} from '@moonshot-ai/agent-core/session/index';
import { memoryJournal } from '@moonshot-ai/agent-core/store/backend/memory';
import { openWriter, type Journal, type Writer } from '@moonshot-ai/agent-core/store/index';

import { agentCaps, createAgentRuntime, type AgentRuntime, type EnsureAgentOptions } from './agents';

export interface HarnessSessionSpace extends SessionSpace {
  featureJournal(sessionId: string): Journal;
}

export function memoryHarnessSpace(): HarnessSessionSpace {
  const space = memorySessionSpace();
  const journals = new Map<string, Map<string, string[]>>();
  return {
    list: () => space.list(),
    get: (id) => space.get(id),
    create: (id, record) => space.create(id, record),
    open: (id) => space.open(id),
    update: (id, patch) => space.update(id, patch),
    delete: async (id) => {
      journals.delete(id);
      await space.delete(id);
    },
    copy: async (from, to) => {
      const container = await space.copy(from, to);
      const source = journals.get(from);
      if (source !== undefined) {
        journals.set(to, new Map([...source].map(([name, lines]) => [name, lines.slice()])));
      }
      return container;
    },
    featureJournal: (sessionId) => {
      let logs = journals.get(sessionId);
      if (logs === undefined) {
        logs = new Map();
        journals.set(sessionId, logs);
      }
      return memoryJournal(logs);
    },
  };
}

export interface CreateHarnessOptions {
  readonly space?: HarnessSessionSpace;
  readonly scope?: EffectScope;
}

export interface Harness {
  readonly app: App;
  ensureAgent(session: Session, agentId?: string, opts?: EnsureAgentOptions): Promise<Agent>;
  close(): Promise<void>;
}

export interface HarnessInternals {
  readonly space: HarnessSessionSpace;
  readonly agents: WeakMap<Session, Map<string, AgentRuntime>>;
  readonly writers: Map<string, Writer>;
}

const internalsByApp = new WeakMap<App, HarnessInternals>();

export function harnessInternals(app: App): HarnessInternals {
  const internals = internalsByApp.get(app);
  if (internals === undefined) throw new Error('app was not created by createHarness');
  return internals;
}

export function featureWriterOf(internals: HarnessInternals, sessionId: string): Writer {
  let writer = internals.writers.get(sessionId);
  if (writer === undefined) {
    writer = openWriter(internals.space.featureJournal(sessionId));
    internals.writers.set(sessionId, writer);
  }
  return writer;
}

async function ensureAgent(
  internals: HarnessInternals,
  session: Session,
  agentId: string,
  opts: EnsureAgentOptions = {},
): Promise<Agent> {
  const live = session.agents.get(agentId);
  if (live !== undefined) return live;
  let perSession = internals.agents.get(session);
  if (perSession === undefined) {
    perSession = new Map();
    internals.agents.set(session, perSession);
  }
  let runtime = perSession.get(agentId);
  if (runtime === undefined) {
    runtime = createAgentRuntime(agentId, opts);
    perSession.set(agentId, runtime);
  }
  return session.open(agentId, agentCaps(runtime, opts));
}

export function createHarness(options: CreateHarnessOptions = {}): Harness {
  const space = options.space ?? memoryHarnessSpace();
  const app = createApp({ space, scope: options.scope });
  const internals: HarnessInternals = { space, agents: new WeakMap(), writers: new Map() };
  internalsByApp.set(app, internals);
  return {
    app,
    ensureAgent: (session, agentId = MAIN_AGENT_ID, opts) => ensureAgent(internals, session, agentId, opts),
    close: async () => {
      await app.close();
      for (const writer of internals.writers.values()) await writer.close();
    },
  };
}
