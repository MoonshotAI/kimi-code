import { firstDelimitedText, textAttributes } from './textElements';

export interface SwarmResultSubagent {
  outcome: string;
  item?: string;
  agentId?: string;
  mode?: string;
  state?: string;
  body: string;
}

export interface SwarmResult {
  summary: string;
  completed: number;
  failed: number;
  aborted: number;
  total: number;
  subagents: SwarmResultSubagent[];
  resumeHint?: string;
}

const SUBAGENT_CLOSE = '</subagent>';
const COUNT_RE = /(completed|failed|aborted):\s*(\d+)/g;

function unescapeAttr(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(textAttributes(raw, /[a-z_]/))) {
    attrs[name] = unescapeAttr(value);
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

type RowFrame = { attrs: string; bodyStart: number };

function parseSubagent(attrs: string, body: string): SwarmResultSubagent {
  const parsed = parseAttrs(attrs);
  return {
    outcome: parsed['outcome'] ?? 'completed',
    item: parsed['item'],
    agentId: parsed['agent_id'],
    mode: parsed['mode'],
    state: parsed['state'],
    body: body.trim(),
  };
}

function parseSubagents(text: string): SwarmResultSubagent[] {
  const subs: SwarmResultSubagent[] = [];
  const stack: (RowFrame | null)[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start === -1) break;
    cursor = start + 1;
    if (text.startsWith(SUBAGENT_CLOSE, start)) {
      cursor = start + SUBAGENT_CLOSE.length;
      const frame = stack.pop();
      if (frame && stack.length === 0) {
        subs.push(parseSubagent(frame.attrs, text.slice(frame.bodyStart, start)));
      }
    } else if (text.startsWith('<subagent', start) && !/\w/.test(text[start + 9] ?? '')) {
      const end = text.indexOf('>', start + 9);
      if (end === -1) break;
      cursor = end + 1;
      stack.push(stack.length === 0 ? { attrs: text.slice(start + 9, end), bodyStart: cursor } : null);
    }
  }
  return subs;
}

export function parseSwarmResult(output: string[] | string | undefined | null): SwarmResult | null {
  if (output === undefined || output === null) return null;
  const text = Array.isArray(output) ? output.join('\n') : output;
  if (!text.includes('<agent_swarm_result>')) return null;

  const summary = firstDelimitedText(text, '<summary>', '</summary>')?.trim() ?? '';
  const { completed, failed, aborted } = parseCounts(summary);
  const resumeHint = firstDelimitedText(text, '<resume_hint>', '</resume_hint>')?.trim();
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
