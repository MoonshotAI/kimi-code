/**
 * App shell — selection state, session resume, and the three WS event
 * subscriptions that feed the live bus:
 *   core    `events`                — process-wide domain events
 *   session `interactions`          — pending approvals / questions
 *   agent   `events`                — the active agent's live event stream
 * Layout: header / left sidebar (workspaces + sessions) / chat / inspector.
 */

import { useEffect, useRef, useState } from 'react';

import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';

import { ChatView } from './components/ChatView';
import { Inspector } from './components/Inspector';
import { ServerSwitcher } from './components/ServerSwitcher';
import { Sidebar } from './components/Sidebar';
import { useConnection } from './connection';
import { LiveBusProvider, type Emit, type LiveEvent } from './live';
import { Badge, errorMessage } from './ui';

export function App() {
  const { klient, wsState, baseUrl, disconnect } = useConnection();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState('main');
  const [ready, setReady] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>(null);
  const emitRef = useRef<Emit | null>(null);
  const publish = (source: LiveEvent['source'], data: unknown) =>
    emitRef.current?.({ source, data, at: Date.now() });

  // Core events — for the lifetime of the connection.
  useEffect(() => {
    const sub = klient.ws().listen('events', (data) => publish('core', data));
    return () => sub.dispose();
  }, [klient]);

  // Session interactions — re-subscribe when the session changes.
  useEffect(() => {
    if (sessionId === null || !ready) return;
    const session = klient.ws().session(sessionId);
    const a = session.listen('interactions', (data) => publish('session', data));
    const b = session.listen('interactions:resolved', (data) => publish('session', data));
    return () => {
      a.dispose();
      b.dispose();
    };
  }, [klient, sessionId, ready]);

  // Agent events — re-subscribe when session or agent changes.
  useEffect(() => {
    if (sessionId === null || !ready) return;
    const sub = klient
      .ws()
      .session(sessionId)
      .agent(agentId)
      .listen('events', (data) => publish('agent', data));
    return () => sub.dispose();
  }, [klient, sessionId, agentId, ready]);

  // Resume (materialize) the session on the server when it is selected, so
  // session / agent scoped Services become reachable.
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    setReady(false);
    setResumeError(null);
    klient
      .core(ISessionLifecycleService)
      .resume(sessionId)
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setResumeError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [klient, sessionId]);

  // Switching servers invalidates every session/agent selection: sessions
  // belong to the server they were listed from. The client and its WS
  // subscriptions rebuild from the new config on their own.
  useEffect(() => {
    setSessionId(null);
    setAgentId('main');
  }, [baseUrl]);

  return (
    <LiveBusProvider busRef={emitRef}>
      <div className="flex h-screen flex-col">
        <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-1.5">
          <span className="text-[12px] font-bold tracking-widest text-neutral-200">KIMI INSPECT</span>
          <ServerSwitcher />
          <Badge tone={wsState === 'open' ? 'green' : wsState === 'connecting' ? 'amber' : 'red'}>
            ws: {wsState}
          </Badge>
          <div className="flex-1" />
          <button
            className="text-[11px] text-neutral-500 hover:text-neutral-300"
            onClick={disconnect}
          >
            Disconnect
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <Sidebar activeSessionId={sessionId} onSelectSession={setSessionId} />
          {resumeError !== null ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-red-400">
              Failed to open session: {errorMessage(resumeError)}
            </div>
          ) : (
            <ChatView sessionId={sessionId} agentId={agentId} ready={ready} />
          )}
          <Inspector
            sessionId={sessionId}
            agentId={agentId}
            onAgentChange={setAgentId}
            ready={ready}
          />
        </div>
      </div>
    </LiveBusProvider>
  );
}
