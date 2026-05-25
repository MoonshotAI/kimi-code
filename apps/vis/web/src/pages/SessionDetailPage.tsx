import { useParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { CopyButton } from '../components/shared/CopyButton';
import { formatAbsoluteTime, formatRelativeTime } from '../util/time';

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();

  const { data: session, isLoading, error } = useSession(sessionId);

  if (!sessionId) return <div className="p-6 text-fg-3">(no session id)</div>;
  if (isLoading) return <div className="p-6 font-mono text-[12px] text-fg-3">loading session…</div>;
  if (error)
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {error.message}
      </div>
    );
  if (!session) return null;

  const state = session.state as {
    title?: string;
    lastPrompt?: string;
    updatedAt?: string;
    createdAt?: string;
  } | null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[14px] text-fg-0">{session.sessionId}</span>
          <CopyButton value={session.sessionId} />
          {state?.title ? (
            <span className="font-mono text-[12px] text-fg-1">"{state.title}"</span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-fg-2">
          {state?.updatedAt ? (
            <span className="text-fg-3 tabular">
              updated {formatRelativeTime(Date.parse(state.updatedAt))} ·{' '}
              {formatAbsoluteTime(Date.parse(state.updatedAt))}
            </span>
          ) : null}
        </div>
        {state?.lastPrompt ? (
          <div className="mt-1 truncate font-mono text-[11px] text-fg-3" title={state.lastPrompt}>
            prompt · {state.lastPrompt}
          </div>
        ) : null}
      </div>

      <div className="flex flex-1 items-center justify-center p-6 font-mono text-[12px] text-fg-3">
        <div className="text-center">
          <div>session detail UI rewrite in progress</div>
          <div className="mt-2 text-fg-3">
            {session.agents.length} agent(s); main exists:{' '}
            {String(session.agents.some((a) => a.agentId === 'main' && a.wireExists))}
          </div>
        </div>
      </div>
    </div>
  );
}
