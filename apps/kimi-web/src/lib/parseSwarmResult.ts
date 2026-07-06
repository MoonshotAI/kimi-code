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
const SUBAGENT_RE = /<subagent\b([^>]*)>([\s\S]*?)<\/subagent>/g;
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

export function parseSwarmResult(output: string[] | string | undefined | null): SwarmResult | null {
  if (output === undefined || output === null) return null;
  const text = Array.isArray(output) ? output.join('\n') : output;
  if (!text.includes('<agent_swarm_result>')) return null;

  const summary = SUMMARY_RE.exec(text)?.[1]?.trim() ?? '';
  const { completed, failed, aborted } = parseCounts(summary);
  const resumeHint = RESUME_HINT_RE.exec(text)?.[1]?.trim();

  const subagents: SwarmResultSubagent[] = [];
  SUBAGENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUBAGENT_RE.exec(text)) !== null) {
    const attrs = parseAttrs(m[1] ?? '');
    subagents.push({
      outcome: attrs['outcome'] ?? 'completed',
      item: attrs['item'],
      agentId: attrs['agent_id'],
      mode: attrs['mode'],
      state: attrs['state'],
      body: (m[2] ?? '').trim(),
    });
  }

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
