/**
 * `streamLlmRequest`: exposes a request's `LlmRunEvent`s as an `AsyncIterable` that ends after `llm.ended`.
 */
import { runLlmRequest, type LlmRunControl } from '#/llm/policy/policy';
import type { LlmRequest } from '#/llm/request';
import type { LlmRunEvent } from '#/llm/response';
import { AsyncEventQueue } from '#/utils/async-event-queue';

export function streamLlmRequest(
  request: LlmRequest,
  control: LlmRunControl,
): AsyncIterable<LlmRunEvent> {
  const events = new AsyncEventQueue<LlmRunEvent>();
  void runLlmRequest(request, {
    ...control,
    onEvent: (event) => {
      events.push(event);
      control.onEvent?.(event);
    },
  }).then(
    () => events.end(),
    (error) => events.fail(error),
  );
  return events;
}

