/**
 * Workspace subagent model bindings — callback factory for the Agent tool.
 *
 * Bindings live in `<projectRoot>/.kimi-code/local.toml`: per-type bindings
 * under `[subagent.<type>]` and named binding slots under
 * `[subagent-slot.<name>]` (see `config/workspace-local.ts`). The Agent tool
 * uses these callbacks to (a) apply a binding mechanically on spawn and
 * (b) ask the user interactively the first time an unbound subagent type or
 * requested slot is spawned in this workspace, persisting the answer —
 * including an explicit "keep inheriting" choice so the question never
 * repeats for that type or slot.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import type { Agent } from '../index';
import type { QuestionAnswers, QuestionResult } from '../../rpc';
import {
  readSubagentBinding,
  readSubagentSlotBinding,
  writeSubagentBinding,
  writeSubagentSlotBinding,
  type SubagentBinding,
} from '../../config/workspace-local';

export type ReadSubagentBindingCallback = (
  profileName: string,
) => Promise<SubagentBinding | undefined>;

export type ReadSubagentSlotBindingCallback = (
  slot: string,
) => Promise<SubagentBinding | undefined>;

export interface AskSubagentBindingContext {
  /**
   * Set when the stored binding references a model alias that no longer
   * exists in the user's models config — the ask explains why it is
   * happening again and the new choice repairs the broken binding.
   */
  readonly missingModel?: string;
  /**
   * Set when the ask concerns a named binding slot (requested via the Agent
   * tool's `binding_slot` parameter) rather than a subagent type; the answer
   * is persisted under `[subagent-slot.<name>]`.
   */
  readonly slot?: string;
}

export type AskSubagentBindingCallback = (
  profileName: string,
  context?: AskSubagentBindingContext,
) => Promise<SubagentBinding | undefined>;

export type IsModelAliasKnownCallback = (alias: string) => boolean;

const INHERIT_LABEL = 'Keep inheriting from the main agent';

/**
 * Build the binding callbacks for the Agent tool. `askBinding` is returned
 * only when the agent can question the user interactively; in
 * non-interactive environments (e.g. print mode) spawns silently inherit.
 */
export function createSubagentBindingCallbacks(
  agent: Agent,
  kaos: Kaos,
  workDir: string,
): {
  readBinding: ReadSubagentBindingCallback;
  readSlotBinding: ReadSubagentSlotBindingCallback;
  askBinding?: AskSubagentBindingCallback;
  isModelAliasKnown: IsModelAliasKnownCallback;
} {
  const readBinding: ReadSubagentBindingCallback = (profileName) =>
    readSubagentBinding(kaos, workDir, profileName);

  const readSlotBinding: ReadSubagentSlotBindingCallback = (slot) =>
    readSubagentSlotBinding(kaos, workDir, slot);

  // Without a models config there is nothing to validate against — stay
  // silent rather than nagging about every binding.
  const isModelAliasKnown: IsModelAliasKnownCallback = (alias) => {
    const models = agent.kimiConfig?.models;
    if (models === undefined) return true;
    return alias in models;
  };

  const requestQuestion = agent.rpc?.requestQuestion?.bind(agent.rpc);
  if (requestQuestion === undefined) return { readBinding, readSlotBinding, isModelAliasKnown };

  const askBinding: AskSubagentBindingCallback = async (profileName, context) => {
    const models = agent.kimiConfig?.models ?? {};
    const aliases = Object.keys(models).toSorted();
    const missingModel = context?.missingModel;
    const slot = context?.slot;
    const subject = slot === undefined ? `Subagent type "${profileName}"` : `Binding slot "${slot}"`;
    const persist = async (binding: SubagentBinding): Promise<void> => {
      if (slot === undefined) {
        await writeSubagentBinding(kaos, workDir, profileName, binding);
      } else {
        await writeSubagentSlotBinding(kaos, workDir, slot, binding);
      }
    };
    const modelQuestion =
      missingModel === undefined
        ? `${subject} has no model binding in this workspace. Bind a model for it?`
        : `${subject} is bound to model "${missingModel}", but that alias no longer exists in your models config. Bind a model for it?`;
    const modelResult = await requestQuestion({
      questions: [
        {
          question: modelQuestion,
          header: 'Subagent',
          options: [
            {
              label: INHERIT_LABEL,
              description: 'Recorded as the choice for this workspace; you will not be asked again',
            },
            ...aliases.map((alias) => ({ label: alias })),
          ],
        },
      ],
    });
    const chosen = answerFor(modelResult, modelQuestion);
    if (chosen === undefined) return undefined; // dismissed — ask again next time
    if (chosen === INHERIT_LABEL) {
      const binding: SubagentBinding = { inherit: true };
      await persist(binding);
      return binding;
    }

    const model = chosen;
    let thinkingEffort: string | undefined;
    const supportEfforts = models[model]?.supportEfforts ?? [];
    if (supportEfforts.length > 0) {
      const effortQuestion = `Thinking effort for ${subject} on ${model}?`;
      const effortResult = await requestQuestion({
        questions: [
          {
            question: effortQuestion,
            header: 'Subagent',
            options: [
              { label: INHERIT_LABEL, description: 'Inherit the main agent thinking effort' },
              ...supportEfforts.map((effort) => ({ label: effort })),
            ],
          },
        ],
      });
      const effort = answerFor(effortResult, effortQuestion);
      if (effort !== undefined && effort !== INHERIT_LABEL) thinkingEffort = effort;
    }

    const binding: SubagentBinding = { model, thinkingEffort };
    await persist(binding);
    return binding;
  };

  return { readBinding, readSlotBinding, askBinding, isModelAliasKnown };
}

function answerFor(result: QuestionResult, question: string): string | undefined {
  if (result === null) return undefined;
  // `QuestionResult` is either a bare answers record or `{ answers }`; TS
  // cannot narrow the union via `in`, so normalize explicitly.
  const answers = ('answers' in result ? result.answers : result) as QuestionAnswers;
  const value = answers[question];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
