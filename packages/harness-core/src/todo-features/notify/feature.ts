import { createFeature, useAgent, useStepStarting, useSystemPrompt, type Feature, useAgentTools } from '#/app/index';
import {
  createHistoryMessageBuilder,
  createUserEntry,
} from '@moonshot-ai/agent-core/history/index';
import type { RuntimeEvent } from '#/composition-api/index';

import {
  lastMidResponsePosition,
  lastReminderPosition,
  renderMidResponseHint,
  renderNotifyUserNudge,
  shouldNudgeMidResponse,
  shouldNudgeNotifyUser,
  toolCallsSinceLastNotify,
  toolCallsSincePosition,
} from './nudge';
import { createNotifyUserTool } from './tool';

export interface NotifyShownEvent extends RuntimeEvent {
  readonly type: 'notify.shown';
  readonly message: string;
}

export type NotifyEvent = NotifyShownEvent;

export const NOTIFY_USER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER';

export const NOTIFY_REMIND_KEY = 'notify_user_nudge';

export const NOTIFY_USER_GUIDANCE =
  'When `NotifyUser` is available, use it proactively to keep the end user informed while you work. For a multi-step task, send an early update describing your approach, then report meaningful findings, phase conclusions, long waits, and blockers. Keep each update to one or two sentences in the end user\'s language; avoid repeating unchanged status. The UI adds the source label automatically. If you are working as a subagent, report only your own subtask\'s progress, do not present its completion as completion of the whole task, and do not ask the end user questions or request decisions. Updates do not automatically reach your parent agent: include every important finding in your final handoff. Updates remain visible until the main agent starts its next turn, so your final reply must still stand on its own.';

const _EXPERIMENTAL_NOTIFY_USER = false;

export interface CreateNotifyProps {
  readonly available?: () => boolean;
  readonly EXPERIMENTAL_NOTIFY_USER?: boolean;
}

export function createNotify(props: CreateNotifyProps = {}): Feature<void, { agent: NotifyEvent }> {
  const available =
    props.available ?? (() => props.EXPERIMENTAL_NOTIFY_USER ?? _EXPERIMENTAL_NOTIFY_USER);
  return createFeature<{ agent: NotifyEvent }>('notify', {
    agent(_props, { fire }) {
      if (!available()) return;
      const agent = useAgent();
      useAgentTools(createNotifyUserTool({ available, fire }));
      useSystemPrompt({ id: 'notify', text: NOTIFY_USER_GUIDANCE });
      useStepStarting(
        ({ messages }) => {
          if (!available()) return;
          const injectedAt = lastReminderPosition(messages, NOTIFY_REMIND_KEY);
          const streak = toolCallsSinceLastNotify(messages);
          const callsSinceLastNudge =
            injectedAt === null ? null : toolCallsSincePosition(messages, injectedAt);
          const text = shouldNudgeNotifyUser(streak, callsSinceLastNudge)
            ? renderNotifyUserNudge(streak)
            : shouldNudgeMidResponse(lastMidResponsePosition(messages), injectedAt)
              ? renderMidResponseHint()
              : undefined;
          if (text === undefined) return;
          const entry = createUserEntry(
            createHistoryMessageBuilder().systemReminder(text).userMessage(),
            { source: 'reminder', key: NOTIFY_REMIND_KEY },
          );
          queueMicrotask(() => {
            agent.loop.remind(entry);
          });
        },
        { id: 'notify.nudge' },
      );
    },
  });
}
