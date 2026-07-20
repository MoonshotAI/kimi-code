import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../api';
import { CopyButton } from '../components/shared/CopyButton';
import { TabBar, useActiveTab } from '../components/layout/TabBar';
import { TimelineTab } from '../components/analysis/TimelineTab';
import { ContextTab } from '../components/context/ContextTab';
import { CronTab } from '../components/tasks/CronTab';
import { LogsTab } from '../components/logs/LogsTab';
import { StateTab } from '../components/state/StateTab';
import { SubagentsTab } from '../components/subagents/SubagentsTab';
import { TasksTab } from '../components/tasks/TasksTab';
import { WireTab } from '../components/wire/WireTab';
import { Pill } from '../components/shared/Pill';
import { useSession } from '../hooks/useSession';
import { useCron, useTasks } from '../hooks/useTasks';
import { formatAbsoluteTime, formatRelativeTime } from '../util/time';

type TabId = 'wire' | 'timeline' | 'context' | 'agents' | 'tasks' | 'cron' | 'logs' | 'state';

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const active = useActiveTab('wire') as TabId;
  const { data: session, isLoading, error } = useSession(sessionId);
  const { data: tasksData } = useTasks(sessionId);
  const { data: cronData } = useCron(sessionId);

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
          {session.imported ? (
            <Pill tone="subagent" variant="outline">imported</Pill>
          ) : null}
          {state?.title ? (
            <span className="font-mono text-[12px] text-fg-1">"{state.title}"</span>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <RevealButton sessionId={sessionId} />
            <CopyButton value={session.sessionDir} label="copy path" />
          </span>
        </div>
        {session.imported && session.importMeta ? (
          <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10.5px] text-fg-3">
            {session.importMeta.manifest?.kimiCodeVersion ? (
              <span>kimi-code v{session.importMeta.manifest.kimiCodeVersion}</span>
            ) : null}
            {session.importMeta.manifest?.os ? <span>· {session.importMeta.manifest.os}</span> : null}
            {session.importMeta.manifest?.exportedAt ? (
              <span>· exported {formatRelativeTime(Date.parse(session.importMeta.manifest.exportedAt))}</span>
            ) : null}
            {session.importMeta.originalName ? <span>· {session.importMeta.originalName}</span> : null}
          </div>
        ) : null}
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
          { id: 'timeline', label: 'Timeline', count: null },
          { id: 'context', label: 'Context', count: null },
          { id: 'agents', label: 'Agents', count: subagentCount },
          { id: 'tasks', label: 'Tasks', count: tasksData?.tasks.length ?? null },
          { id: 'cron', label: 'Cron', count: cronData?.cron.length ?? null },
          { id: 'logs', label: 'Logs', count: null },
          { id: 'state', label: 'State', count: null },
        ]}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {active === 'wire' ? <WireTab sessionId={sessionId} /> : null}
        {active === 'timeline' ? <TimelineTab sessionId={sessionId} /> : null}
        {active === 'context' ? <ContextTab sessionId={sessionId} /> : null}
        {active === 'agents' ? <SubagentsTab sessionId={sessionId} /> : null}
        {active === 'tasks' ? <TasksTab sessionId={sessionId} /> : null}
        {active === 'cron' ? <CronTab sessionId={sessionId} /> : null}
        {active === 'logs' ? <LogsTab sessionId={sessionId} /> : null}
        {active === 'state' ? <StateTab state={session.state} importMeta={session.importMeta} /> : null}
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
