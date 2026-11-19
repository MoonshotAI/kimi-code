type ExecutionLease = (() => void) & { ready: Promise<void> };

export async function prepareBrowserExecution(retain: () => ExecutionLease, timeoutMs = 3000, settle?: (remainingMs: number) => Promise<unknown>): Promise<() => void> {
  const lease = retain();
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lease.ready,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Session state loading timed out')), timeoutMs); }),
    ]);
    if (Date.now() >= deadline) throw new Error('Session state loading timed out');
    if (settle !== undefined) await settle(Math.max(deadline - Date.now(), 0));
    return lease;
  } catch (error) {
    lease();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function browserCommandTakesControl(action: string): boolean {
  return action === 'create_tab' || action === 'activate_tab';
}

export interface BrowserCommandSession {
  receivedAt: number;
  controlled: boolean;
  resolving: () => boolean;
  prepare: (timeoutMs: number) => Promise<() => void>;
}

export interface BrowserCommandGateOptions {
  timeoutMs?: number;
  now?: () => number;
  watchResolving?: (sessionId: string, ended: () => void) => () => void;
}

export function createBrowserCommandGate({ timeoutMs = 3000, now = Date.now, watchResolving }: BrowserCommandGateOptions = {}) {
  const windows = new Map<string, { deadline: number; stop: () => void }>();
  const end = (sessionId: string): void => {
    const window = windows.get(sessionId);
    if (window === undefined) return;
    windows.delete(sessionId);
    window.stop();
  };
  const budget = (sessionId: string, session: BrowserCommandSession): number => {
    let deadline = session.receivedAt + timeoutMs;
    if (session.resolving()) {
      const window = windows.get(sessionId);
      if (window === undefined) windows.set(sessionId, { deadline, stop: watchResolving?.(sessionId, () => end(sessionId)) ?? (() => {}) });
      else deadline = Math.min(deadline, window.deadline);
    } else end(sessionId);
    return Math.max(deadline - now(), 0);
  };
  return {
    async enter(action: string, sessionId: string, session: BrowserCommandSession, allowIdleRun = false): Promise<(() => void) | undefined> {
      if (allowIdleRun) return undefined;
      if (browserCommandTakesControl(action)) return session.prepare(budget(sessionId, session));
      if (action !== 'get_state' || !session.controlled || !session.resolving()) {
        if (!session.resolving()) end(sessionId);
        return undefined;
      }
      const remaining = budget(sessionId, session);
      if (remaining <= 0) return undefined;
      const release = await session.prepare(remaining).catch(() => undefined);
      if (!session.resolving()) end(sessionId);
      return release;
    },
  };
}
