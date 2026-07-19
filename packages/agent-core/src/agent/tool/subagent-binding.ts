/**
 * Workspace subagent model bindings — callback factory for the Agent tool.
 *
 * Bindings live in `<projectRoot>/.kimi-code/local.toml` under
 * `[subagent.<type>]` (see `config/workspace-local.ts`). The Agent tool uses
 * these callbacks to (a) apply a binding mechanically on spawn and (b) ask
 * the user interactively the first time an unbound subagent type is spawned
 * in this workspace, persisting the answer — including an explicit "keep
 * inheriting" choice so the question never repeats for that type.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import type { Agent } from '../index';
import type { QuestionAnswers, QuestionResult } from '../../rpc';
import {
  readSubagentBinding,
  writeSubagentBinding,
  type SubagentBinding,
} from '../../config/workspace-local';

export type ReadSubagentBindingCallback = (
  profileName: string,
) => Promise<SubagentBinding | undefined>;

export type AskSubagentBindingCallback = (
  profileName: string,
) => Promise<SubagentBinding | undefined>;

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
  askBinding?: AskSubagentBindingCallback;
} {
  const readBinding: ReadSubagentBindingCallback = (profileName) =>
    readSubagentBinding(kaos, workDir, profileName);

  const requestQuestion = agent.rpc?.requestQuestion?.bind(agent.rpc);
  if (requestQuestion === undefined) return { readBinding };

  const askBinding: AskSubagentBindingCallback = async (profileName) => {
    const models = agent.kimiConfig?.models ?? {};
    const aliases = Object.keys(models).toSorted();
    const modelQuestion = `Subagent type "${profileName}" has no model binding in this workspace. Bind a model for it?`;
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
      await writeSubagentBinding(kaos, workDir, profileName, binding);
      return binding;
    }

    const model = chosen;
    let thinkingEffort: string | undefined;
    const supportEfforts = models[model]?.supportEfforts ?? [];
    if (supportEfforts.length > 0) {
      const effortQuestion = `Thinking effort for subagent type "${profileName}" on ${model}?`;
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
    await writeSubagentBinding(kaos, workDir, profileName, binding);
    return binding;
  };

  return { readBinding, askBinding };
}

function answerFor(result: QuestionResult, question: string): string | undefined {
  if (result === null) return undefined;
  // `QuestionResult` is either a bare answers record or `{ answers }`; TS
  // cannot narrow the union via `in`, so normalize explicitly.
  const answers = ('answers' in result ? result.answers : result) as QuestionAnswers;
  const value = answers[question];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
