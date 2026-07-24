/**
 * Goal Judge — independent model evaluation of goal completion.
 *
 * When the agent calls `UpdateGoal('complete')`, this service sends the
 * conversation transcript to the model with a verdict schema. The judge
 * independently confirms whether the goal's completion criterion is satisfied
 * — it must not defer to the agent's self-assessment.
 *
 * Ported from MiMo-Code's `session/goal.ts` judge evaluation, adapted to
 * kimi-code's `IAgentLLMRequesterService` pattern.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { createDecorator } from '#/_base/di/instantiation';
import { IAgentLLMRequesterService, type LLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ILogService } from '#/_base/log/log';
import type { Message } from '#/app/llmProtocol/message';
import { createUserMessage, extractText } from '#/app/llmProtocol/message';
import type { GoalSnapshot } from '#/agent/goal/types';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt, buildJudgeVerificationPrompt } from './judgePrompt';
import { GOAL_JUDGE_PROFILE_NAME } from './judgeAgentProfile';

/** Timeout for the judge subagent run (ms). */
const JUDGE_SUBAGENT_TIMEOUT_MS = 60_000;

/** Simplified retry prompt when the first response could not be parsed. */
const RETRY_SYSTEM_PROMPT = `You are a judge. Return ONLY a JSON object with fields "ok" (boolean) and "reason" (string). No other text.`;

export interface JudgeVerdict {
  readonly ok: boolean;
  readonly impossible?: boolean;
  readonly reason: string;
}

export interface IAgentGoalJudgeService {
  readonly _serviceBrand: undefined;
  evaluate(goal: GoalSnapshot, signal?: AbortSignal): Promise<JudgeVerdict>;
}

export const IAgentGoalJudgeService = createDecorator<IAgentGoalJudgeService>(
  'agentGoalJudgeService',
);

