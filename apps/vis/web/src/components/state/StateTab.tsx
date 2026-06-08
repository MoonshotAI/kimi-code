import { useMemo } from 'react';

import { formatAbsoluteTime, formatRelativeTime } from '../../util/time';
import { CopyButton } from '../shared/CopyButton';
import { JsonViewer } from '../shared/JsonViewer';
import { Pill } from '../shared/Pill';

interface StateTabProps {
  state: unknown;
}

interface StateJsonShape {
  title?: string;
  isCustomTitle?: boolean;
  lastPrompt?: string;
  forkedFrom?: string;
  createdAt?: string;
  updatedAt?: string;
  agents?: Record<string, unknown>;
  custom?: Record<string, unknown> & { imported_from_kimi_cli?: boolean };
}

/** State tab — renders the raw `state.json` blob from session detail.
 *  At the top, a handful of highlight cards surface the most-asked fields
 *  (title / lastPrompt / created / updated / agent count). Below that, the
 *  full JSON is shown via the shared JsonViewer so any custom fields the
 *  upstream writer adds remain readable without code changes. */
export function StateTab({ state }: StateTabProps) {
  const s = useMemo<StateJsonShape>(() => {
    return (state ?? {}) as StateJsonShape;
  }, [state]);

  const createdMs = parseIso(s.createdAt);
  const updatedMs = parseIso(s.updatedAt);
  const agentIds = s.agents !== undefined ? Object.keys(s.agents) : [];
  const importedFromKimiCli = s.custom?.imported_from_kimi_cli === true;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
          state.json
        </div>
        <CopyButton value={JSON.stringify(s, null, 2)} label="copy json" />
      </div>

      {importedFromKimiCli ? (
        <div className="mt-3 border border-[var(--color-sev-warning)] bg-[color-mix(in_oklab,var(--color-sev-warning)_10%,transparent)] px-3 py-2 font-mono text-[11px] text-[var(--color-sev-warning)]">
          warning · this session is marked
          <code className="mx-1 px-1 bg-surface-0">imported_from_kimi_cli</code>
          and would normally be filtered out of the list.
        </div>
      ) : null}

      {/* Highlight cards */}
      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        <Card label="title">
          {s.title !== undefined && s.title !== '' ? (
            <span className="font-mono text-[12px] text-fg-0">"{s.title}"</span>
          ) : (
            <span className="font-mono text-[12px] text-fg-3">(none)</span>
          )}
          {s.isCustomTitle === true ? (
            <Pill tone="config" variant="outline">
              custom
            </Pill>
          ) : null}
        </Card>

        <Card label="forkedFrom">
          {s.forkedFrom !== undefined && s.forkedFrom !== '' ? (
            <span className="font-mono text-[12px] text-fg-0 break-all">
              {s.forkedFrom}
            </span>
          ) : (
            <span className="font-mono text-[12px] text-fg-3">(none)</span>
          )}
        </Card>

        <Card label="createdAt">
          <TsValue ms={createdMs} raw={s.createdAt} />
        </Card>

        <Card label="updatedAt">
          <TsValue ms={updatedMs} raw={s.updatedAt} />
        </Card>

        <Card label="lastPrompt">
          {s.lastPrompt !== undefined && s.lastPrompt !== '' ? (
            <span
              className="font-mono text-[12px] text-fg-0 line-clamp-3"
              title={s.lastPrompt}
            >
              {s.lastPrompt}
            </span>
          ) : (
            <span className="font-mono text-[12px] text-fg-3">(none)</span>
          )}
        </Card>

        <Card label={`agents (${agentIds.length})`}>
          {agentIds.length === 0 ? (
            <span className="font-mono text-[12px] text-fg-3">(none)</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1">
              {agentIds.map((id) => (
                <span
                  key={id}
                  className="border border-border bg-surface-1 px-1.5 py-0.5 font-mono text-[11px] text-fg-1"
                >
                  {id}
                </span>
              ))}
            </span>
          )}
        </Card>
      </div>

      {/* Custom blob */}
      <section className="mt-6">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
          custom
        </h3>
        <div className="mt-2 border border-border bg-surface-0 p-3">
          {s.custom === undefined || Object.keys(s.custom).length === 0 ? (
            <span className="font-mono text-[11px] text-fg-3">(empty)</span>
          ) : (
            <JsonViewer value={s.custom} defaultOpenDepth={2} />
          )}
        </div>
      </section>

      {/* Raw JSON */}
      <section className="mt-6">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
          raw state.json
        </h3>
        <div className="mt-2 border border-border bg-surface-0 p-3">
          <JsonViewer value={s} defaultOpenDepth={2} />
        </div>
      </section>
    </div>
  );
}

function Card({ label, children }: { label: string; children: import('react').ReactNode }) {
  return (
    <div className="border border-border bg-surface-0 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">
        {label}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function TsValue({ ms, raw }: { ms: number | null; raw: string | undefined }) {
  if (ms === null) {
    return raw !== undefined && raw !== '' ? (
      <span className="font-mono text-[12px] text-fg-3 break-all">{raw}</span>
    ) : (
      <span className="font-mono text-[12px] text-fg-3">(none)</span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[12px] text-fg-0 tabular">
        {formatAbsoluteTime(ms)}
      </span>
      <span className="font-mono text-[11px] text-fg-3">
        ({formatRelativeTime(ms)})
      </span>
    </span>
  );
}

function parseIso(input: string | undefined): number | null {
  if (input === undefined || input === '') return null;
  const n = Date.parse(input);
  return Number.isFinite(n) ? n : null;
}
