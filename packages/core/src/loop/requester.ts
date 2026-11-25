import type { Message } from '#/llm/message';
import type { LlmPolicy } from '#/llm/policy/policy';
import { contentsOf, mergeFields, requesterContents, type LlmRequestPart } from '#/llm/requester';
import type { LlmOutcome } from '#/llm/response';
import type { LoopProfile } from './contract/profile';
import {
  normalizeLlmOutcome,
  outcomeForError,
  requestProfileOf,
  type FullLoopLlmRequester,
  type LoopLlmRunObservation,
  type LoopLlmRunObserver,
} from './request';

type Fields = Readonly<Record<string, unknown>>;

async function generateObserved(
  resolved: FullLoopLlmRequester,
  observation: LoopLlmRunObservation | undefined,
  control: Parameters<FullLoopLlmRequester['generate']>[1],
): Promise<LlmOutcome> {
  let outcome: LlmOutcome;
  try {
    outcome = normalizeLlmOutcome(await resolved.generate(
      {},
      {
        ...control,
        onAttempt: (attemptRequest, info) => {
          observation?.attempt?.(attemptRequest, info);
          control.onAttempt?.(attemptRequest, info);
        },
        onEvent: (event) => {
          observation?.event?.(event);
          control.onEvent?.(event);
        },
      },
    ));
  } catch (error) {
    observation?.settle?.(outcomeForError(control.signal, error), control.signal);
    throw error;
  }
  observation?.settle?.(outcome, control.signal);
  return outcome;
}

export function createRawLoopRequester(
  requester: () => FullLoopLlmRequester,
  messages: () => readonly Message[],
  profile: () => LoopProfile,
  policy: () => LlmPolicy,
  observe?: () => LoopLlmRunObserver | undefined,
): FullLoopLlmRequester {
  const accumulate = (part: LlmRequestPart): FullLoopLlmRequester => {
    const resolve = (): FullLoopLlmRequester => requester().with({
      content: { messages: messages() },
      profile: requestProfileOf(profile()),
      policy: policy(),
    }).with(part);
    return {
      [requesterContents]: part,
      with: ((next: LlmRequestPart | FullLoopLlmRequester) =>
        accumulate(mergeFields(part as Fields, contentsOf(next) as Fields) as LlmRequestPart)) as FullLoopLlmRequester['with'],
      request: (rest) => resolve().request(rest),
      generate: (rest, control) => {
        const resolved = resolve().with(rest);
        const observer = observe?.();
        if (observer?.start === undefined) return resolved.generate({}, control);
        let observation: LoopLlmRunObservation | undefined;
        try {
          observation = observer.start(resolved.request({}));
        } catch (error) {
          return (async () => {
            throw error;
          })();
        }
        return generateObserved(resolved, observation, control);
      },
    };
  };
  return accumulate({});
}
