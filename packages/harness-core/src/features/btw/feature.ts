import { randomUUID } from 'node:crypto';

import {
  createFeature,
  createHistoryMessageBuilder,
  MAIN_AGENT_ID,
  useAgent,
  useBeforeTool,
  useSession,
  useSessionStore,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  useExpose,
  useFire,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';

export const BTW_REMIND_KEY = 'btw.side_question';

export const BTW_READONLY_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'WaitFor'];

export const SIDE_QUESTION_SYSTEM_REMINDER = sideQuestionReminder(BTW_READONLY_TOOLS);

export const BTW_TOOL_DENIED_MESSAGE = toolDeniedMessage(BTW_READONLY_TOOLS);

export interface BtwCreatedEvent extends RuntimeEvent {
  readonly type: 'btw.created';
  readonly agentId: string;
  readonly sourceId: string;
}

export type BtwEvent = BtwCreatedEvent;

export interface BtwFace {
  ask(): Promise<{ agentId: string }>;
  list(): readonly string[];
  isBtw(agentId: string): boolean;
}

export const BtwRef = createToken<BtwFace>('btw');

const BTW_SOURCE = 'btw';

export interface CreateBtwProps {
  readonly sourceAgentId?: string;
  readonly readonlyTools?: readonly string[];
}

export function createBtw(props: CreateBtwProps = {}): FeatureSpec<BtwEvent> {
  const sourceAgentId = props.sourceAgentId ?? MAIN_AGENT_ID;
  const readonlyTools = new Set(props.readonlyTools ?? BTW_READONLY_TOOLS);
  const reminder = sideQuestionReminder([...readonlyTools]);
  const deniedMessage = toolDeniedMessage([...readonlyTools]);
  return createFeature<BtwEvent>('btw', {
    session() {
      const session = useSession();
      const store = useSessionStore();
      const fire = useFire();
      const isBtw = (agentId: string): boolean =>
        store.getState().roster.agents[agentId]?.source === BTW_SOURCE;
      useExpose(BtwRef, {
        ask: async () => {
          if (session.get(sourceAgentId) === undefined) {
            throw new Error(
              `Cannot start a side question: source agent '${sourceAgentId}' does not exist or is not running in this session.`,
            );
          }
          const agentId = `btw-${randomUUID().slice(0, 8)}`;
          const child = await session.fork(sourceAgentId, { agentId, source: BTW_SOURCE });
          child.remind(
            BTW_REMIND_KEY,
            createHistoryMessageBuilder().systemReminder(reminder).userMessage(),
          );
          fire({ type: 'btw.created', agentId, sourceId: sourceAgentId });
          return { agentId };
        },
        list: () => Object.keys(store.getState().roster.agents).filter(isBtw),
        isBtw,
      });
    },
    agent() {
      const store = useSessionStore();
      const agent = useAgent();
      useBeforeTool(({ toolCall }) => {
        if (store.getState().roster.agents[agent.agentId]?.source !== BTW_SOURCE) return undefined;
        if (readonlyTools.has(toolCall.name)) return undefined;
        return {
          type: 'denied',
          result: { content: [{ type: 'text', text: deniedMessage }] },
        };
      });
    },
  });
}

function sideQuestionReminder(readonlyTools: readonly string[]): string {
  const tools = readonlyTools.join(', ');
  return `
This is a side-channel conversation with the user. You should answer user questions directly.

IMPORTANT:
- You are a separate, lightweight instance forked from the main agent. The conversation above is a snapshot inherited from it, not your own history; do not continue the original task.
- The main agent continues independently; do not reference being interrupted.
- You may use the read-only tools ${tools} to inspect files when the answer depends on current file contents. All other tools are disabled and will be rejected, even though their definitions are visible in this request (they exist only for technical reasons — prompt cache).
- Prefer answering from what you already know from the conversation and this side-channel conversation; reach for the read-only tools only when needed.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`.trim();
}

function toolDeniedMessage(readonlyTools: readonly string[]): string {
  return `Only the read-only tools ${readonlyTools.join(', ')} are available for side questions. Other tool calls are disabled.`;
}
