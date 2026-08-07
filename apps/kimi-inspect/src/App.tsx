/**
 * App shell — selection state and session resume. There is no live event
 * push anymore: the v2 socket (`/api/v2/ws`) that fed the core/session/agent
 * event streams was removed server-side, so Service panels and the pending
 * interactions card fetch on demand and the sidebar polls.
 * Layout: header / icon rail / view. The `chat` view is a strip of the
 * left sidebar (workspaces + sessions), the session pane (session Services
 * / State tabs), the chat column, and the right dock (`RightPanel`) merging
 * the transcript audit and the agent inspector under Audit / Agent tabs;
 * the `models` view is the full-width model catalog; the `services` view is
 * the full-width app-scope Service reflection (`AppServicesView`); the
 * `workspace` view is the workspace-scope counterpart
 * (`WorkspaceServicesView`, with a workspace picker on top); the
 * `bash` view is the full-width `IBashParserService` playground
 * (`BashParserView`); the `di` view is the engine's Service × Effect × DI
 * debug surface (`DiInspectionView`); the `search` view is the full-width
 * global message search (`SearchView`) whose hits navigate back into the
 * chat timeline.
 */

import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/sessionLifecycle';
import { useEffect, useState } from 'react';

import type { AuditTrail } from './audit/trail';
import { AppServicesView } from './components/AppServicesView';
import { BashParserView } from './components/BashParserView';
import { ChatView, type ChatJump } from './components/ChatView';
import { DiInspectionView } from './components/DiInspectionView';
import { ModelCatalogView } from './components/ModelCatalogView';
import { NavRail, type AppView } from './components/NavRail';
import { RightPanel } from './components/RightPanel';
import { SearchView } from './components/SearchView';
import { ServerSwitcher } from './components/ServerSwitcher';
import { SessionPane } from './components/SessionPane';
import { Sidebar } from './components/Sidebar';
import { WorkspaceServicesView } from './components/WorkspaceServicesView';
import { useConnection } from './connection';
import type { SearchHit } from './search/api';
import { errorMessage } from './ui';

export function App() {
  const { klient, baseUrl, disconnect } = useConnection();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState('main');
  const [view, setView] = useState<AppView>('chat');
  const [ready, setReady] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>(null);
  /** Audit trail of the chat view's transcript channel, rendered in the right dock. */
  const [trail, setTrail] = useState<AuditTrail | null>(null);
  /** Pending chat navigation requested from another view (search result click). */
  const [jump, setJump] = useState<ChatJump | null>(null);

  // Resume (materialize) the session on the server when it is selected, so
  // session / agent scoped Services become reachable. Session lifecycle lives
  // on the workspace handler (Workspace scope): the index yields the
  // session's workspaceId, then the handler resumes it.
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    setReady(false);
    setResumeError(null);
    klient
      .core(ISessionIndex)
      .get(sessionId)
      .then((summary) => {
        if (summary === undefined) throw new Error(`session ${sessionId} does not exist`);
        return klient
          .workspace(summary.workspaceId)
          .service(ISessionLifecycleService)
          .resume(sessionId);
      })
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
    setJump(null);
  }, [baseUrl]);

  // A search hit opens the chat view at its session / agent / turn / step.
  // Title hits belong to the session (agent '') and carry no turn: switch
  // over without a scroll target.
  const openSearchHit = (hit: SearchHit): void => {
    setSessionId(hit.sessionId);
    setAgentId(hit.agentId === '' ? 'main' : hit.agentId);
    setView('chat');
    setJump({
      turnId: hit.turn === undefined ? undefined : `t${hit.turn}`,
      stepId: hit.stepId,
      nonce: Date.now(),
    });
  };

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
        {view === 'services' ? (
          <AppServicesView />
        ) : view === 'workspace' ? (
          <WorkspaceServicesView />
        ) : view === 'bash' ? (
          <BashParserView />
        ) : view === 'di' ? (
          <DiInspectionView />
        ) : view === 'models' ? (
          <ModelCatalogView
            onOpenSession={(id) => {
              setSessionId(id);
              setView('chat');
            }}
          />
        ) : view === 'search' ? (
          <SearchView onOpenResult={openSearchHit} />
        ) : (
          <>
            <Sidebar activeSessionId={sessionId} onSelectSession={setSessionId} />
            <SessionPane sessionId={sessionId} ready={ready} />
            {resumeError !== null ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-red-400">
                Failed to open session: {errorMessage(resumeError)}
              </div>
            ) : (
              <ChatView
                sessionId={sessionId}
                agentId={agentId}
                ready={ready}
                onTrailChange={setTrail}
                jump={jump}
                onJumpHandled={() => setJump(null)}
                onOpenSearchHit={openSearchHit}
              />
            )}
            <RightPanel
              sessionId={sessionId}
              agentId={agentId}
              onAgentChange={setAgentId}
              ready={ready}
              trail={trail}
            />
          </>
        )}
      </div>
    </div>
  );
}
