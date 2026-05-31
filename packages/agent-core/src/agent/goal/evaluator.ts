import type { Message, TokenUsage } from '@moonshot-ai/kosong';
import { emptyUsage } from '@moonshot-ai/kosong';

import type { LLM } from '../../loop/llm';
import type { GoalEvidence, GoalSnapshot } from '../../session/goal';

/**
 * Independent goal evaluator (Level-2). After each stopped main-agent step, the
 * continuation controller runs a separate no-tool judge over the conversation
 * to decide whether to continue, and uses that verdict — not the main model's
 * self-report alone — to drive terminal state.
 */
/**
 * There is deliberately no `impossible` verdict: an objective the judge deems
 * unachievable is reported as `blocked` (with a reason), the same resumable
 * stopped state as any other "cannot proceed". This keeps the lifecycle minimal
 * and lets the user resume or refine rather than hit a dead end.
 */
export type GoalEvaluatorVerdict = 'continue' | 'complete' | 'blocked' | 'no_progress';

const VERDICTS: ReadonlySet<string> = new Set<GoalEvaluatorVerdict>([
  'continue',
  'complete',
  'blocked',
  'no_progress',
]);

export interface GoalEvaluatorModelReport {
  readonly status: string;
  readonly reason?: string;
  readonly evidence?: readonly GoalEvidence[];
}

export interface GoalEvaluatorInput {
  readonly goal: GoalSnapshot;
  /** A bounded slice of the conversation to inspect. */
  readonly messages: readonly Message[];
  /** The latest UpdateGoal self-report, when present. */
  readonly modelReport?: GoalEvaluatorModelReport | undefined;
  readonly signal: AbortSignal;
}

export type GoalEvaluatorResult =
  | {
      readonly ok: true;
      readonly verdict: GoalEvaluatorVerdict;
      readonly reason: string;
      readonly evidence?: readonly GoalEvidence[];
      readonly usage: TokenUsage;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly usage: TokenUsage;
    };

export interface GoalEvaluatorOptions {
  /** The judge LLM. The first implementation uses the main agent's `llm`. */
  readonly llm: LLM;
}

const MAX_EVALUATOR_CONTEXT_MESSAGES = 12;

export class GoalEvaluator {
  constructor(private readonly options: GoalEvaluatorOptions) {}

  async evaluate(input: GoalEvaluatorInput): Promise<GoalEvaluatorResult> {
    const prompt = buildEvaluatorPrompt(input);
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: prompt }], toolCalls: [] },
    ];

    let text = '';
    let usage: TokenUsage = emptyUsage();
    try {
      const response = await this.options.llm.chat({
        messages,
        tools: [],
        signal: input.signal,
        onTextDelta: (delta) => {
          text += delta;
        },
      });
      usage = response.usage;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), usage };
    }

    const parsed = parseVerdict(text);
    if (parsed === undefined) {
      return { ok: false, error: `Evaluator returned invalid JSON: ${text.slice(0, 200)}`, usage };
    }
    return { ok: true, verdict: parsed.verdict, reason: parsed.reason, evidence: parsed.evidence, usage };
  }
}

function parseVerdict(
  text: string,
): { verdict: GoalEvaluatorVerdict; reason: string; evidence?: readonly GoalEvidence[] } | undefined {
  const json = extractJsonObject(text);
  if (json === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const verdict = record['verdict'];
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return undefined;
  const reason = typeof record['reason'] === 'string' ? (record['reason'] as string) : '';
  const evidence = parseEvidence(record['evidence']);
  return { verdict: verdict as GoalEvaluatorVerdict, reason, evidence };
}

function parseEvidence(value: unknown): readonly GoalEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: GoalEvidence[] = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null && typeof (item as { summary?: unknown }).summary === 'string') {
      const e = item as { summary: string; detail?: unknown; source?: unknown };
      out.push({
        summary: e.summary,
        detail: typeof e.detail === 'string' ? e.detail : undefined,
        source: typeof e.source === 'string' ? e.source : undefined,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Extract the first balanced top-level JSON object from a text blob. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function buildEvaluatorPrompt(input: GoalEvaluatorInput): string {
  const { goal } = input;
  const lines: string[] = [];
  lines.push(
    'You are an independent goal evaluator. Judge ONLY from the conversation provided. Do not run',
    'tools and do not assume work that is not evidenced in the transcript.',
  );
  lines.push('');
  lines.push(`Objective: ${goal.objective}`);
  if (goal.completionCriterion !== undefined) {
    lines.push(`Completion criterion: ${goal.completionCriterion}`);
  }
  if (input.modelReport !== undefined) {
    lines.push(
      `The working model self-reported "${input.modelReport.status}"${input.modelReport.reason ? `: ${input.modelReport.reason}` : ''}. Treat this as a claim to verify, not as truth.`,
    );
  }
  lines.push('');
  lines.push(
    `Progress so far: ${goal.turnsUsed} continuation turn(s), ${formatElapsed(goal.wallClockMs)} elapsed, ${goal.tokensUsed} tokens used.`,
  );
  const configured = formatConfiguredBudgets(goal);
  if (configured !== undefined) {
    lines.push(`Configured hard budgets: ${configured}.`);
  }
  lines.push('');
  lines.push('Recent conversation (most recent last):');
  lines.push(summarizeMessages(input.messages));
  lines.push('');
  lines.push('Decide:');
  lines.push('- Has the completion criterion been met, with required validation evidence present?');
  lines.push(
    '- Has any stop condition stated in the objective (e.g. a turn, time, or token limit) been reached, given the progress above? If so, return "complete".',
  );
  lines.push(
    '- Is the goal blocked — by user input, an external condition, or because the objective is impossible/contradictory as stated? Either way, return "blocked" with a short reason.',
  );
  lines.push('- Did the last step make meaningful progress?');
  lines.push('- Is another continuation likely to help?');
  lines.push('');
  lines.push(
    'Respond with STRICT JSON only, no prose, in this shape:',
    '{"verdict":"continue|complete|blocked|no_progress","reason":"<short reason>","evidence":[{"summary":"..."}]}',
  );
  return lines.join('\n');
}

/** Human-readable list of the goal's configured hard budgets, or undefined when none. */
function formatConfiguredBudgets(goal: GoalSnapshot): string | undefined {
  const { budget } = goal;
  const parts: string[] = [];
  if (budget.turnBudget !== null) parts.push(`turns ${goal.turnsUsed}/${budget.turnBudget}`);
  if (budget.tokenBudget !== null) parts.push(`tokens ${goal.tokensUsed}/${budget.tokenBudget}`);
  if (budget.wallClockBudgetMs !== null) {
    parts.push(`time ${formatElapsed(goal.wallClockMs)}/${formatElapsed(budget.wallClockBudgetMs)}`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

function summarizeMessages(messages: readonly Message[]): string {
  const slice = messages.slice(-MAX_EVALUATOR_CONTEXT_MESSAGES);
  return slice
    .map((message) => {
      const text = message.content
        .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
        .join('')
        .slice(0, 800);
      const tools =
        message.toolCalls && message.toolCalls.length > 0
          ? ` (tool calls: ${message.toolCalls.map((t) => t.name).join(', ')})`
          : '';
      return `[${message.role}] ${text}${tools}`;
    })
    .join('\n');
}
