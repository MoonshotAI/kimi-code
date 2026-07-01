import type { CronTask } from '../../types';
import { formatAbsoluteTime, formatRelativeTime } from '../../util/time';
import { useCron } from '../../hooks/useTasks';
import { CopyButton } from '../shared/CopyButton';
import { Pill } from '../shared/Pill';

interface CronTabProps {
  sessionId: string;
}

/** Cron tab — scheduled prompts persisted under the session's `cron/`
 *  directory. Like background tasks, none of this is in the wire, so it is
 *  the only place to see what a session has scheduled. */
export function CronTab({ sessionId }: CronTabProps) {
  const { data, isLoading, error } = useCron(sessionId);

  if (isLoading) {
    return <div className="p-6 font-mono text-[12px] text-fg-3">loading cron…</div>;
  }
  if (error) {
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {error.message}
      </div>
    );
  }
  const cron = data?.cron ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
        cron jobs{cron.length > 0 ? ` · ${cron.length}` : ''}
      </div>
      {cron.length === 0 ? (
        <div className="mt-3 border border-border bg-surface-0 px-3 py-6 text-center font-mono text-[12px] text-fg-3">
          no cron jobs were scheduled in this session
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {cron.map((job) => (
            <CronCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

function CronCard({ job }: { job: CronTask }) {
  // `recurring` is undefined/true → recurring by convention; false → one-shot.
  const oneShot = job.recurring === false;
  return (
    <div className="border border-border bg-surface-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Pill tone={oneShot ? 'ephemeral' : 'lifecycle'} variant="outline">
          {oneShot ? 'one-shot' : 'recurring'}
        </Pill>
        <code className="font-mono text-[12px] text-fg-0">{job.cron}</code>
        <span className="font-mono text-[11px] text-fg-3">{job.id}</span>
        <CopyButton value={job.id} />
        <span
          className="ml-auto font-mono text-[11px] text-fg-3 tabular"
          title={formatAbsoluteTime(job.createdAt)}
        >
          created {formatRelativeTime(job.createdAt)}
        </span>
      </div>
      <div className="px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.1em] text-fg-3">prompt</div>
        <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] text-fg-1">
          {job.prompt}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-t border-border px-3 py-2 md:grid-cols-2">
        <Field label="lastFiredAt">
          {job.lastFiredAt === undefined ? (
            <span className="text-fg-3">(never fired)</span>
          ) : (
            <span title={formatAbsoluteTime(job.lastFiredAt)}>
              {formatAbsoluteTime(job.lastFiredAt)} ({formatRelativeTime(job.lastFiredAt)})
            </span>
          )}
        </Field>
        <Field label="createdAt">{formatAbsoluteTime(job.createdAt)}</Field>
      </div>
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
