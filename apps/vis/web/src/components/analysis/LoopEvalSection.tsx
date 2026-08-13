import type {
  LoopEvaluation,
  PromptPhaseEvaluation,
  SteerComparison,
} from '../../lib/loop-eval';
import { CopyButton } from '../shared/CopyButton';
import { Pill } from '../shared/Pill';

interface LoopEvalSectionProps {
  evaluation: LoopEvaluation;
}

export function LoopEvalSection({ evaluation }: LoopEvalSectionProps) {
  const phases = evaluation.phases.filter(
    (phase) => phase.toolCallCount > 0 || phase.markers.length > 0,
  );
  if (phases.length === 0) return null;

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>repetition eval</SectionTitle>
        <CopyButton
          value={JSON.stringify(evaluation, null, 2)}
          label="copy eval JSON"
          title="Copy aggregate repetition evaluation JSON"
        />
      </div>
      <EvalSummary evaluation={evaluation} />
      <PhaseTable
        phases={phases}
        repetitionWindowCalls={evaluation.settings.repetitionWindowCalls}
      />
      <SteerTable
        comparisons={evaluation.steerComparisons}
        comparisonCalls={evaluation.settings.steerComparisonCalls}
      />
    </section>
  );
}

function EvalSummary({ evaluation }: { evaluation: LoopEvaluation }) {
  const summary = evaluation.summary;
  const longest = summary.longestExactRun;
  const peak = summary.peakRepetitionWindow;
  const steerOverlap = summary.meanCompleteSteerHistogramOverlap;

  return (
    <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Metric
        label="exact repeats"
        value={`${String(summary.repeatedCallCount)} / ${String(summary.toolCallCount)}`}
        detail={percent(summary.repeatedCallRate)}
        title="Calls whose exact tool and canonical arguments appeared earlier in the same prompt phase"
      />
      <Metric
        label="longest exact run"
        value={longest === null ? '-' : `${String(longest.length)}x ${longest.toolName}`}
        detail={longest === null ? '-' : `phase ${String(longest.phaseIndex)}`}
        title={
          longest === null
            ? undefined
            : `wire lines ${String(longest.startLineNo)}-${String(longest.endLineNo)}`
        }
      />
      <Metric
        label={`peak ${String(evaluation.settings.repetitionWindowCalls)}-call repeat`}
        value={peak === null ? '-' : percent(peak.repeatedCallRate)}
        detail={peak === null ? '-' : `phase ${String(peak.phaseIndex)}`}
        title={
          peak === null
            ? 'No phase has a complete rolling window'
            : `wire lines ${String(peak.startLineNo)}-${String(peak.endLineNo)}`
        }
      />
      <Metric
        label="mean steer overlap"
        value={steerOverlap === null ? '-' : percent(steerOverlap)}
        detail={`${String(summary.completeSteerComparisonCount)} complete windows`}
        title="Mean exact-call histogram intersection across complete before/after steer windows"
      />
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  title,
}: {
  label: string;
  value: string;
  detail: string;
  title?: string;
}) {
  return (
    <div className="border border-border bg-surface-0 px-3 py-2" title={title}>
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-[13px] tabular text-fg-0">
        {value}
      </div>
      <div className="font-mono text-[10px] tabular text-fg-3">{detail}</div>
    </div>
  );
}

