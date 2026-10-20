import type { App } from '@moonshot-ai/agent-core/app/index';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';

import { agentCaps, createAgentRuntime, harnessInternals } from '#/runtime/index';

const pendingResumes = new WeakMap<App, Map<string, Promise<Session | undefined>>>();

export async function ensureSessionAgent(app: App, session: Session, agentId: string): Promise<Agent> {
  const live = session.agents.get(agentId);
  if (live !== undefined) return live;
  const internals = harnessInternals(app);
  let perSession = internals.agents.get(session);
  if (perSession === undefined) {
    perSession = new Map();
    internals.agents.set(session, perSession);
  }
  let runtime = perSession.get(agentId);
  if (runtime === undefined) {
    runtime = createAgentRuntime(agentId);
    perSession.set(agentId, runtime);
  }
  return session.open(agentId, agentCaps(runtime));
}

export async function resumeSession(app: App, sessionId: string): Promise<Session | undefined> {
  const live = app.sessions.get(sessionId);
  if (live !== undefined) return live;
  let byApp = pendingResumes.get(app);
  if (byApp === undefined) {
    byApp = new Map();
    pendingResumes.set(app, byApp);
  }
  const pending = byApp.get(sessionId);
  if (pending !== undefined) return pending;
  const resume = (async () => {
    if ((await app.space.get(sessionId)) === undefined) return undefined;
    const session = await app.create({ sessionId });
    for (const agentId of Object.keys(session.roster.getState().agents)) {
      if (session.agents.get(agentId) !== undefined) continue;
      await ensureSessionAgent(app, session, agentId).catch(() => undefined);
    }
    return session;
  })();
  byApp.set(sessionId, resume);
  try {
    return await resume;
  } finally {
    if (byApp.get(sessionId) === resume) byApp.delete(sessionId);
  }
}
