import type { WireEntry } from '../types';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueKind =
  | 'orphan_tool_call'
  | 'missing_tool_result'
  | 'tool_error'
  | 'tool_truncated'
  | 'model_filtered'
  | 'model_max_tokens'
  | 'incomplete_step'
  | 'incomplete_compaction'
  | 'active_plan_mode'
  | 'rejected_approval'
  | 'wire_warning';

export interface Issue {
  severity: IssueSeverity;
  kind: IssueKind;
  lineNo: number | null;
  summary: string;
  detail?: string;
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function computeIssues(
  entries: readonly WireEntry[],
  warnings: readonly string[],
): Issue[] {
  const out: Issue[] = [];

  const toolCallById = new Map<string, { lineNo: number; name: string }>();
  const stepBeginByUuid = new Map<string, { lineNo: number; step: number; turnId: string }>();
  let lastCompactionBegin: { lineNo: number; source: string } | null = null;
  let lastPlanEnter: { lineNo: number; id: string } | null = null;

  for (const entry of entries) {
    const r = entry.data;
    const lineNo = entry.lineNo;
    switch (r.type) {
      case 'context.append_loop_event': {
        const ev = r.event;
        if (ev.type === 'tool.call') {
          toolCallById.set(ev.toolCallId, { lineNo, name: ev.name });
        } else if (ev.type === 'tool.result') {
          const open = toolCallById.get(ev.toolCallId);
          if (open !== undefined) {
            toolCallById.delete(ev.toolCallId);
          } else {
            out.push({
              severity: 'warning',
              kind: 'missing_tool_result',
              lineNo,
              summary: `orphan tool.result for #${ev.toolCallId.slice(-8)}`,
              detail: 'no preceding tool.call seen',
            });
          }
          const result = ev.result as { truncated?: boolean; message?: string; note?: string };
          if (ev.result.isError === true) {
            out.push({
              severity: 'error',
              kind: 'tool_error',
              lineNo,
              summary: `${open?.name ?? 'tool'}#${ev.toolCallId.slice(-8)} returned an error`,
              detail: result.message ?? result.note,
            });
          }
          if (result.truncated === true) {
            out.push({
              severity: 'info',
              kind: 'tool_truncated',
              lineNo,
              summary: `${open?.name ?? 'tool'}#${ev.toolCallId.slice(-8)} output truncated`,
              detail: 'the model saw a paged/dropped partial result',
            });
          }
        } else if (ev.type === 'step.begin') {
          stepBeginByUuid.set(ev.uuid, {
            lineNo,
            step: ev.step ?? -1,
            turnId: ev.turnId ?? '',
          });
        } else if (ev.type === 'step.end') {
          stepBeginByUuid.delete(ev.uuid);
          if (ev.finishReason === 'filtered') {
            out.push({
              severity: 'error',
              kind: 'model_filtered',
              lineNo,
              summary: `step ${ev.step} response filtered by the provider`,
              detail: ev.rawFinishReason ?? ev.providerFinishReason,
            });
          } else if (ev.finishReason === 'max_tokens') {
            out.push({
              severity: 'warning',
              kind: 'model_max_tokens',
              lineNo,
              summary: `step ${ev.step} hit the output token cap`,
              detail: 'the response was cut short at max_tokens',
            });
          }
        }
        break;
      }

      case 'full_compaction.begin':
        lastCompactionBegin = { lineNo, source: r.source };
        break;
      case 'full_compaction.complete':
      case 'full_compaction.cancel':
        lastCompactionBegin = null;
        break;

      case 'plan_mode.enter':
        lastPlanEnter = { lineNo, id: r.id };
        break;
      case 'plan_mode.cancel':
      case 'plan_mode.exit':
        lastPlanEnter = null;
        break;

      case 'permission.record_approval_result':
        if (r.result.decision === 'rejected') {
          out.push({
            severity: 'info',
            kind: 'rejected_approval',
            lineNo,
            summary: `${r.toolName}#${r.toolCallId.slice(-8)} rejected`,
            detail: r.result.feedback,
          });
        }
        break;

      default:
        break;
    }
  }

  for (const [id, info] of toolCallById) {
    out.push({
      severity: 'warning',
      kind: 'orphan_tool_call',
      lineNo: info.lineNo,
      summary: `${info.name}#${id.slice(-8)} has no tool.result`,
      detail: 'tool.call recorded but no matching tool.result found',
    });
  }
  for (const [uuid, info] of stepBeginByUuid) {
    out.push({
      severity: 'warning',
      kind: 'incomplete_step',
      lineNo: info.lineNo,
      summary: `step ${info.step} (turn ${info.turnId}) has no step.end`,
      detail: `uuid ${uuid.slice(-8)}`,
    });
  }
  if (lastCompactionBegin !== null) {
    out.push({
      severity: 'warning',
      kind: 'incomplete_compaction',
      lineNo: lastCompactionBegin.lineNo,
      summary: `${lastCompactionBegin.source} compaction never completed`,
    });
  }
  if (lastPlanEnter !== null) {
    out.push({
      severity: 'info',
      kind: 'active_plan_mode',
      lineNo: lastPlanEnter.lineNo,
      summary: `plan mode still active: ${lastPlanEnter.id}`,
    });
  }

  for (const w of warnings) {
    out.push({
      severity: 'info',
      kind: 'wire_warning',
      lineNo: null,
      summary: firstLine(w),
    });
  }

  out.sort((a, b) => {
    const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (d !== 0) return d;
    const sa = a.lineNo ?? Number.POSITIVE_INFINITY;
    const sb = b.lineNo ?? Number.POSITIVE_INFINITY;
    return sa - sb;
  });

  return out;
}

export function topSeverity(issues: readonly Issue[]): IssueSeverity | null {
  if (issues.length === 0) return null;
  for (const i of issues) if (i.severity === 'error') return 'error';
  for (const i of issues) if (i.severity === 'warning') return 'warning';
  return 'info';
}

function firstLine(s: string): string {
  const trimmed = s.trim();
  const nl = trimmed.indexOf('\n');
  const one = nl === -1 ? trimmed : trimmed.slice(0, nl);
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
}
