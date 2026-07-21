/**
 * App shell — selection state and session resume. There is no live event
 * push anymore: the v2 socket (`/api/v2/ws`) that fed the core/session/agent
 * event streams was removed server-side, so Service panels and the pending
 * interactions card fetch on demand and the sidebar polls.
 * Layout: header / icon rail / view. The `chat` view is the classic trio
 * (left sidebar with workspaces + sessions, chat, inspector); the `models`
 * view is the full-width model catalog.
 */

import { useEffect, useState } from 'react';

import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';

import { ChatView } from './components/ChatView';
import { Inspector } from './components/Inspector';
import { ModelCatalogView } from './components/ModelCatalogView';
import { NavRail, type AppView } from './components/NavRail';
import { ServerSwitcher } from './components/ServerSwitcher';
import { Sidebar } from './components/Sidebar';
import { useConnection } from './connection';
import { errorMessage } from './ui';

export function App() {
  const { klient, baseUrl, disconnect } = useConnection();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState('main');
  const [view, setView] = useState<AppView>('chat');
  const [ready, setReady] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>(null);

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
  // belong to the server they were listed from.
  useEffect(() => {
    setSessionId(null);
    setAgentId('main');
  }, [baseUrl]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-1.5">
        <span className="text-[12px] font-bold tracking-widest text-neutral-200">KIMI INSPECT</span>
        <ServerSwitcher />
        <div className="flex-1" />
        <button
          className="text-[11px] text-neutral-500 hover:text-neutral-300"
          onClick={disconnect}
        >
          Disconnect
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <NavRail view={view} onChange={setView} />
        {view === 'models' ? (
          <ModelCatalogView
            onOpenSession={(id) => {
              setSessionId(id);
              setView('chat');
            }}
          />
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