export class AgentGoalJudgeService extends Disposable implements IAgentGoalJudgeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ILogService private readonly log: ILogService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
  }

  async evaluate(goal: GoalSnapshot, signal?: AbortSignal): Promise<JudgeVerdict> {
    // Only the main agent can run judge evaluations.
    if (this.scopeContext.agentId !== 'main') {
      return { ok: true, reason: 'Judge skipped: not main agent.' };
    }

    // Primary path: launch a judge subagent with tool access for independent verification.
    const subagentVerdict = await this.evaluateViaSubagent(goal, signal);
    if (subagentVerdict !== undefined) {
      return subagentVerdict;
    }

    // Fallback: transcript-based LLM evaluation (when subagent is unavailable).
    return this.evaluateFromTranscript(goal, signal);
  }

  /**
   * Launch a judge subagent that independently verifies the goal by executing
   * commands. Returns `undefined` if the subagent path fails (caller falls back).
   */
  private async evaluateViaSubagent(
    goal: GoalSnapshot,
    signal?: AbortSignal,
  ): Promise<JudgeVerdict | undefined> {
    const prompt = buildJudgeVerificationPrompt(
      goal.objective,
      goal.completionCriterion,
      this.sessionContext.cwd,
    );

    this.log.debug('goal.judge.subagent.start', { goalId: goal.goalId });

    try {
      // Create an abort controller that races the provided signal with a timeout.
      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(new Error('Judge subagent timed out')),
        JUDGE_SUBAGENT_TIMEOUT_MS,
      );

      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const handle = await this.subagents.run(
          GOAL_JUDGE_PROFILE_NAME,
          { kind: 'prompt', prompt },
          { signal: combinedSignal },
        );

        const { summary } = await handle.completion;
        clearTimeout(timeout);

        // Parse verdict from the subagent's distilled summary.
        const verdict = parseVerdict(summary);
        if (verdict !== undefined) {
          this.log.debug('goal.judge.subagent.result', {
            goalId: goal.goalId,
            ok: verdict.ok,
            reason: verdict.reason.slice(0, 200),
          });
          return verdict;
        }

        // Subagent ran but output was not parseable — log and fall through.
        this.log.warn('goal.judge.subagent.unparseable', {
          goalId: goal.goalId,
          summaryPreview: summary.slice(0, 200),
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.log.warn('goal.judge.subagent.failed', {
        goalId: goal.goalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return undefined;
  }

  /**
   * Fallback: evaluate goal completion by asking an LLM to judge the transcript.
   * Used when the subagent path is unavailable or fails.
   */
  private async evaluateFromTranscript(
    goal: GoalSnapshot,
    signal?: AbortSignal,
  ): Promise<JudgeVerdict> {
    const history = this.context.get();
    const judgeUser = buildJudgeUserPrompt(goal.objective, goal.completionCriterion);
    const messages: Message[] = [
      ...history,
      createUserMessage(judgeUser),
    ];

    const modelContext = this.profile.resolveModelContext();
    const maxOutputSize = Math.min(modelContext.maxOutputSize ?? 4096, 4096);

    this.log.debug('goal.judge.transcript.start', {
      goalId: goal.goalId,
      messageCount: messages.length,
    });

    let finish: LLMRequestFinish;
    try {
      finish = await this.llmRequester.request(
        {
          messages,
          tools: [],
          systemPrompt: JUDGE_SYSTEM_PROMPT,
          maxOutputSize,
          source: {
            type: 'operation',
            requestKind: 'goal_judge',
          },
        },
        undefined,
        signal,
      );
    } catch (error) {
      this.log.warn('goal.judge.transcript.error', {
        goalId: goal.goalId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: true, reason: 'Judge evaluation failed (network/timeout) \u2014 allowing completion.' };
    }

    const responseText = extractText(finish.message).trim();
    const verdict = parseVerdict(responseText);

    if (verdict !== undefined) {
      this.log.debug('goal.judge.transcript.result', {
        goalId: goal.goalId,
        ok: verdict.ok,
        reason: verdict.reason.slice(0, 200),
      });
      return verdict;
    }

    // Parse failed \u2014 retry once with simplified prompt.
    this.log.warn('goal.judge.transcript.parseFailed', {
      goalId: goal.goalId,
      responsePreview: responseText.slice(0, 200),
    });

    try {
      const retryUserPrompt =
        `The goal objective is: ${goal.objective}\n` +
        (goal.completionCriterion ? `Completion criterion: ${goal.completionCriterion}\n` : '') +
        'Based on the conversation transcript above, is this goal complete? Return ONLY {"ok": true/false, "reason": "..."}';
      const retryFinish = await this.llmRequester.request(
        {
          messages: [
            ...history,
            createUserMessage(retryUserPrompt),
          ],
          tools: [],
          systemPrompt: RETRY_SYSTEM_PROMPT,
          maxOutputSize: 512,
          source: {
            type: 'operation',
            requestKind: 'goal_judge_retry',
          },
        },
        undefined,
        signal,
      );
      const retryText = extractText(retryFinish.message).trim();
      const retryVerdict = parseVerdict(retryText);
      if (retryVerdict !== undefined) return retryVerdict;
    } catch {
      // Retry also failed.
    }

    // Both attempts failed \u2014 allow to avoid blocking.
    this.log.warn('goal.judge.transcript.retryFailed', { goalId: goal.goalId });
    return {
      ok: true,
      reason: `Judge response could not be parsed after retry \u2014 allowing completion. Response: ${responseText.slice(0, 200)}`,
    };
  }
}

/**
 * Parse the judge's JSON response. Returns `undefined` when parsing fails
 * (caller should retry or fall back).
 *
 * Strategy:
 * 1. Try direct JSON.parse on the trimmed text.
 * 2. Try extracting JSON from a markdown code fence.
 * 3. Try the last `{...}` block (non-greedy per-object scan).
 */
function parseVerdict(text: string): JudgeVerdict | undefined {
  // Strategy 1: direct parse (ideal — model returned pure JSON).
  const directResult = tryParseVerdictJson(text);
  if (directResult !== undefined) return directResult;

  // Strategy 2: extract from markdown code fence ```json ... ```.
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const fenceResult = tryParseVerdictJson(fenceMatch[1]!.trim());
    if (fenceResult !== undefined) return fenceResult;
  }

  // Strategy 3: find JSON-like substrings by scanning for balanced braces.
  // Walk backwards through all top-level `{` positions — the last valid JSON
  // is most likely the verdict when the model adds commentary before it.
  const candidates = extractJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const result = tryParseVerdictJson(candidates[i]!);
    if (result !== undefined) return result;
  }

  // All strategies failed.
  return undefined;
}

/**
 * Extract candidate JSON substrings by scanning for balanced braces.
 * Handles nested `{}` correctly (e.g. reason fields containing braces).
 */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function tryParseVerdictJson(raw: string): JudgeVerdict | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<JudgeVerdict>;
    if (typeof parsed.ok === 'boolean' && typeof parsed.reason === 'string') {
      // Reject contradictory verdicts: impossible must imply not-ok.
      const impossible = parsed.impossible === true;
      return {
        ok: impossible ? false : parsed.ok,
        impossible: impossible ? true : undefined,
        reason: parsed.reason,
      };
    }
  } catch {
    // not valid JSON
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentGoalJudgeService,
  AgentGoalJudgeService,
  InstantiationType.Eager,
  'goalJudge',
);