function PhaseTable({
  phases,
  repetitionWindowCalls,
}: {
  phases: readonly PromptPhaseEvaluation[];
  repetitionWindowCalls: number;
}) {
  return (
    <div className="mt-2 max-h-80 overflow-auto border border-border bg-surface-0">
      <table className="w-full min-w-[760px] font-mono text-[11px]">
        <thead className="sticky top-0 bg-surface-1">
          <tr className="border-b border-border text-fg-3">
            <Th align="left">phase</Th>
            <Th>calls</Th>
            <Th>distinct</Th>
            <Th>repeats</Th>
            <Th>max run</Th>
            <Th>{repetitionWindowCalls}-call peak</Th>
            <Th>steers</Th>
            <Th>cancels</Th>
            <Th>cmp markers</Th>
          </tr>
        </thead>
        <tbody>
          {phases.map((phase) => (
            <PhaseRow key={phase.index} phase={phase} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhaseRow({ phase }: { phase: PromptPhaseEvaluation }) {
  const steerCount = markerCount(phase, 'steer');
  const cancelCount = markerCount(phase, 'cancel');
  const compactionCount = markerCount(phase, 'compaction');
  const run = phase.longestExactRun;
  const peak = phase.peakRepetitionWindow;
  const phaseTitle =
    phase.promptLineNo === null
      ? `before first prompt at line ${String(phase.nextPromptLineNo ?? '-')}`
      : `prompt line ${String(phase.promptLineNo)}, next prompt ${String(phase.nextPromptLineNo ?? '-')}`;

  return (
    <tr className="border-b border-border/50">
      <td className="px-2 py-1 text-left text-fg-0" title={phaseTitle}>
        {phase.index === 0 ? '0 (preamble)' : phase.index}
      </td>
      <Td>{phase.toolCallCount}</Td>
      <Td>{phase.distinctCallCount}</Td>
      <Td title={`${String(phase.repeatedCallCount)} non-first exact calls`}>
        {percent(phase.repeatedCallRate)}
      </Td>
      <Td
        title={
          run === null
            ? undefined
            : `${run.toolName}, lines ${String(run.startLineNo)}-${String(run.endLineNo)}`
        }
      >
        {run === null ? '-' : `${String(run.length)}x`}
      </Td>
      <Td
        title={
          peak === null
            ? undefined
            : `${String(peak.repeatedCallCount)} repeats, lines ${String(peak.startLineNo)}-${String(peak.endLineNo)}`
        }
      >
        {peak === null ? '-' : percent(peak.repeatedCallRate)}
      </Td>
      <Td>{steerCount}</Td>
      <Td>{cancelCount}</Td>
      <Td>{compactionCount}</Td>
    </tr>
  );
}

function SteerTable({
  comparisons,
  comparisonCalls,
}: {
  comparisons: readonly SteerComparison[];
  comparisonCalls: number;
}) {
  if (comparisons.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">
        steer response, {comparisonCalls} calls per side
      </div>
      <div className="max-h-56 overflow-auto border border-border bg-surface-0">
        <table className="w-full min-w-[620px] font-mono text-[11px]">
          <thead className="sticky top-0 bg-surface-1">
            <tr className="border-b border-border text-fg-3">
              <Th align="left">steer</Th>
              <Th>phase</Th>
              <Th>calls before / after</Th>
              <Th>distinct before / after</Th>
              <Th>histogram overlap</Th>
              <Th>window</Th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((comparison) => (
              <tr
                key={`${String(comparison.phaseIndex)}:${String(comparison.steerLineNo)}`}
                className="border-b border-border/50"
              >
                <td className="px-2 py-1 text-left text-fg-0">
                  line {comparison.steerLineNo}
                </td>
                <Td>{comparison.phaseIndex}</Td>
                <Td>{comparison.beforeCallCount} / {comparison.afterCallCount}</Td>
                <Td>{comparison.beforeDistinctCallCount} / {comparison.afterDistinctCallCount}</Td>
                <Td
                  title="Exact-call histogram intersection: 0 is disjoint, 100% is identical"
                >
                  {comparison.histogramOverlap === null
                    ? '-'
                    : percent(comparison.histogramOverlap)}
                </Td>
                <td className="px-2 py-1 text-right">
                  <Pill tone="meta" variant="outline">
                    {comparison.complete ? 'complete' : 'partial'}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function markerCount(
  phase: PromptPhaseEvaluation,
  kind: PromptPhaseEvaluation['markers'][number]['kind'],
): number {
  return phase.markers.filter((marker) => marker.kind === kind).length;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function SectionTitle({ children }: { children: import('react').ReactNode }) {
  return (
    <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
      {children}
    </h3>
  );
}

function Th({
  children,
  align = 'right',
}: {
  children: import('react').ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`px-2 py-1 font-normal ${align === 'left' ? 'text-left' : 'text-right tabular'}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  title,
}: {
  children: import('react').ReactNode;
  title?: string;
}) {
  return (
    <td className="px-2 py-1 text-right tabular text-fg-1" title={title}>
      {children}
    </td>
  );
}
