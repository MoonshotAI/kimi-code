import type { AgentEventListener } from '../../agent';
import { errorMessage, isAbortError } from '../../loop/errors';
import type { AgentEvent, AssistantDeltaEvent, ThinkingDeltaEvent } from '../../rpc';
import {
  type BackgroundTask,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSink,
} from './task';
import type { SessionSubagentHost, SubagentHandle } from '../../session/subagent-host';

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  /** Subagent identifier accepted by Agent(resume=...). */
  readonly agentId?: string;
  /** Subagent profile name. */
  readonly subagentType?: string;
}

export class AgentBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly agentId: string;
  readonly subagentType: string;

  constructor(
    private readonly handle: SubagentHandle,
    readonly description: string,
    private readonly subagentHost: Pick<SessionSubagentHost, 'markActiveChildDetached'>,
    private readonly abortController: AbortController,
  ) {
    this.agentId = handle.agentId;
    this.subagentType = handle.profileName;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abortController.abort(sink.signal.reason);
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }

    const unsubscribe = this.handle.subscribeToEvents?.(createEventStreamer(sink));

    try {
      const outcome = await this.handle.completion;
      sink.appendOutput(outcome.result);
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    } finally {
      unsubscribe?.();
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  onDetach(): void {
    this.subagentHost.markActiveChildDetached(this.agentId);
  }

  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
    };
  }
}

const EVENT_PREVIEW_LENGTH = 200;

type TextStreamKind = 'thinking' | 'assistant';

/**
 * Build the event listener that mirrors a subagent's live activity into the
 * task output buffer. Thinking/assistant text streams verbatim so the buffer
 * reads as a transcript, with a `[thinking]` / `[assistant]` marker each time
 * the stream kind changes; structured events become one-line markers.
 */
function createEventStreamer(sink: BackgroundTaskSink): AgentEventListener {
  let lastStream: TextStreamKind | undefined;
  return (event) => {
    if (isTextDeltaEvent(event)) {
      const streamKind: TextStreamKind = event.type === 'thinking.delta' ? 'thinking' : 'assistant';
      if (lastStream !== streamKind) {
        sink.appendOutput(`\n[${streamKind}]\n`);
        lastStream = streamKind;
      }
      sink.appendOutput(event.delta);
      return;
    }
    const line = formatAgentEvent(event);
    if (line !== undefined) {
      lastStream = undefined;
      sink.appendOutput(`\n${line}\n`);
    }
  };
}

function isTextDeltaEvent(
  event: AgentEvent,
): event is ThinkingDeltaEvent | AssistantDeltaEvent {
  return event.type === 'thinking.delta' || event.type === 'assistant.delta';
}

function formatAgentEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'turn.started':
      return `[turn ${event.turnId} started]`;
    case 'turn.ended':
      return `[turn ${event.turnId} ended: ${event.reason}]${formatDetail(event.error?.message)}`;
    case 'turn.step.retrying':
      return `[retrying] step ${event.step} (attempt ${event.nextAttempt}/${event.maxAttempts}): ${event.errorMessage}`;
    case 'turn.step.interrupted':
      return `[interrupted] step ${event.step}: ${event.reason}${formatDetail(event.message)}`;
    case 'tool.call.started':
      return `[tool] ${event.name}${formatDetail(event.description ?? event.args)}`;
    case 'tool.result':
      return `[result${event.isError === true ? ' error' : ''}]${formatDetail(event.output)}`;
    case 'error':
      return `[error] ${event.message}`;
    case 'warning':
      return `[warning] ${event.message}`;
    default:
      return undefined;
  }
}

function formatDetail(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const text = (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return '';
  const preview =
    text.length > EVENT_PREVIEW_LENGTH ? `${text.slice(0, EVENT_PREVIEW_LENGTH)}…` : text;
  return `: ${preview}`;
}
