import {
  createFeature,
  useAgent,
  useSession,
  useToolStarting,
  type Feature,
} from '#/app/index';
import { createHistoryMessageBuilder } from '@moonshot-ai/agent-core/history/index';
import { createFacadeToken, useExpose, type RuntimeEvent } from '#/composition-api/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';

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

export interface BtwCreateOptions {
  readonly sourceAgentId?: string;
  readonly readonlyTools?: readonly string[];
}

export interface BtwFace {
  create(options?: BtwCreateOptions): Promise<Agent>;
  list(): readonly string[];
  isBtw(agentId: string): boolean;
}

export const BtwRef = createFacadeToken<BtwFace>('btw');

const BTW_SOURCE = 'btw';

export interface CreateBtwProps {
  readonly defaultReadonlyTools?: readonly string[];
}

export function createBtw(props: CreateBtwProps = {}): Feature<void, { session: BtwEvent }> {
  const defaultReadonlyTools: ReadonlySet<string> = new Set(
    props.defaultReadonlyTools ?? BTW_READONLY_TOOLS,
  );
  const guardOverrides = new WeakMap<Session, Map<string, ReadonlySet<string>>>();
  return createFeature<{ session: BtwEvent }>('btw', {
    session(_props, { fire }) {
      const session = useSession();
      const isBtw = (agentId: string): boolean =>
        session.roster.getState().agents[agentId]?.source === BTW_SOURCE;
      useExpose(BtwRef, {
        create: async (options = {}) => {
          const sourceAgentId = options.sourceAgentId ?? MAIN_AGENT_ID;
          const readonlyTools =
            options.readonlyTools === undefined
              ? defaultReadonlyTools
              : new Set(options.readonlyTools);
          if (session.liveAgents.get(sourceAgentId) === undefined) {
            throw new Error(
              `Cannot start a side question: source agent '${sourceAgentId}' does not exist or is not running in this session.`,
            );
          }
          const agentId = `btw-${crypto.randomUUID().slice(0, 8)}`;
          const { agent: child } = await session.forkAgent(sourceAgentId, agentId, {
            init: { source: BTW_SOURCE },
          });
          let overrides = guardOverrides.get(session);
          if (overrides === undefined) {
            overrides = new Map();
            guardOverrides.set(session, overrides);
          }
          overrides.set(agentId, readonlyTools);
          const reminder = sideQuestionReminder([...readonlyTools]);
          child.loop.remind({
            message: createHistoryMessageBuilder().systemReminder(reminder).userMessage(),
            meta: { key: BTW_REMIND_KEY },
          });
          fire({ type: 'btw.created', agentId, sourceId: sourceAgentId });
          return child;
        },
        list: () => Object.keys(session.roster.getState().agents).filter(isBtw),
        isBtw,
      });
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      useToolStarting(({ toolCall }) => {
        if (agent.source !== BTW_SOURCE) return undefined;
        const readonlyTools = guardOverrides.get(session)?.get(agent.id) ?? defaultReadonlyTools;
        if (readonlyTools.has(toolCall.name)) return undefined;
        const deniedMessage = toolDeniedMessage([...readonlyTools]);
        return {
          blocked: { reason: 'denied', message: deniedMessage },
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
