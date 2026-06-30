import { useEffect, useMemo, useState } from 'react';

import { useSession } from '../../hooks/useSession';
import { useWire } from '../../hooks/useWire';
import {
  analyzeWire,
  type Analysis,
  type StepNode,
  type ToolCallNode,
  type TurnNode,
} from '../../lib/analysis';
import type { WireEntry } from '../../types';
import { formatBytes } from '../shared/SizePreview';
import { formatDuration, formatTokens } from '../../util/time';
import { Pill } from '../shared/Pill';

interface TimelineTabProps {
  sessionId: string;
}

/** Timeline tab — the agent's execution folded into turns → steps → tool
 *  calls, with the derived metrics the flat record list does not surface:
 *  durations, per-turn token cost, context-window growth, cache-hit rate,
 *  tool latency, truncation, and idle gaps. All computed client-side from
 *  the same wire the Wire tab fetches. */
export function TimelineTab({ sessionId }: TimelineTabProps) {
  const { data: detail } = useSession(sessionId);
  const [agentId, setAgentId] = useState('main');
  // Reset the selected agent when navigating to another session while this tab
  // stays mounted; otherwise a previously-selected subagent would 404 against
  // the new session (mirrors WireTab/ContextTab).
  useEffect(() => {
    setAgentId('main');
  }, [sessionId]);
  const { data: wire, isLoading, error } = useWire(sessionId, agentId);

  const analysis = useMemo<Analysis | null>(() => {
    if (!wire) return null;
    return analyzeWire(wire.records as WireEntry[]);
  }, [wire]);

  const agents = detail?.agents ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
        <label className="flex items-center gap-2 font-mono text-[11px] text-fg-2">
          <span className="text-fg-3">agent</span>
          <select
            value={agentId}
            onChange={(ev) => { setAgentId(ev.target.value); }}
            className="border border-border bg-surface-0 px-2 py-1 font-mono text-[12px] text-fg-0 focus:border-border-strong focus:outline-none"
          >
            {agents.length === 0 ? <option value={agentId}>{agentId}</option> : null}
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentId} ({a.type})
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? (
        <div className="p-6 font-mono text-[12px] text-fg-3">analyzing…</div>
      ) : error ? (
        <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">{error.message}</div>
      ) : analysis === null || analysis.summary.turnCount === 0 ? (
        <div className="p-6 font-mono text-[12px] text-fg-3">no turns to analyze in this agent's wire</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SummaryGrid analysis={analysis} />
          <ContextSparkline analysis={analysis} />
          <ConfigChanges analysis={analysis} />
          <ToolStatsTable analysis={analysis} />
          <IdleGaps analysis={analysis} />
          <section className="mt-6">
            <SectionTitle>turns · {analysis.turns.length}</SectionTitle>
            <div className="mt-2 flex flex-col gap-2">
              {analysis.turns.map((turn) => (
                <TurnCard key={turn.index} turn={turn} />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: import('react').ReactNode }) {
  return <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">{children}</h3>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="border border-border bg-surface-0 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">{label}</div>
      <div className="mt-0.5 font-mono text-[14px] tabular" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

function SummaryGrid({ analysis }: { analysis: Analysis }) {
  const s = analysis.summary;
  const hit = analysis.cache.hitRate;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      <Stat label="turns" value={String(s.turnCount)} />
      <Stat label="steps" value={String(s.stepCount)} />
      <Stat label="tool calls" value={String(s.toolCallCount)} />
      <Stat
        label="tool errors"
        value={String(s.toolErrorCount)}
        tone={s.toolErrorCount > 0 ? 'var(--color-sev-error)' : undefined}
      />
      <Stat label="total tokens" value={formatTokens(s.totalTokens)} />
      <Stat label="peak context" value={formatTokens(s.peakContextTokens)} />
      <Stat label="cache hit" value={hit === null ? '—' : `${(hit * 100).toFixed(0)}%`} />
      <Stat label="active / wall" value={`${formatDuration(s.activeMs)} / ${formatDuration(s.wallClockMs)}`} />
    </div>
  );
}

function ContextSparkline({ analysis }: { analysis: Analysis }) {
  const pts = analysis.contextSeries;
  if (pts.length < 2) return null;
  const peak = analysis.summary.peakContextTokens || 1;
  const W = 600;
  const H = 44;
  const dx = W / (pts.length - 1);
  const path = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * dx).toFixed(1)} ${(H - (p.contextTokens / peak) * H).toFixed(1)}`)
    .join(' ');
  return (
    <section className="mt-6">
      <SectionTitle>context-window fill over steps · peak {formatTokens(peak)}</SectionTitle>
      <div className="mt-2 border border-border bg-surface-0 p-3">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-12 w-full">
          <path d={path} fill="none" stroke="var(--color-cat-conversation)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-fg-3">
          <span>step 1</span>
          <span>step {pts.length}</span>
        </div>
      </div>
    </section>
  );
}

function ToolStatsTable({ analysis }: { analysis: Analysis }) {
  if (analysis.toolStats.length === 0) return null;
  return (
    <section className="mt-6">
      <SectionTitle>tool usage · {analysis.toolStats.length} distinct</SectionTitle>
      <div className="mt-2 overflow-x-auto border border-border bg-surface-0">
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="border-b border-border text-fg-3">
              <Th align="left">tool</Th><Th>calls</Th><Th>errors</Th><Th>truncated</Th>
              <Th>avg</Th><Th>max</Th><Th>output</Th>
            </tr>
          </thead>
          <tbody>
            {analysis.toolStats.map((t) => (
              <tr key={t.name} className="border-b border-border/50">
                <td className="px-2 py-1 text-fg-0">{t.name}</td>
                <Td>{t.count}</Td>
                <Td tone={t.errorCount > 0 ? 'var(--color-sev-error)' : undefined}>{t.errorCount}</Td>
                <Td tone={t.truncatedCount > 0 ? 'var(--color-sev-warning)' : undefined}>{t.truncatedCount}</Td>
                <Td>{formatDuration(t.avgMs)}</Td>
                <Td>{formatDuration(t.maxMs)}</Td>
                <Td>{formatBytes(t.totalOutputBytes)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children, align = 'right' }: { children: import('react').ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-2 py-1 font-normal ${align === 'left' ? 'text-left' : 'text-right tabular'}`}>{children}</th>;
}
function Td({ children, tone }: { children: import('react').ReactNode; tone?: string }) {
  return <td className="px-2 py-1 text-right tabular text-fg-1" style={tone ? { color: tone } : undefined}>{children}</td>;
}

