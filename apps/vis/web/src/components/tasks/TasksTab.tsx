import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../../api';
import type { BackgroundTaskEntry, BackgroundTaskInfo, BackgroundTaskStatus } from '../../types';
import { formatAbsoluteTime, formatRelativeTime } from '../../util/time';
import { useTasks } from '../../hooks/useTasks';
import { CopyButton } from '../shared/CopyButton';
import { JsonViewer } from '../shared/JsonViewer';
import { formatBytes } from '../shared/SizePreview';
import { Pill, type PillTone } from '../shared/Pill';

interface TasksTabProps {
  sessionId: string;
}

const STATUS_TONE: Record<BackgroundTaskStatus, PillTone> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
  timed_out: 'warning',
  killed: 'warning',
  lost: 'neutral',
};

function kindTone(kind: BackgroundTaskInfo['kind']): PillTone {
  if (kind === 'agent') return 'subagent';
  if (kind === 'question') return 'approval';
  return 'tools';
}

/** Tasks tab — background tasks (bash processes, subagents, pending
 *  questions) persisted under the session's `tasks/` directory, plus their
 *  `output.log`. None of this is reconstructable from the wire, so it is the
 *  only place to inspect what a session spawned in the background. */
export function TasksTab({ sessionId }: TasksTabProps) {
  const { data, isLoading, error } = useTasks(sessionId);

  if (isLoading) {
    return <div className="p-6 font-mono text-[12px] text-fg-3">loading tasks…</div>;
  }
  if (error) {
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {error.message}
      </div>
    );
  }
  const tasks = data?.tasks ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
        background tasks{tasks.length > 0 ? ` · ${tasks.length}` : ''}
      </div>
      {tasks.length === 0 ? (
        <div className="mt-3 border border-border bg-surface-0 px-3 py-6 text-center font-mono text-[12px] text-fg-3">
          no background tasks were persisted for this session
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {tasks.map((entry) => (
            <TaskCard key={entry.task.taskId} sessionId={sessionId} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ sessionId, entry }: { sessionId: string; entry: BackgroundTaskEntry }) {
  const { task } = entry;
  const [showLog, setShowLog] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const duration =
    task.endedAt !== null && task.endedAt !== undefined
      ? task.endedAt - task.startedAt
      : null;

  return (
    <div className="border border-border bg-surface-0">
      {/* Header line */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Pill tone={kindTone(task.kind)} variant="outline">{task.kind}</Pill>
        <Pill tone={STATUS_TONE[task.status]}>{task.status}</Pill>
        <span className="font-mono text-[12px] text-fg-0">{task.taskId}</span>
        <CopyButton value={task.taskId} />
        {entry.agentId !== 'main' ? (
          <Pill tone="subagent" variant="outline" title="the agent that spawned this task">
            {entry.agentId}
          </Pill>
        ) : null}
        {task.detached === false ? (
          <Pill tone="warning" variant="outline">foreground</Pill>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-fg-3 tabular" title={formatAbsoluteTime(task.startedAt)}>
          started {formatRelativeTime(task.startedAt)}
        </span>
      </div>

      {/* Body fields */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-3 py-2 md:grid-cols-2">
        <Field label="description">{task.description || <Dim>(none)</Dim>}</Field>
        {task.kind === 'process' ? (
          <>
            <Field label="command"><code className="break-all">{task.command}</code></Field>
            <Field label="pid">{task.pid}</Field>
            <Field label="exitCode">
              {task.exitCode ?? <Dim>(running)</Dim>}
            </Field>
          </>
        ) : null}
        {task.kind === 'agent' ? (
          <>
            <Field label="agentId">
              {task.agentId ? (
                <Link
                  to={`/sessions/${sessionId}/agents/${task.agentId}`}
                  className="text-[var(--color-cat-subagent)] underline-offset-2 hover:underline"
                  title="open this subagent's wire"
                >
                  {task.agentId} →
                </Link>
              ) : (
                <Dim>(none)</Dim>
              )}
            </Field>
            <Field label="subagentType">{task.subagentType ?? <Dim>(none)</Dim>}</Field>
          </>
        ) : null}
        {task.kind === 'question' ? (
          <>
            <Field label="questionCount">{task.questionCount}</Field>
            <Field label="toolCallId">{task.toolCallId ?? <Dim>(none)</Dim>}</Field>
          </>
        ) : null}
        <Field label="duration">
          {duration === null ? <Dim>(unfinished)</Dim> : `${duration} ms`}
        </Field>
        {task.timeoutMs !== undefined ? (
          <Field label="timeoutMs">{task.timeoutMs}</Field>
        ) : null}
        {task.stopReason ? <Field label="stopReason">{task.stopReason}</Field> : null}
        <Field label="endedAt">
          {task.endedAt === null || task.endedAt === undefined ? (
            <Dim>(running)</Dim>
          ) : (
            <span title={formatAbsoluteTime(task.endedAt)}>{formatRelativeTime(task.endedAt)}</span>
          )}
        </Field>
      </div>

      {/* Toggles */}
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5">
        <button
          type="button"
          onClick={() => { setShowLog((v) => !v); }}
          className="font-mono text-[11px] text-fg-2 hover:text-fg-0"
          disabled={!entry.outputExists}
          title={entry.outputExists ? 'view output.log' : 'no output.log for this task'}
        >
          {showLog ? '▾' : '▸'} output.log{' '}
          <span className="text-fg-3">
            {entry.outputExists ? formatBytes(entry.outputSizeBytes) : '(none)'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => { setShowRaw((v) => !v); }}
          className="ml-auto font-mono text-[11px] text-fg-3 hover:text-fg-1"
        >
          {showRaw ? 'hide raw' : 'raw json'}
        </button>
      </div>

      {showLog && entry.outputExists ? (
        <TaskOutput sessionId={sessionId} taskId={task.taskId} />
      ) : null}
      {showRaw ? (
        <div className="border-t border-border bg-surface-0 px-3 py-2">
          <JsonViewer value={task} defaultOpenDepth={2} />
        </div>
      ) : null}
    </div>
  );
}

function TaskOutput({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  // Progressive byte-window paging: fetch the first window on mount, then
  // append subsequent windows on demand via the server-provided exact
  // `nextOffset` cursor. Keeps arbitrarily large logs readable in full.
  const [content, setContent] = useState('');
  const [cursor, setCursor] = useState(0);
  const [size, setSize] = useState(0);
  const [eof, setEof] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const loadFrom = useCallback(
    async (offset: number) => {
      setLoading(true);
      setErr(null);
      try {
        const w = await api.getTaskOutput(sessionId, taskId, offset);
        setContent((prev) => (offset === 0 ? w.content : prev + w.content));
        setCursor(w.nextOffset);
        setSize(w.size);
        setEof(w.eof);
      } catch (error) {
        setErr(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, taskId],
  );

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void loadFrom(0);
  }, [started, loadFrom]);

  return (
    <div className="border-t border-border bg-[var(--color-surface-0)]">
      <div className="flex items-center gap-2 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">
        <span>output.log</span>
        <span className="tabular">
          {formatBytes(Math.min(cursor, size))} / {formatBytes(size)}
        </span>
        {!eof && cursor > 0 ? (
          <span className="text-[var(--color-sev-warning)]">· more below</span>
        ) : null}
        <span className="ml-auto"><CopyButton value={content} label="copy" /></span>
      </div>
      {err !== null ? (
        <div className="border-t border-border px-3 py-2 font-mono text-[11px] text-[var(--color-sev-error)]">
          {err}
        </div>
      ) : null}
      <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 font-mono text-[11px] leading-[1.5] text-fg-1">
        {content || (loading ? 'loading log…' : '(empty)')}
      </pre>
      {!eof && cursor > 0 ? (
        <button
          type="button"
          onClick={() => { void loadFrom(cursor); }}
          disabled={loading}
          className="w-full border-t border-border px-3 py-1.5 font-mono text-[11px] text-fg-2 hover:bg-surface-2 hover:text-fg-0 disabled:opacity-50"
        >
          {loading ? 'loading…' : `load more (${formatBytes(size - cursor)} remaining)`}
        </button>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: import('react').ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 font-mono text-[12px]">
      <span className="w-28 shrink-0 text-[10px] uppercase tracking-[0.1em] text-fg-3">{label}</span>
      <span className="min-w-0 break-words text-fg-1">{children}</span>
    </div>
  );
}

function Dim({ children }: { children: import('react').ReactNode }) {
  return <span className="text-fg-3">{children}</span>;
}
