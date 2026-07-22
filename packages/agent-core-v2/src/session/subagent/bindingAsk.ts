/**
 * `subagent` domain (L6) — interactive ask-once binding creation.
 *
 * The factory behind the `ask` callback of `bindingResolution`, used only by
 * the `Agent` tool spawn path (the swarm path never asks). The first spawn
 * of an unbound subagent type or named slot — or a stored binding that
 * references a model alias absent from or unresolvable in the catalog —
 * asks the user once through `ISessionQuestionService` (routed to the asking
 * agent's surfaces, never `main`) and persists the answer to
 * `.kimi-code/local.toml` (`[subagent.<type>]` / `[subagent-slot.<name>]`),
 * including an explicit "keep inheriting" choice so the question never
 * repeats for that type or slot. A model whose catalog entry declares
 * `support_efforts` is followed up by a thinking-effort question. Every
 * failure mode — dismissal, a non-interactive client
 * (`CoreErrors.codes.NOT_IMPLEMENTED`), or any other question error —
 * resolves to `undefined` so the spawn silently inherits and is never
 * blocked; only abort errors propagate. Model options are projected from
 * `IModelCatalog.listModels`; an empty catalog skips the ask entirely.
 */

import { isAbortError } from '#/_base/utils/abort';
import {
  type IWorkspaceLocalConfigService,
  type SubagentBinding,
} from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { type IModelCatalog } from '#/kosong/model/catalog';
import {
  type ISessionQuestionService,
  type QuestionAnswers,
  type QuestionOption,
  type QuestionResponse,
  type QuestionResult,
} from '#/session/question/question';

import { type AskSubagentSpawnBindingCallback } from './bindingResolution';

const INHERIT_LABEL = 'Keep inheriting from the main agent';

let bindingAskSeq = 0;

export interface SubagentBindingAskerDeps {
  readonly question: ISessionQuestionService;
  readonly workspaceLocalConfig: IWorkspaceLocalConfigService;
  readonly modelCatalog: IModelCatalog;
  readonly workDir: string;
  readonly agentId: string;
  readonly signal?: AbortSignal;
}

export function createSubagentBindingAsker(
  deps: SubagentBindingAskerDeps,
): AskSubagentSpawnBindingCallback {
  return async (profileName, context) => {
    const models = await deps.modelCatalog.listModels();
    if (models.length === 0) return undefined;

    const missingModel = context?.missingModel;
    const slot = context?.slot;
    const subject = slot === undefined ? `Subagent type "${profileName}"` : `Binding slot "${slot}"`;
    const modelQuestion =
      missingModel === undefined
        ? `${subject} has no model binding in this workspace. Bind a model for it?`
        : `${subject} is bound to model "${missingModel}", but that alias no longer exists in your models config or cannot be resolved. Bind a model for it?`;
    const chosen = await askOne(deps, {
      question: modelQuestion,
      options: [
        {
          label: INHERIT_LABEL,
          description: 'Recorded as the choice for this workspace; you will not be asked again',
        },
        ...models.map((model) => ({ label: model.model })),
      ],
    });
    if (chosen === undefined) return undefined;

    const persist = async (binding: SubagentBinding): Promise<void> => {
      if (slot === undefined) {
        await deps.workspaceLocalConfig.writeSubagentBinding(deps.workDir, profileName, binding);
      } else {
        await deps.workspaceLocalConfig.writeSubagentSlotBinding(deps.workDir, slot, binding);
      }
    };
    if (chosen === INHERIT_LABEL) {
      const binding: SubagentBinding = { inherit: true };
      await persist(binding);
      return binding;
    }

    const model = chosen;
    let thinkingEffort: string | undefined;
    const supportEfforts = models.find((item) => item.model === model)?.support_efforts ?? [];
    if (supportEfforts.length > 0) {
      const effortQuestion = `Thinking effort for ${subject} on ${model}?`;
      const effort = await askOne(deps, {
        question: effortQuestion,
        options: [
          { label: INHERIT_LABEL, description: 'Inherit the main agent thinking effort' },
          ...supportEfforts.map((value) => ({ label: value })),
        ],
      });
      if (effort !== undefined && effort !== INHERIT_LABEL) thinkingEffort = effort;
    }

    const binding: SubagentBinding = { model, thinkingEffort };
    await persist(binding);
    return binding;
  };
}

interface BindingQuestion {
  readonly question: string;
  readonly options: readonly QuestionOption[];
}

async function askOne(
  deps: SubagentBindingAskerDeps,
  item: BindingQuestion,
): Promise<string | undefined> {
  let result: QuestionResult;
  try {
    result = await deps.question.request(
      {
        id: `subagent-binding:${deps.agentId}:${String(++bindingAskSeq)}`,
        questions: [{ question: item.question, header: 'Subagent', options: item.options }],
      },
      { agentId: deps.agentId, signal: deps.signal },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
  const signal = deps.signal;
  if (signal?.aborted === true) signal.throwIfAborted();
  return answerFor(result, item.question);
}

function answerFor(result: QuestionResult, question: string): string | undefined {
  const answers = normalizeAnswers(result);
  if (answers === undefined) return undefined;
  const value = answers[question];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeAnswers(result: QuestionResult): QuestionAnswers | undefined {
  if (result === null) return undefined;
  if (isQuestionResponse(result)) return result.answers;
  return result;
}

function isQuestionResponse(result: Exclude<QuestionResult, null>): result is QuestionResponse {
  if (typeof result !== 'object') return false;
  if (!Object.hasOwn(result, 'answers')) return false;
  const answers = (result as { readonly answers?: unknown }).answers;
  return typeof answers === 'object' && answers !== null && !Array.isArray(answers);
}