function ConfigChanges({ analysis }: { analysis: Analysis }) {
  if (analysis.configChanges.length === 0) return null;
  return (
    <section className="mt-6">
      <SectionTitle>config changes · {analysis.configChanges.length}</SectionTitle>
      <div className="mt-2 flex flex-col gap-1">
        {analysis.configChanges.map((c) => (
          <div key={c.lineNo} className="flex flex-wrap items-center gap-2 border border-border bg-surface-0 px-3 py-1.5 font-mono text-[11px]">
            <span className="text-fg-3 tabular">line {c.lineNo}</span>
            {c.changed.map((ch) => (
              <Pill key={ch.field} tone="config" variant="outline">
                {ch.field}={ch.value}
              </Pill>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function IdleGaps({ analysis }: { analysis: Analysis }) {
  const gaps = analysis.idleGaps.slice(0, 5);
  if (gaps.length === 0) return null;
  return (
    <section className="mt-6">
      <SectionTitle>longest idle gaps</SectionTitle>
      <div className="mt-2 flex flex-col gap-1">
        {gaps.map((g, i) => (
          <div key={i} className="flex items-center gap-3 border border-border bg-surface-0 px-3 py-1.5 font-mono text-[11px]">
            <Pill tone={g.kind === 'between_turns' ? 'meta' : 'warning'} variant="outline">
              {g.kind === 'between_turns' ? 'waiting' : 'in-turn'}
            </Pill>
            <span className="text-fg-0 tabular">{formatDuration(g.gapMs)}</span>
            <span className="ml-auto text-fg-3 tabular">line {g.afterLineNo} → {g.beforeLineNo}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TurnCard({ turn }: { turn: TurnNode }) {
  const [open, setOpen] = useState(turn.index === 0);
  const totalTokens = turn.tokens.inputOther + turn.tokens.output + turn.tokens.inputCacheRead + turn.tokens.inputCacheCreation;
  return (
    <div className="border border-border bg-surface-0">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); }}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-surface-1"
      >
        <span className="text-fg-3">{open ? '▾' : '▸'}</span>
        <Pill tone={turn.trigger === 'steer' ? 'turn' : 'conversation'} variant="outline">
          turn {turn.index}{turn.trigger === 'steer' ? ' (steer)' : ''}
        </Pill>
        {turn.originKind && turn.originKind !== 'user' ? (
          <Pill tone="meta" variant="outline">{turn.originKind}</Pill>
        ) : null}
        {turn.cancelled ? <Pill tone="warning">cancelled</Pill> : null}
        {turn.toolErrorCount > 0 ? <Pill tone="error">{turn.toolErrorCount} err</Pill> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-1" title={turn.promptText}>
          {turn.promptText || '(no prompt text)'}
        </span>
        <span className="flex shrink-0 items-center gap-3 font-mono text-[11px] text-fg-3 tabular">
          <span>{turn.steps.length} steps</span>
          <span>{turn.toolCallCount} tools</span>
          <span title="total tokens processed this turn">{formatTokens(totalTokens)} tok</span>
          <span title="active execution time">{formatDuration(turn.durationMs)}</span>
        </span>
      </button>

      {open ? (
        <div className="border-t border-border px-3 py-2">
          {turn.waitBeforeMs !== undefined && turn.waitBeforeMs >= 1000 ? (
            <div className="mb-2 font-mono text-[10px] text-fg-3">
              ⏱ waited {formatDuration(turn.waitBeforeMs)} before this turn
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            {turn.steps.map((step) => (
              <StepRow key={step.uuid} step={step} turnDurationMs={turn.durationMs} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ step, turnDurationMs }: { step: StepNode; turnDurationMs?: number }) {
  const widthPct = turnDurationMs && step.durationMs ? Math.max(2, (step.durationMs / turnDurationMs) * 100) : 0;
  return (
    <div className="border-l-2 pl-2" style={{ borderColor: step.isError ? 'var(--color-sev-error)' : 'var(--color-border)' }}>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="text-fg-2">step {step.step}</span>
        {step.finishReason ? (
          <span className={step.isError ? 'text-[var(--color-sev-error)]' : 'text-fg-3'}>{step.finishReason}</span>
        ) : null}
        <span className="text-fg-3 tabular" title="step wall-clock duration">{formatDuration(step.durationMs)}</span>
        {step.llmFirstTokenLatencyMs !== undefined ? (
          <span
            className="text-fg-3 tabular"
            title={
              step.llmServerFirstTokenMs !== undefined && step.llmRequestBuildMs !== undefined
                ? `time to first token (api ${step.llmServerFirstTokenMs}ms + client ${step.llmRequestBuildMs}ms)`
                : 'time to first token'
            }
          >
            ttft {step.llmFirstTokenLatencyMs}ms
            {step.llmServerFirstTokenMs !== undefined && step.llmRequestBuildMs !== undefined
              ? ` (api ${step.llmServerFirstTokenMs} + client ${step.llmRequestBuildMs})`
              : ''}
          </span>
        ) : null}
        {step.llmServerDecodeMs !== undefined && step.llmClientConsumeMs !== undefined ? (
          <span
            className="text-fg-3 tabular"
            title="decode window split (server awaiting parts + client processing parts)"
          >
            decode {step.llmServerDecodeMs}+{step.llmClientConsumeMs}ms
          </span>
        ) : null}
        {step.contextTokens !== undefined ? (
          <span className="text-fg-3 tabular" title="context-window fill after step">ctx {formatTokens(step.contextTokens)}</span>
        ) : null}
        {step.content.thinkChars > 0 ? <span className="text-[var(--color-cat-meta)]" title="reasoning chars">💭 {step.content.thinkChars}</span> : null}
      </div>
      {widthPct > 0 ? (
        <div className="mt-0.5 h-1 w-full bg-surface-2">
          <div className="h-1" style={{ width: `${widthPct}%`, backgroundColor: step.isError ? 'var(--color-sev-error)' : 'var(--color-cat-conversation)' }} />
        </div>
      ) : null}
      {step.toolCalls.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {step.toolCalls.map((tc) => (
            <ToolRow key={tc.toolCallId} tc={tc} stepDurationMs={step.durationMs} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolRow({ tc, stepDurationMs }: { tc: ToolCallNode; stepDurationMs?: number }) {
  const widthPct = stepDurationMs && tc.durationMs ? Math.max(2, (tc.durationMs / stepDurationMs) * 100) : 0;
  return (
    <div className="flex flex-wrap items-center gap-2 pl-3 font-mono text-[11px]">
      <span className="text-[var(--color-cat-tools)]">{tc.name}</span>
      <span className="text-fg-3 tabular" title="call → result elapsed">{formatDuration(tc.durationMs)}</span>
      {tc.outputBytes !== undefined ? (
        <span className="text-fg-3 tabular" title="result output size">{formatBytes(tc.outputBytes)}</span>
      ) : null}
      {tc.isError ? <Pill tone="error" variant="outline">error</Pill> : null}
      {tc.truncated ? <Pill tone="warning" variant="outline">truncated</Pill> : null}
      {tc.resultLineNo === undefined ? <Pill tone="warning" variant="outline">no result</Pill> : null}
      {widthPct > 0 ? (
        <div className="ml-auto h-1 w-24 bg-surface-2">
          <div className="h-1" style={{ width: `${widthPct}%`, backgroundColor: tc.isError ? 'var(--color-sev-error)' : 'var(--color-cat-tools)' }} />
        </div>
      ) : null}
    </div>
  );
}
