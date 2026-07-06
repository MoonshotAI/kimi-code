// apps/kimi-web/src/lib/parseSwarmResult.ts
// Parse the `<agent_swarm_result>` payload returned by the AgentSwarm tool
// (see packages/agent-core/.../agent-swarm.ts renderSwarmResults). The result
// arrives as a plain string inside the toolResult output; the swarm card turns
// it into a structured aggregate view. Defensive: never throws.

export interface SwarmResultSubagent {
  outcome: string;
  item?: string;
  agentId?: string;
  mode?: string;
  state?: string;
  body: string;
}

export interface SwarmResult {
  /** Raw summary line, e.g. `completed: 8, failed: 2`. */
  summary: string;
  completed: number;
  failed: number;
  aborted: number;
  total: number;
  subagents: SwarmResultSubagent[];
  resumeHint?: string;
}

const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;
const RESUME_HINT_RE = /<resume_hint>([\s\S]*?)<\/resume_hint>/;
// Opening tag for a subagent row. Body parsing is done manually below so a
// literal `</subagent>` inside a subagent's output (e.g. the subagent is
// analyzing or emitting an AgentSwarm snippet) does not terminate the row
// early — producer writes body text unescaped.
const SUBAGENT_START_RE = /<subagent\b([^>]*)>/g;
const SUBAGENT_CLOSE = '</subagent>';
const COUNT_RE = /(completed|failed|aborted):\s*(\d+)/g;
const ATTR_RE = /([a-z_]+)="([^"]*)"/g;

function unescapeAttr(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]!] = unescapeAttr(m[2]!);
  }
  return attrs;
}

function parseCounts(summary: string): Pick<SwarmResult, 'completed' | 'failed' | 'aborted'> {
  const counts = { completed: 0, failed: 0, aborted: 0 };
  COUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COUNT_RE.exec(summary)) !== null) {
    const key = m[1] as 'completed' | 'failed' | 'aborted';
    counts[key] = Number(m[2]);
  }
  return counts;
}

function parseSubagents(text: string): SwarmResultSubagent[] {
  const subs: SwarmResultSubagent[] = [];
  SUBAGENT_START_RE.lastIndex = 0;
  const opens: { attrs: string; start: number; openEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = SUBAGENT_START_RE.exec(text)) !== null) {
    opens.push({ attrs: m[1] ?? '', start: m.index, openEnd: SUBAGENT_START_RE.lastIndex });
  }
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i]!;
    // Close tag: the last `</subagent>` before the next row's opening tag (or
    // document end), so embedded `</subagent>` text in the body is preserved
    // instead of truncating this subagent's output.
    const nextStart = opens[i + 1]?.start ?? text.length;
    const windowClose = text.lastIndexOf(SUBAGENT_CLOSE, nextStart - 1);
    const close = windowClose > open.openEnd ? windowClose : text.indexOf(SUBAGENT_CLOSE, open.openEnd);
    const body = close === -1 ? text.slice(open.openEnd) : text.slice(open.openEnd, close);
    const attrs = parseAttrs(open.attrs);
    subs.push({
      outcome: attrs['outcome'] ?? 'completed',
      item: attrs['item'],
      agentId: attrs['agent_id'],
      mode: attrs['mode'],
      state: attrs['state'],
      body: body.trim(),
    });
  }
  return subs;
}

export function parseSwarmResult(output: string[] | string | undefined | null): SwarmResult | null {
  if (output === undefined || output === null) return null;
  const text = Array.isArray(output) ? output.join('\n') : output;
  if (!text.includes('<agent_swarm_result>')) return null;

  const summary = SUMMARY_RE.exec(text)?.[1]?.trim() ?? '';
  const { completed, failed, aborted } = parseCounts(summary);
  const resumeHint = RESUME_HINT_RE.exec(text)?.[1]?.trim();
  const subagents = parseSubagents(text);

  const totalFromSummary = completed + failed + aborted;
  return {
    summary,
    completed,
    failed,
    aborted,
    total: totalFromSummary > 0 ? totalFromSummary : subagents.length,
    subagents,
    resumeHint,
  };
}
