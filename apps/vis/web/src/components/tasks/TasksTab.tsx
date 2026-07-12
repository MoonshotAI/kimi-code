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
import { t } from '../../i18n';

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
    return <div className="p-6 font-mono text-[12px] text-fg-3">{t('tasks.loading')}</div>;
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
        {t('tasks.backgroundTasks')}{tasks.length > 0 ? ` · ${tasks.length}` : ''}
      </div>
      {tasks.length === 0 ? (
        <div className="mt-3 border border-border bg-surface-0 px-3 py-6 text-center font-mono text-[12px] text-fg-3">
          {t('tasks.noTasksForSession')}
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
          <Pill tone="subagent" variant="outline" title={t('tasks.spawnedBy')}>
            {entry.agentId}
          </Pill>
        ) : null}
        {task.detached === false ? (
          <Pill tone="warning" variant="outline">{t('tasks.foreground')}</Pill>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-fg-3 tabular" title={formatAbsoluteTime(task.startedAt)}>
          {t('tasks.started')} {formatRelativeTime(task.startedAt)}
        </span>
      </div>

      {/* Body fields */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-3 py-2 md:grid-cols-2">
        <Field label={t('tasks.description')}>{task.description || <Dim>{t('tasks.none')}</Dim>}</Field>
        {task.kind === 'process' ? (
          <>
            <Field label={t('tasks.command')}><code className="break-all">{task.command}</code></Field>
            <Field label={t('tasks.pid')}>{task.pid}</Field>
            <Field label={t('tasks.exitCode')}>
              {task.exitCode ?? <Dim>{t('tasks.running')}</Dim>}
            </Field>
          </>
        ) : null}
        {task.kind === 'agent' ? (
          <>
            <Field label={t('tasks.agentId')}>
              {task.agentId ? (
                <Link
                  to={`/sessions/${sessionId}/agents/${task.agentId}`}
                  className="text-[var(--color-cat-subagent)] underline-offset-2 hover:underline"
                  title={t('tasks.openSubagentWire')}
                >
                  {task.agentId} →
                </Link>
              ) : (
                <Dim>{t('tasks.none')}</Dim>
              )}
            </Field>
            <Field label={t('tasks.subagentType')}>{task.subagentType ?? <Dim>{t('tasks.none')}</Dim>}</Field>
          </>
        ) : null}
        {task.kind === 'question' ? (
          <>
            <Field label={t('tasks.questionCount')}>{task.questionCount}</Field>
            <Field label={t('tasks.toolCallId')}>{task.toolCallId ?? <Dim>{t('tasks.none')}</Dim>}</Field>
          </>
        ) : null}
        <Field label={t('tasks.duration')}>
          {duration === null ? <Dim>{t('tasks.unfinished')}</Dim> : `${duration} ms`}
        </Field>
        {task.timeoutMs !== undefined ? (
          <Field label={t('tasks.timeoutMs')}>{task.timeoutMs}</Field>
        ) : null}
        {task.stopReason ? <Field label={t('tasks.stopReason')}>{task.stopReason}</Field> : null}
        <Field label={t('tasks.endedAt')}>
          {task.endedAt === null || task.endedAt === undefined ? (
            <Dim>{t('tasks.running')}</Dim>
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
          title={entry.outputExists ? t('tasks.viewOutput') : t('tasks.noOutput')}
        >
          {showLog ? '▾' : '▸'} {t('tasks.outputLog')}{' '}
          <span className="text-fg-3">
            {entry.outputExists ? formatBytes(entry.outputSizeBytes) : t('tasks.none')}
          </span>
        </button>
        <button
          type="button"
          onClick={() => { setShowRaw((v) => !v); }}
          className="ml-auto font-mono text-[11px] text-fg-3 hover:text-fg-1"
        >
          {showRaw ? t('tasks.hideRaw') : t('tasks.rawJson')}
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
        <span>{t('tasks.outputLog')}</span>
        <span className="tabular">
          {formatBytes(Math.min(cursor, size))} / {formatBytes(size)}
        </span>
        {!eof && cursor > 0 ? (
          <span className="text-[var(--color-sev-warning)]">{t('tasks.moreBelow')}</span>
        ) : null}
        <span className="ml-auto"><CopyButton value={content} label={t('shared.copy')} /></span>
      </div>
      {err !== null ? (
        <div className="border-t border-border px-3 py-2 font-mono text-[11px] text-[var(--color-sev-error)]">
          {err}
        </div>
      ) : null}
      <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 font-mono text-[11px] leading-[1.5] text-fg-1">
        {content || (loading ? t('tasks.loadingLog') : t('tasks.empty'))}
      </pre>
      {!eof && cursor > 0 ? (
        <button
          type="button"
          onClick={() => { void loadFrom(cursor); }}
          disabled={loading}
          className="w-full border-t border-border px-3 py-1.5 font-mono text-[11px] text-fg-2 hover:bg-surface-2 hover:text-fg-0 disabled:opacity-50"
        >
          {loading ? t('tasks.loading') : t('tasks.loadMore', { remaining: formatBytes(size - cursor) })}
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
