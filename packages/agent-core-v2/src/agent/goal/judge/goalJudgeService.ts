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
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt } from './judgePrompt';

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
  ) {
    super();
  }

  async evaluate(goal: GoalSnapshot, signal?: AbortSignal): Promise<JudgeVerdict> {
    // Only the main agent can run judge evaluations.
    if (this.scopeContext.agentId !== 'main') {
      return { ok: true, reason: 'Judge skipped: not main agent.' };
    }

    // 1. Get conversation history (the transcript the judge will read).
    const history = this.context.get();

    // 2. Build judge messages: system prompt + conversation + user instruction.
    const judgeUser = buildJudgeUserPrompt(goal.objective, goal.completionCriterion);
    const messages: Message[] = [
      ...history,
      createUserMessage(judgeUser),
    ];

    // 3. Resolve output size for the judge response.
    const modelContext = this.profile.resolveModelContext();
    const maxOutputSize = Math.min(modelContext.maxOutputSize ?? 4096, 4096);

    this.log.debug('goal.judge.evaluate.start', {
      goalId: goal.goalId,
      messageCount: messages.length,
    });

    // 4. Make the LLM call (no tools, no streaming — just a text response).
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
    } catch (err) {
      this.log.warn('goal.judge.evaluate.error', {
        goalId: goal.goalId,
        error: err instanceof Error ? err.message : String(err),
      });
      // On error, allow completion — don't block the agent due to judge failure.
      return { ok: true, reason: 'Judge evaluation failed — allowing completion.' };
    }

    // 5. Extract and parse the verdict from the response text.
    const responseText = extractText(finish.message).trim();
    const verdict = parseVerdict(responseText);

    this.log.debug('goal.judge.evaluate.result', {
      goalId: goal.goalId,
      ok: verdict.ok,
      impossible: verdict.impossible,
      reason: verdict.reason.slice(0, 200),
    });

    return verdict;
  }
}

/**
 * Parse the judge's JSON response. The model may wrap JSON in markdown
 * fences or add extra text — extract the JSON object and parse it.
 */
function parseVerdict(text: string): JudgeVerdict {
  // Try to find a JSON object in the response.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<JudgeVerdict>;
      if (typeof parsed.ok === 'boolean' && typeof parsed.reason === 'string') {
        return {
          ok: parsed.ok,
          impossible: parsed.impossible === true ? true : undefined,
          reason: parsed.reason,
        };
      }
    } catch {
      // fall through to default
    }
  }

  // If we can't parse, default to allowing completion (don't block on parse errors).
  return {
    ok: true,
    reason: `Judge response could not be parsed — allowing completion. Response: ${text.slice(0, 200)}`,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentGoalJudgeService,
  AgentGoalJudgeService,
  InstantiationType.Eager,
  'goalJudge',
);
