import type { App, AppSession } from '#/app/index';

const pendingResumes = new WeakMap<App, Map<string, Promise<AppSession | undefined>>>();

export async function resumeSession(app: App, sessionId: string): Promise<AppSession | undefined> {
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
    const session = await app.open(sessionId);
    for (const agentId of Object.keys(session.roster.getState().agents)) {
      if (session.liveAgents.get(agentId) !== undefined) continue;
      await session.ensureAgent(agentId).catch(() => undefined);
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
