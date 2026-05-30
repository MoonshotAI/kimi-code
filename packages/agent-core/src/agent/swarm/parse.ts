import type { ReviseDecision, SwarmPlan, Subtask } from './types';

export function extractJsonObject(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

export function parsePlan(rootTask: string, text: string): SwarmPlan | null {
  const json = extractJsonObject(text);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const subtasksRaw = (parsed as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(subtasksRaw) || subtasksRaw.length === 0) return null;

  const subtasks: Subtask[] = [];
  for (let i = 0; i < subtasksRaw.length; i += 1) {
    const raw = subtasksRaw[i];
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const role = o['role'];
    const systemPrompt = o['systemPrompt'];
    const prompt = o['prompt'];
    // Required fields must be present AND non-empty: an empty/whitespace-only
    // role/systemPrompt/prompt would spawn a worker with no identity or
    // instructions, so reject the plan and let decompose's retry re-prompt the
    // planner (mirrors the reviser's non-empty validation in parseReviseDecision).
    if (
      typeof role !== 'string' ||
      role.trim().length === 0 ||
      typeof systemPrompt !== 'string' ||
      systemPrompt.trim().length === 0 ||
      typeof prompt !== 'string' ||
      prompt.trim().length === 0
    ) {
      return null;
    }
    const toolAllowlist = Array.isArray(o['toolAllowlist'])
      ? o['toolAllowlist'].filter((t): t is string => typeof t === 'string')
      : undefined;
    subtasks.push({
      id: typeof o['id'] === 'string' && o['id'].length > 0 ? o['id'] : `task-${String(i + 1)}`,
      role,
      systemPrompt,
      prompt,
      toolAllowlist,
      status: 'pending',
      attempts: 0,
    });
  }
  return { rootTask, subtasks };
}

/**
 * Parse a reviser subagent's decision about a single failed subtask. Returns
 * `null` on any malformed input (missing/invalid `kind` or required per-variant
 * fields) so the caller can apply a conservative fallback.
 */
export function parseReviseDecision(text: string): ReviseDecision | null {
  const json = extractJsonObject(text);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  switch (o['kind']) {
    case 'retry':
      return { kind: 'retry' };
    case 'regenerate':
      if (typeof o['prompt'] !== 'string' || o['prompt'].length === 0) return null;
      return { kind: 'regenerate', prompt: o['prompt'] };
    case 'reassign': {
      if (typeof o['role'] !== 'string' || o['role'].length === 0) return null;
      if (typeof o['systemPrompt'] !== 'string' || o['systemPrompt'].length === 0) return null;
      const toolAllowlist = Array.isArray(o['toolAllowlist'])
        ? o['toolAllowlist'].filter((t): t is string => typeof t === 'string')
        : undefined;
      return toolAllowlist === undefined
        ? { kind: 'reassign', role: o['role'], systemPrompt: o['systemPrompt'] }
        : { kind: 'reassign', role: o['role'], systemPrompt: o['systemPrompt'], toolAllowlist };
    }
    case 'drop':
      if (typeof o['reason'] !== 'string' || o['reason'].length === 0) return null;
      return { kind: 'drop', reason: o['reason'] };
    default:
      return null;
  }
}
