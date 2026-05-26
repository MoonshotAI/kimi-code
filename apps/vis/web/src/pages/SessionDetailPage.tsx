import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../api';
import { CopyButton } from '../components/shared/CopyButton';
import { TabBar, useActiveTab } from '../components/layout/TabBar';
import { ContextTab } from '../components/context/ContextTab';
import { StateTab } from '../components/state/StateTab';
import { SubagentsTab } from '../components/subagents/SubagentsTab';
import { WireTab } from '../components/wire/WireTab';
import { useSession } from '../hooks/useSession';
import { formatAbsoluteTime, formatRelativeTime } from '../util/time';

type TabId = 'wire' | 'context' | 'agents' | 'state';

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const active = useActiveTab('wire') as TabId;
  const { data: session, isLoading, error } = useSession(sessionId);

  if (!sessionId) return <div className="p-6 text-fg-3">(no session id)</div>;
  if (isLoading) {
    return <div className="p-6 font-mono text-[12px] text-fg-3">loading session…</div>;
  }
  if (error) {
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {error.message}
      </div>
    );
  }
  if (!session) return null;

  const state = (session.state ?? null) as {
    title?: string;
    lastPrompt?: string;
    updatedAt?: string;
  } | null;

  const mainAgent = session.agents.find((a) => a.agentId === 'main') ?? null;
  const subagentCount = session.agents.filter((a) => a.agentId !== 'main').length;
  const wireRecords = mainAgent?.wireRecordCount ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[14px] text-fg-0">{session.sessionId}</span>
          <CopyButton value={session.sessionId} />
          {state?.title ? (
            <span className="font-mono text-[12px] text-fg-1">"{state.title}"</span>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <RevealButton sessionId={sessionId} />
            <CopyButton value={session.sessionDir} label="copy path" />
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-fg-2">
          {state?.updatedAt ? (
            <span className="text-fg-3 tabular">
              updated {formatRelativeTime(Date.parse(state.updatedAt))} ·{' '}
              {formatAbsoluteTime(Date.parse(state.updatedAt))}
            </span>
          ) : null}
          {session.workDir ? (
            <span className="text-fg-3 truncate" title={session.workDir}>
              · {session.workDir}
            </span>
          ) : null}
        </div>
        <div
          className="mt-1 truncate font-mono text-[10px] text-fg-3"
          title={session.sessionDir}
        >
          {session.sessionDir}
        </div>
        {state?.lastPrompt ? (
          <div className="mt-1 truncate font-mono text-[11px] text-fg-3" title={state.lastPrompt}>
            prompt · {state.lastPrompt}
          </div>
        ) : null}
      </div>

      <TabBar
        defaultTab="wire"
        tabs={[
          { id: 'wire', label: 'Wire', count: wireRecords },
          { id: 'context', label: 'Context', count: null },
          { id: 'agents', label: 'Agents', count: subagentCount },
          { id: 'state', label: 'State', count: null },
        ]}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {active === 'wire' ? <WireTab sessionId={sessionId} /> : null}
        {active === 'context' ? <ContextTab sessionId={sessionId} /> : null}
        {active === 'agents' ? <SubagentsTab sessionId={sessionId} /> : null}
        {active === 'state' ? <StateTab state={session.state} /> : null}
      </div>
    </div>
  );
}

function RevealButton({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<'idle' | 'opening' | 'err'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  return (
    <button
      type="button"
      onClick={() => {
        setState('opening');
        setErrMsg(null);
        api
          .revealSession(sessionId)
          .then(() => {
            setState('idle');
          })
          .catch((err: unknown) => {
            setState('err');
            setErrMsg(err instanceof Error ? err.message : String(err));
            setTimeout(() => {
              setState('idle');
              setErrMsg(null);
            }, 2500);
          });
      }}
      className={`border border-border px-2 py-0.5 font-mono text-[11px] ${
        state === 'err'
          ? 'text-[var(--color-sev-error)]'
          : 'text-fg-2 hover:border-border-strong hover:text-fg-0'
      }`}
      title={state === 'err' && errMsg ? errMsg : 'reveal session folder in OS file manager'}
    >
      {state === 'opening' ? 'opening…' : state === 'err' ? '✗ failed' : '↗ open folder'}
    </button>
  );
}
