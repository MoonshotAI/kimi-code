import type { Subtask, SwarmPlan } from './types';

/** Read-only default tool set for workers; planner may widen via toolAllowlist within the allowlist. */
export const DEFAULT_WORKER_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'WebSearch', 'FetchURL'];

/** Tool names a worker is allowed to request. Read-only for Phase 1 (no Write/Edit/Bash, no dispatch tools). */
export const ALLOWED_WORKER_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'FetchURL',
  'ReadMediaFile',
];

export const PLANNER_SYSTEM_PROMPT = [
  'You are a swarm planner. Decompose the user task into independent subtasks that can run in parallel.',
  'For each subtask invent a short role name, a focused system prompt for that role, and a concrete prompt.',
  'All workers are read-only. Optionally specify toolAllowlist to RESTRICT a subtask to a subset of the allowed tools; you cannot grant tools beyond the allowed list (anything else is ignored).',
  `Allowed tools: ${ALLOWED_WORKER_TOOLS.join(', ')}.`,
  'Output ONLY a JSON object, no prose, matching exactly:',
  '{"subtasks":[{"id":"task-1","role":"...","systemPrompt":"...","prompt":"...","toolAllowlist":["Read"]}]}',
  'Keep it to at most 6 subtasks. Each subtask must be self-contained (workers cannot see each other).',
].join('\n');

export function renderPlannerPrompt(rootTask: string): string {
  return `Task to decompose:\n${rootTask}\n\nReturn only the JSON plan.`;
}

export function renderPlannerRetryPrompt(rootTask: string, previous: string): string {
  return [
    `Task to decompose:\n${rootTask}`,
    '',
    'Your previous response was not valid JSON in the required shape:',
    previous.slice(0, 1000),
    '',
    'Return ONLY the JSON object, with a non-empty "subtasks" array. No prose, no code fences.',
  ].join('\n');
}

export const SYNTHESIZER_SYSTEM_PROMPT = [
  'You are a swarm synthesizer. You are given the original task and the outputs of several worker subagents.',
  'Merge them into one coherent, complete answer for the user.',
  'If a subtask failed or was dropped, surface the gap explicitly instead of inventing its content. Never pretend a dropped or failed subtask succeeded.',
].join('\n');

export function renderSynthesizerPrompt(plan: SwarmPlan): string {
  const blocks = plan.subtasks.map((st) => {
    let body: string;
    if (st.status === 'done') {
      body = st.result ?? '';
    } else if (st.status === 'dropped') {
      body = `[DROPPED: ${st.error ?? 'no reason given'}]`;
    } else {
      body = `[FAILED: ${st.error ?? 'unknown error'}]`;
    }
    return `### ${st.role} (${st.status})\n${body}`;
  });
  return [`Original task:\n${plan.rootTask}`, '', 'Worker outputs:', '', ...blocks].join('\n');
}

export const REVISER_SYSTEM_PROMPT = [
  'You are a swarm reviser. You are given ONE subtask that failed (a real error or a detected stall/loop) along with its error.',
  'Decide how to recover it by choosing exactly one of:',
  '- retry: re-run the subtask unchanged (use only for transient/flaky errors).',
  '- regenerate: re-run with a more specific, better-scoped prompt you provide.',
  '- reassign: re-run under a different role with a new system prompt (and optionally a restricted toolAllowlist).',
  '- drop: abandon the subtask when it is impossible or not worth retrying; give a short reason.',
  'For stalled or looping errors, prefer regenerate (with a tighter, more concrete prompt) or reassign — a plain retry will usually stall again.',
  `Tools available to workers: ${ALLOWED_WORKER_TOOLS.join(', ')} (toolAllowlist may only restrict to a subset).`,
  'Output ONLY a JSON object, no prose, matching exactly one of:',
  '{"kind":"retry"}',
  '{"kind":"regenerate","prompt":"..."}',
  '{"kind":"reassign","role":"...","systemPrompt":"...","toolAllowlist":["Read"]}',
  '{"kind":"drop","reason":"..."}',
].join('\n');

export function renderReviseSubtaskPrompt(subtask: Subtask, error: string | undefined): string {
  return [
    'A subtask failed. Decide how to recover it.',
    '',
    `Role: ${subtask.role}`,
    `System prompt: ${subtask.systemPrompt}`,
    `Prompt: ${subtask.prompt}`,
    `Attempts so far: ${String(subtask.attempts)}`,
    `Error: ${error ?? 'unknown error'}`,
    '',
    'Return ONLY the JSON decision object.',
  ].join('\n');
}
