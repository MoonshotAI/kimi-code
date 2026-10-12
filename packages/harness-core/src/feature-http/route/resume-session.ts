import type { AppCommands, SessionHandle } from '@moonshot-ai/agent-core';

const pendingResumes = new WeakMap<AppCommands, Map<string, Promise<SessionHandle | undefined>>>();

export async function resumeSession(
  app: AppCommands,
  sessionId: string,
): Promise<SessionHandle | undefined> {
  const live = app.get(sessionId);
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
    const session = await app.open({ sessionId });
    for (const agentId of Object.keys(session.stores.session.getState().roster.agents)) {
      if (session.get(agentId) !== undefined) continue;
      await session.create({ agentId }).catch(() => undefined);
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
