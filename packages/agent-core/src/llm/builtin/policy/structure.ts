import type { Message } from '#/llm/message';
import type { LlmRecovery } from '#/llm/policy/recovery';
import type { LlmNoticeSink } from '#/llm/response';

const STRUCTURE_RECOVERY_ID = 'structure';

const IGNORE_NOTICES: LlmNoticeSink = () => {};

function mergeConsecutiveAssistants(
  messages: readonly Message[],
  report: LlmNoticeSink,
): readonly Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (previous?.role === 'assistant' && message.role === 'assistant') {
      out[out.length - 1] = {
        ...previous,
        content: [...previous.content, ...message.content],
        toolCalls: [...previous.toolCalls, ...message.toolCalls],
      };
      report({ code: 'consecutive_assistants_merged', message: 'Merged consecutive assistant messages.' });
      continue;
    }
    out.push(message);
  }
  return out.length === messages.length ? messages : out;
}

function dropLeadingNonUser(
  messages: readonly Message[],
  report: LlmNoticeSink,
): readonly Message[] {
  const start = messages.findIndex((message) => message.role === 'user');
  const end = start < 0 ? messages.length : start;
  for (const message of messages.slice(0, end)) {
    report({
      code: 'leading_non_user_dropped',
      message: `Dropped a leading ${message.role} message.`,
      data: { role: message.role },
    });
  }
  return end === 0 ? messages : messages.slice(end);
}

function strictStructure(
  messages: readonly Message[],
  report: LlmNoticeSink = IGNORE_NOTICES,
): readonly Message[] {
  return dropLeadingNonUser(mergeConsecutiveAssistants(messages, report), report);
}

export const structureRecovery: LlmRecovery = {
  propose: ({ error, appliedRecoveries }) => {
    if (error.kind !== 'request_structure') return undefined;
    if (appliedRecoveries.some((record) => record.strategy === STRUCTURE_RECOVERY_ID)) {
      return undefined;
    }
    return { strategy: STRUCTURE_RECOVERY_ID, action: 'strict', rewrite: strictStructure };
  },
};
